import Observation

/// Ticket #61: per-Project Timeline snapshot from the Local API only (no SSE
/// yet — ticket #62). Keyed by projectId, like `ProjectConfigurationModel`,
/// so switching Projects can never show a previous Project's rows: a Project
/// not yet fetched simply has no entry, never another Project's entry.
public struct ProjectTimelineState: Sendable, Equatable {
    public var events: [TimelineEvent] = []
    public var executions: [TimelineExecution] = []
    public var isLoading = false
    public var errorMessage: String?
    public var pendingCancellationIDs: Set<String> = []
    public var cancellationErrorMessages: [String: String] = [:]
}

@MainActor
@Observable
public final class ProjectTimelineModel {
    public private(set) var states: [String: ProjectTimelineState] = [:]

    /// Ticket #62: how the live connection to `/v1/stream` currently
    /// stands. Only one Timeline screen watches at a time (`watchLive`), so
    /// one property — not keyed by Project like `states` — is enough.
    public private(set) var connectionState: TimelineConnectionState = .reconnecting

    /// Test seam: a fake fetch, so cancellation and race behavior can be
    /// asserted without a running engine (mirrors
    /// `ProjectConfigurationModel.ValidationReportProvider`).
    typealias TimelineProvider = @Sendable (String) async throws -> (
        events: [TimelineEvent], executions: [TimelineExecution]
    )

    /// Ticket #62 test seam, alongside `TimelineProvider`: a fresh connection
    /// to the live channel each time `watchLive` (re)connects, so gap
    /// detection, reset-and-reload and connection-state reporting can be
    /// asserted with simulated message sequences and no running engine.
    typealias StreamConnector = @Sendable () async throws -> AsyncThrowingStream<
        TimelineStreamMessage, Error
    >

    typealias CancellationProvider = @Sendable (String) async throws -> TimelineExecution

    private let session: EngineSessionModel
    private let provider: TimelineProvider?
    private let streamConnector: StreamConnector?
    private let cancellationProvider: CancellationProvider?
    /// Guards against a slow, stale request for a Project overwriting a
    /// newer one's result after the user has already moved on and back.
    private var revisions: [String: Int] = [:]
    private var activeProjectId: String?
    private var cancellationGenerations: [String: Int] = [:]

    public init(session: EngineSessionModel) {
        self.session = session
        provider = nil
        streamConnector = nil
        cancellationProvider = nil
    }

    init(
        session: EngineSessionModel, provider: TimelineProvider? = nil,
        streamConnector: StreamConnector? = nil,
        cancellationProvider: CancellationProvider? = nil
    ) {
        self.session = session
        self.provider = provider
        self.streamConnector = streamConnector
        self.cancellationProvider = cancellationProvider
    }

    public func state(for projectId: String) -> ProjectTimelineState {
        states[projectId] ?? ProjectTimelineState()
    }

    public func refresh(projectId: String) async {
        let revision = (revisions[projectId] ?? 0) + 1
        revisions[projectId] = revision
        let fetch: TimelineProvider
        if let provider {
            fetch = provider
        } else if let client = session.client {
            fetch = { projectId in
                async let events = client.listProjectEvents(projectId: projectId)
                async let executions = client.listProjectExecutions(projectId: projectId)
                return try await (events, executions)
            }
        } else {
            // Losing the Engine client is the same failed-refresh case as a
            // transport error: keep the last durable rows visible and surface
            // the unavailable-engine message beside them instead of blanking
            // a Timeline that was already loaded.
            var state = states[projectId] ?? ProjectTimelineState()
            state.isLoading = false
            state.errorMessage = Self.engineUnavailable
            states[projectId] = state
            return
        }
        states[projectId, default: ProjectTimelineState()].isLoading = true
        states[projectId]?.errorMessage = nil
        do {
            let (fetchedEvents, fetchedExecutions) = try await fetch(projectId)
            guard revisions[projectId] == revision else { return }
            states[projectId] = ProjectTimelineState(
                events: fetchedEvents, executions: fetchedExecutions, isLoading: false)
        } catch is CancellationError {
            // The user moved to another Project (or tab) mid-fetch — never an
            // engine failure. Left unrecorded so #62's rehydration never
            // reads a failure that never happened (findings-review #61-6);
            // the previous complete snapshot, if any, stays exactly as it was.
            guard revisions[projectId] == revision else { return }
            states[projectId]?.isLoading = false
        } catch {
            guard revisions[projectId] == revision else { return }
            // A failed reload must not empty the screen: a Timeline that
            // already shows rows keeps them, with the failure surfaced
            // alongside (findings-review #62-4) — the snapshot is still the
            // last durable truth, it is only possibly out of date. A first
            // load that never got anything has no rows to keep and becomes
            // the full-pane failure.
            var state = states[projectId] ?? ProjectTimelineState()
            state.isLoading = false
            state.errorMessage = Self.describe(error)
            states[projectId] = state
        }
    }

    @discardableResult
    public func cancelExecution(projectId: String, executionId: String) async -> Bool {
        guard let execution = states[projectId]?.executions.first(where: { $0.id == executionId }),
            execution.status == .running,
            states[projectId]?.pendingCancellationIDs.contains(executionId) != true
        else { return false }

        let provider: CancellationProvider
        if let cancellationProvider {
            provider = cancellationProvider
        } else if let client = session.client {
            provider = { try await client.cancelExecution(executionId: $0) }
        } else {
            setCancellationError(Self.engineUnavailable, projectId: projectId, executionId: executionId)
            return false
        }

        let generation = cancellationGenerations[projectId, default: 0]
        var state = states[projectId] ?? ProjectTimelineState()
        state.pendingCancellationIDs.insert(executionId)
        state.cancellationErrorMessages.removeValue(forKey: executionId)
        states[projectId] = state

        do {
            // The stream remains the only source of the displayed status. The
            // response is deliberately ignored: it is an acknowledgement,
            // not a second Timeline write.
            _ = try await provider(executionId)
            return true
        } catch is CancellationError {
            guard canUpdateCancellation(projectId: projectId, generation: generation) else {
                return false
            }
            states[projectId]?.pendingCancellationIDs.remove(executionId)
            return false
        } catch {
            guard canUpdateCancellation(projectId: projectId, generation: generation) else {
                return false
            }
            states[projectId]?.pendingCancellationIDs.remove(executionId)
            states[projectId]?.cancellationErrorMessages[executionId] =
                Self.describeCancellation(error)
            return false
        }
    }

    /// Ticket #62: fetches the initial snapshot, then subscribes to the
    /// Engine's live channel and applies updates for `projectId` as they
    /// arrive. Runs until its Task is cancelled (SwiftUI's `.task(id:)`
    /// cancels it on Project switch or when the screen disappears), closing
    /// the connection and leaving no retained connection or background work
    /// (`EngineEventStream.connect`'s `onTermination`).
    ///
    /// A dropped connection, a detected sequence gap and a new Engine
    /// Session each discard whatever was accumulated incrementally and
    /// reload the snapshot from `refresh` — the exact same REST call the
    /// initial load and the manual "Refresh Timeline" action use, so the
    /// result can never duplicate a row or show one the durable API would
    /// not also return.
    public func watchLive(projectId: String, reconnectDelay: Duration = .seconds(1)) async {
        selectProject(projectId)
        // Never begin from a stale state: a Project switch cancels the
        // previous watch without resetting `connectionState` (cancellation is
        // not a state change), so this one must claim ".reconnecting" up
        // front — the badge has to read "Reconnecting…" until this watch's
        // connection is actually up, whatever the previous watch left behind
        // (findings-review #62-6).
        setConnectionState(.reconnecting)
        // The initial durable snapshot, unconditional: a Timeline that cannot
        // go live still shows correct durable content from the last snapshot
        // (acceptance criterion — `connectorError` never reaches the stream).
        await refresh(projectId: projectId)
        guard let connector = resolvedConnector() else {
            setConnectionState(.failed)
            return
        }

        var lastSequence: Int?
        var lastSessionId: String?

        while !Task.isCancelled {
            setConnectionState(.reconnecting)
            let stream: AsyncThrowingStream<TimelineStreamMessage, Error>
            do {
                stream = try await connector()
            } catch {
                // A cancelled watch (a Project switch) must not report its
                // failure over the incoming watch's state: the cancellation
                // check comes first, and the write is guarded anyway
                // (findings-review #62-6).
                if Task.isCancelled { return }
                if Self.isTerminal(error) {
                    setConnectionState(.failed)
                    return
                }
                try? await Task.sleep(for: reconnectDelay)
                continue
            }

            setConnectionState(.live)
            // The reload happens after the connect, not before it: an update
            // committed between a pre-connect snapshot and this connect is in
            // neither the snapshot nor the live stream (the hub replays
            // nothing, and a fresh connection's sequence baseline cannot see
            // the hole), and the next reload — which would close the gap —
            // only happens after the next drop. Reloading here closes exactly
            // that window, on every connection including the first
            // (findings-review #62-2). Messages that arrive while the reload
            // is in flight sit buffered in the stream; the upsert-by-id in
            // `apply` makes draining them afterwards safe. There is no
            // reload after the drop instead: a snapshot fetched while
            // disconnected leaves the very same (snapshot → connect) window
            // open on the way back.
            await refresh(projectId: projectId)
            // A fresh connection starts a fresh baseline: whether it is the
            // very first connection or a reconnect, there is nothing to
            // compare the next message's sequence against yet, and the
            // disconnect that just happened (if any) is covered by the
            // reload above.
            lastSequence = nil
            lastSessionId = nil

            do {
                for try await message in stream {
                    if Task.isCancelled { return }

                    // Checked against every message this connection ever
                    // delivers, before filtering by Project: sequence spans
                    // every Project on this one connection, so a skip caused
                    // by another Project's message is never a gap — only a
                    // break in the connection's own overall count is.
                    var mustReload = false
                    if let last = lastSequence, message.sequence != last + 1 {
                        mustReload = true
                    }
                    if let sid = message.sessionId, let lastSid = lastSessionId, sid != lastSid {
                        mustReload = true
                    }
                    lastSequence = message.sequence
                    if let sid = message.sessionId { lastSessionId = sid }

                    if mustReload {
                        await refresh(projectId: projectId)
                    }
                    if message.projectId == projectId {
                        apply(message, to: projectId)
                    }
                }
            } catch {
                // Any way the stream stops delivering — thrown or not — is
                // "the connection dropped" below; the cause does not change
                // the recovery (OBSERVABILITY.md).
            }

            if Task.isCancelled { return }
            setConnectionState(.reconnecting)
            // No reload here: the next iteration reloads right after it
            // reconnects. A snapshot fetched before the reconnect would
            // leave the same (snapshot → connect) window open again
            // (findings-review #62-2).
            try? await Task.sleep(for: reconnectDelay)
        }
    }

    /// Every connection-state write goes through here: a cancelled watch (a
    /// Project switch) can still slip past the loop's `Task.isCancelled`
    /// checks while suspended in its connector, and must not overwrite the
    /// incoming watch's state — findings-review #62-6.
    private func setConnectionState(_ state: TimelineConnectionState) {
        guard !Task.isCancelled else { return }
        connectionState = state
    }

    /// Upserts by id rather than always appending: `execution.changed` is
    /// the same Execution reported again with a new status, and a message
    /// redelivered around a reconnect boundary must never show as a second
    /// row.
    private func apply(_ message: TimelineStreamMessage, to projectId: String) {
        var state = states[projectId] ?? ProjectTimelineState()
        switch message.payload {
        case .event(let event):
            if let index = state.events.firstIndex(where: { $0.id == event.id }) {
                state.events[index] = event
            } else {
                state.events.append(event)
            }
        case .execution(let execution):
            if let index = state.executions.firstIndex(where: { $0.id == execution.id }) {
                state.executions[index] = execution
            } else {
                state.executions.append(execution)
            }
            if execution.status != .running {
                state.pendingCancellationIDs.remove(execution.id)
            }
            if execution.status == .cancelling || execution.status == .cancelled {
                state.cancellationErrorMessages.removeValue(forKey: execution.id)
            }
        }
        states[projectId] = state
    }

    private func selectProject(_ projectId: String) {
        guard activeProjectId != projectId else { return }
        if let previousProjectId = activeProjectId {
            invalidateCancellationState(for: previousProjectId)
        }
        invalidateCancellationState(for: projectId)
        activeProjectId = projectId
    }

    private func invalidateCancellationState(for projectId: String) {
        cancellationGenerations[projectId, default: 0] += 1
        states[projectId]?.pendingCancellationIDs.removeAll()
        states[projectId]?.cancellationErrorMessages.removeAll()
    }

    private func canUpdateCancellation(projectId: String, generation: Int) -> Bool {
        cancellationGenerations[projectId, default: 0] == generation
            && (activeProjectId == nil || activeProjectId == projectId)
    }

    private func setCancellationError(
        _ message: String, projectId: String, executionId: String
    ) {
        var state = states[projectId] ?? ProjectTimelineState()
        state.pendingCancellationIDs.remove(executionId)
        state.cancellationErrorMessages[executionId] = message
        states[projectId] = state
    }

    private func resolvedConnector() -> StreamConnector? {
        if let streamConnector { return streamConnector }
        guard let endpoint = session.streamEndpoint else { return nil }
        return { try await EngineEventStream.connect(port: endpoint.port, token: endpoint.token) }
    }

    /// An auth/host rejection will never succeed on retry (the token never
    /// changes mid-session) — worth giving up on, unlike a transient drop.
    private static func isTerminal(_ error: Error) -> Bool {
        guard let error = error as? EngineClientError else { return false }
        switch error {
        case .unauthorized, .hostNotAllowed: return true
        case .engineError, .unexpectedResponse: return false
        }
    }

    private static let engineUnavailable = "The engine is not running. Restart Jarvis."

    private static func describe(_ error: Error) -> String {
        guard let error = error as? EngineClientError else {
            return "The Timeline could not be loaded. Try again; if it repeats, restart Jarvis."
        }
        return switch error {
        case .unauthorized(let operation):
            "The engine rejected the session token (\(operation)). The Timeline cannot be loaded. Restart Jarvis."
        case .hostNotAllowed(let operation):
            "The engine refused a non-loopback request (\(operation)). The Timeline cannot be loaded. Restart Jarvis."
        case .engineError(_, let code, let message):
            "\(message) (\(code)) The Timeline cannot be loaded. Try again; if it repeats, restart Jarvis."
        case .unexpectedResponse(let message):
            "\(message). The Timeline cannot be loaded. Try again; if it repeats, restart Jarvis."
        }
    }

    private static func describeCancellation(_ error: Error) -> String {
        guard let error = error as? EngineClientError else {
            return "The engine could not be reached. Restart Jarvis."
        }
        return switch error {
        case .unauthorized(let operation):
            "The engine rejected the session token (\(operation)). Restart Jarvis."
        case .hostNotAllowed(let operation):
            "The engine refused a non-loopback request (\(operation)). Restart Jarvis."
        case .engineError(_, let code, let message):
            "\(message) (\(code))"
        case .unexpectedResponse(let message):
            message
        }
    }
}
