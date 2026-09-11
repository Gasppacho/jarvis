import Foundation
import XCTest

@testable import JarvisCore

/// Ticket #62: `ProjectTimelineModel.watchLive`'s incremental-apply, gap
/// detection, reset-and-reload and connection-state reporting, driven by an
/// injected `StreamConnector` seam (alongside ticket #61's `TimelineProvider`)
/// with simulated message sequences — no running engine, per TESTING.md and
/// the issue's "Test seam".
@MainActor
final class ProjectTimelineLiveTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    // MARK: - Incremental apply

    func testEventRecordedForTheShownProjectAppearsWithoutRefresh() async throws {
        let harness = Harness(initialEvents: [], initialExecutions: [])
        let newEvent = makeEvent(id: "evt-new", correlationId: "corr-1")

        let watch = harness.startWatching(projectId: "proj-a")
        await harness.waitUntilLive()
        await harness.emit(harness.message(sequence: 1, projectId: "proj-a", event: newEvent))
        await harness.waitUntil {
            harness.model.state(for: "proj-a").events.map(\.id) == ["evt-new"]
        }
        await harness.finishCurrentStream()
        watch.cancel()
        _ = await watch.result

        XCTAssertEqual(harness.model.state(for: "proj-a").events.map(\.id), ["evt-new"])
        // Two fetches from REST: the initial snapshot and the reload that
        // follows the connect — it closes the window between the two
        // (findings-review #62-2). The new row arrived live, and nothing
        // else triggered a reload.
        let refreshCount = await harness.refreshCount
        XCTAssertEqual(refreshCount, 2)
    }

    func testExecutionChangedForTheShownProjectAppearsWithoutRefresh() async throws {
        let harness = Harness(initialEvents: [], initialExecutions: [])
        let execution = makeExecution(id: "exe-1", correlationId: "corr-1", status: .running)

        let watch = harness.startWatching(projectId: "proj-a")
        await harness.waitUntilLive()
        await harness.emit(harness.message(sequence: 1, projectId: "proj-a", execution: execution))
        await harness.waitUntil {
            harness.model.state(for: "proj-a").executions.map(\.id) == ["exe-1"]
        }
        await harness.finishCurrentStream()
        watch.cancel()
        _ = await watch.result

        XCTAssertEqual(harness.model.state(for: "proj-a").executions.first?.status, .running)
    }

    func testRunningExecutionCancellationUsesOnlyTheProviderAndStreamUpdatesWithoutRefresh() async throws {
        let running = makeExecution(id: "exe-cancel", correlationId: "corr-1")
        let harness = Harness(initialEvents: [], initialExecutions: [running])
        let watch = harness.startWatching(projectId: "proj-a")
        await harness.waitUntilLive()

        let didCancel = await harness.model.cancelExecution(
            projectId: "proj-a", executionId: running.id)
        XCTAssertTrue(didCancel)
        let cancellationExecutionIDs = await harness.cancellationExecutionIDs
        XCTAssertEqual(cancellationExecutionIDs, [running.id])
        let refreshCountBeforeStream = await harness.refreshCount
        XCTAssertEqual(refreshCountBeforeStream, 2, "cancellation must not refresh the Timeline")
        XCTAssertEqual(
            harness.model.state(for: "proj-a").executions.first?.status, .running,
            "the POST response must not optimistically write the Timeline status")

        await harness.emit(
            harness.message(
                sequence: 1, projectId: "proj-a",
                execution: makeExecution(id: running.id, correlationId: "corr-1", status: .cancelling)))
        await harness.waitUntil {
            harness.model.state(for: "proj-a").executions.first?.status == .cancelling
        }
        await harness.emit(
            harness.message(
                sequence: 2, projectId: "proj-a",
                execution: makeExecution(id: running.id, correlationId: "corr-1", status: .cancelled)))
        await harness.waitUntil {
            harness.model.state(for: "proj-a").executions.first?.status == .cancelled
        }

        let refreshCountAfterStream = await harness.refreshCount
        XCTAssertEqual(refreshCountAfterStream, 2)
        XCTAssertTrue(harness.model.state(for: "proj-a").pendingCancellationIDs.isEmpty)
        await harness.finishCurrentStream()
        watch.cancel()
        _ = await watch.result
    }

    func testOnlyRunningExecutionCanBeCancelled() async throws {
        for status in [
            TimelineExecution.Status.queued, .cancelling, .completed, .failed, .cancelled, .timedOut
        ] {
            let execution = makeExecution(
                id: "exe-\(status.displayLabel)", correlationId: "corr-1", status: status)
            let harness = Harness(initialEvents: [], initialExecutions: [execution])
            await harness.model.refresh(projectId: "proj-a")

            let didCancel = await harness.model.cancelExecution(
                projectId: "proj-a", executionId: execution.id)
            XCTAssertFalse(didCancel, "\(status.displayLabel) must not offer cancellation")
            let cancellationExecutionIDs = await harness.cancellationExecutionIDs
            XCTAssertTrue(cancellationExecutionIDs.isEmpty)
        }
    }

    func testEngineRefusalAndDatabaseUnavailabilityAreSurfaced() async throws {
        let errors: [(EngineClientError, String)] = [
            (
                .engineError(
                    operation: "POST /v1/executions/exe-cancel/cancel",
                    code: "execution.not-cancellable",
                    message: "The Execution is no longer running."),
                "The Execution is no longer running. (execution.not-cancellable)"),
            (
                .engineError(
                    operation: "POST /v1/executions/exe-cancel/cancel",
                    code: "engine.database-unavailable",
                    message: "The local database is unavailable."),
                "The local database is unavailable. (engine.database-unavailable)")
        ]

        for (error, expectedMessage) in errors {
            let execution = makeExecution(id: "exe-cancel", correlationId: "corr-1")
            let harness = Harness(
                initialEvents: [], initialExecutions: [execution], cancellationError: error)
            await harness.model.refresh(projectId: "proj-a")

            let didCancel = await harness.model.cancelExecution(
                projectId: "proj-a", executionId: execution.id)
            XCTAssertFalse(didCancel)
            XCTAssertEqual(
                harness.model.state(for: "proj-a").cancellationErrorMessages[execution.id],
                expectedMessage)
            XCTAssertTrue(harness.model.state(for: "proj-a").pendingCancellationIDs.isEmpty)
        }
    }

    func testChangingProjectClearsPendingCancellation() async throws {
        let running = makeExecution(id: "exe-cancel", correlationId: "corr-1")
        let harness = Harness(initialEvents: [], initialExecutions: [running])
        let firstWatch = harness.startWatching(projectId: "proj-a")
        await harness.waitUntilLive()
        let didCancel = await harness.model.cancelExecution(
            projectId: "proj-a", executionId: running.id)
        XCTAssertTrue(didCancel)
        XCTAssertEqual(
            harness.model.state(for: "proj-a").pendingCancellationIDs, Set([running.id]))

        firstWatch.cancel()
        _ = await firstWatch.result
        let secondWatch = harness.startWatching(projectId: "proj-b")
        await harness.waitUntilLive()
        await harness.waitUntil {
            harness.model.state(for: "proj-a").pendingCancellationIDs.isEmpty
        }

        XCTAssertTrue(harness.model.state(for: "proj-a").pendingCancellationIDs.isEmpty)
        XCTAssertTrue(harness.model.state(for: "proj-b").pendingCancellationIDs.isEmpty)
        await harness.finishCurrentStream()
        secondWatch.cancel()
        _ = await secondWatch.result
    }

    func testUpdatesForAnotherProjectNeverAppearInTheDisplayedProjectsTimeline() async throws {
        let harness = Harness(initialEvents: [], initialExecutions: [])
        let otherProjectEvent = makeEvent(id: "evt-other", correlationId: "corr-x")

        let watch = harness.startWatching(projectId: "proj-a")
        await harness.waitUntilLive()
        await harness.emit(
            harness.message(sequence: 1, projectId: "proj-b", event: otherProjectEvent))
        // Follow it with a message for our own Project so we have something
        // to wait on rather than a fixed sleep.
        let ownEvent = makeEvent(id: "evt-own", correlationId: "corr-1")
        await harness.emit(harness.message(sequence: 2, projectId: "proj-a", event: ownEvent))
        await harness.waitUntil {
            harness.model.state(for: "proj-a").events.map(\.id) == ["evt-own"]
        }
        await harness.finishCurrentStream()
        watch.cancel()
        _ = await watch.result

        XCTAssertEqual(harness.model.state(for: "proj-a").events.map(\.id), ["evt-own"])
        let refreshCount = await harness.refreshCount
        XCTAssertEqual(
            refreshCount, 2,
            "the two initial loads only (snapshot + post-connect) — another Project's message must never trigger a reload")
    }

    // MARK: - Gap detection: the subtle part

    func testSequenceSkipCausedByAnotherProjectIsNotTreatedAsAGap() async throws {
        // From proj-a's own perspective, sequence jumps 1 -> 3 — but 2 was
        // legitimately spent on proj-b, on the very same connection. Gap
        // detection must run over every message received, not the
        // per-Project-filtered view.
        let harness = Harness(initialEvents: [], initialExecutions: [])
        let watch = harness.startWatching(projectId: "proj-a")

        await harness.waitUntilLive()
        await harness.emit(
            harness.message(
                sequence: 1, projectId: "proj-a",
                event: makeEvent(id: "evt-1", correlationId: "corr-1")))
        await harness.emit(
            harness.message(
                sequence: 2, projectId: "proj-b",
                event: makeEvent(id: "evt-other", correlationId: "corr-x")))
        await harness.emit(
            harness.message(
                sequence: 3, projectId: "proj-a",
                event: makeEvent(id: "evt-2", correlationId: "corr-1")))
        await harness.waitUntil {
            Set(harness.model.state(for: "proj-a").events.map(\.id)) == ["evt-1", "evt-2"]
        }
        await harness.finishCurrentStream()
        watch.cancel()
        _ = await watch.result

        let refreshCount = await harness.refreshCount
        XCTAssertEqual(
            refreshCount, 2,
            "the two initial loads only — a skip explained by another Project's message must never be treated as a gap")
    }

    func testAGenuineSequenceGapTriggersResetAndReload() async throws {
        let harness = Harness(
            initialEvents: [], initialExecutions: [],
            reloadedEvents: [makeEvent(id: "evt-durable", correlationId: "corr-1")])
        let watch = harness.startWatching(projectId: "proj-a")

        await harness.waitUntilLive()
        await harness.emit(
            harness.message(
                sequence: 1, projectId: "proj-a",
                event: makeEvent(id: "evt-1", correlationId: "corr-1")))
        // Sequence 4 with nothing in between belonging to any Project: a
        // real transport gap.
        await harness.emit(
            harness.message(
                sequence: 4, projectId: "proj-a",
                event: makeEvent(id: "evt-4", correlationId: "corr-1")))
        await harness.waitUntil { await harness.refreshCount == 2 }
        await harness.finishCurrentStream()
        watch.cancel()
        _ = await watch.result

        let refreshCount = await harness.refreshCount
        XCTAssertEqual(
            refreshCount, 3,
            "the two initial loads (snapshot + post-connect) plus exactly one gap reload")
        // The reload's own REST snapshot is what ends up on screen, upserted
        // with the message that revealed the gap — never the pre-gap rows.
        XCTAssertTrue(harness.model.state(for: "proj-a").events.map(\.id).contains("evt-durable"))
    }

    // MARK: - Disconnect

    func testADroppedConnectionTriggersResetAndReload() async throws {
        let harness = Harness(
            initialEvents: [], initialExecutions: [],
            reloadedEvents: [makeEvent(id: "evt-durable", correlationId: "corr-1")])
        let watch = harness.startWatching(projectId: "proj-a")

        await harness.waitUntilLive()
        await harness.emit(
            harness.message(
                sequence: 1, projectId: "proj-a",
                event: makeEvent(id: "evt-1", correlationId: "corr-1")))
        // The reload that follows the connect (findings-review #62-2)
        // already fetched the reloaded snapshot, so the live row sits next
        // to it — wait for it to appear, not for it to be the only row.
        await harness.waitUntil {
            harness.model.state(for: "proj-a").events.map(\.id).contains("evt-1")
        }

        // The connection just ends — no error, no more messages.
        await harness.finishCurrentStream()
        await harness.waitUntil {
            await harness.refreshCount == 3
                && harness.model.connectionState == .live
                && harness.model.state(for: "proj-a").events.map(\.id) == ["evt-durable"]
        }

        XCTAssertEqual(harness.model.connectionState, .live, "the reconnect already succeeded")
        watch.cancel()
        _ = await watch.result

        XCTAssertEqual(
            harness.model.state(for: "proj-a").events.map(\.id), ["evt-durable"],
            "the reload's snapshot replaces whatever was accumulated before the drop")
    }

    // MARK: - New Engine Session

    func testANewEngineSessionTriggersResetAndReload() async throws {
        let harness = Harness(
            initialEvents: [], initialExecutions: [],
            reloadedEvents: [makeEvent(id: "evt-durable", correlationId: "corr-1")])
        let watch = harness.startWatching(projectId: "proj-a")

        await harness.waitUntilLive()
        await harness.emit(
            harness.message(
                sequence: 1, projectId: "proj-a", sessionId: "session-1",
                event: makeEvent(id: "evt-1", correlationId: "corr-1")))
        await harness.emit(
            harness.message(
                // A new Engine Session restarts sequence at 1 too — the
                // sessionId change alone must be enough to trigger reload.
                sequence: 1, projectId: "proj-a", sessionId: "session-2",
                event: makeEvent(id: "evt-2", correlationId: "corr-1")))
        await harness.waitUntil { await harness.refreshCount == 2 }
        await harness.finishCurrentStream()
        watch.cancel()
        _ = await watch.result

        let refreshCount = await harness.refreshCount
        XCTAssertEqual(
            refreshCount, 3,
            "the two initial loads (snapshot + post-connect) plus exactly one session-change reload")
    }

    // MARK: - No duplicate / no phantom row after reconnection

    func testAfterReconnectionThereIsNoDuplicateRowAndNoRowRestWouldNotReturn() async throws {
        // The durable snapshot the reload fetches already contains the row
        // that was applied live before the drop (it was durable by the time
        // the engine emitted it) — upsert-by-id must not double it.
        let harness = Harness(
            initialEvents: [], initialExecutions: [],
            reloadedEvents: [makeEvent(id: "evt-1", correlationId: "corr-1")])
        let watch = harness.startWatching(projectId: "proj-a")

        await harness.waitUntilLive()
        await harness.emit(
            harness.message(
                sequence: 1, projectId: "proj-a",
                event: makeEvent(id: "evt-1", correlationId: "corr-1")))
        await harness.waitUntil {
            harness.model.state(for: "proj-a").events.map(\.id) == ["evt-1"]
        }
        await harness.finishCurrentStream()
        await harness.waitUntil { await harness.refreshCount == 2 }
        watch.cancel()
        _ = await watch.result

        XCTAssertEqual(harness.model.state(for: "proj-a").events.map(\.id), ["evt-1"])
    }

    // MARK: - Connection state

    func testConnectionStateGoesLiveThenReconnectingOnATransientFailureThenLiveAgain() async throws {
        // Attempt 1 connects; attempt 2 (the reconnect right after the drop)
        // fails transiently and must read `.reconnecting`, not `.failed`, for
        // the whole `reconnectDelay` before attempt 3 succeeds.
        let harness = Harness(
            initialEvents: [], initialExecutions: [], failOnAttempt: 2,
            reconnectDelay: .milliseconds(200))
        let watch = harness.startWatching(projectId: "proj-a")

        await harness.waitUntil { harness.model.connectionState == .live }
        await harness.finishCurrentStream()

        await harness.waitUntil { harness.model.connectionState == .reconnecting }
        await harness.waitUntil { await harness.connectAttempts >= 2 }
        XCTAssertEqual(
            harness.model.connectionState, .reconnecting,
            "a transient failure must not be reported as .failed")

        await harness.waitUntil(timeout: 3) { harness.model.connectionState == .live }

        await harness.finishCurrentStream()
        watch.cancel()
        _ = await watch.result
    }

    func testAnUnauthorizedConnectionAttemptReportsFailedAndStopsRetrying() async throws {
        let harness = Harness(
            initialEvents: [], initialExecutions: [],
            connectorError: EngineClientError.unauthorized(operation: "GET /v1/stream"))

        await harness.model.watchLive(projectId: "proj-a", reconnectDelay: .zero)

        XCTAssertEqual(harness.model.connectionState, .failed)
        let connectAttempts = await harness.connectAttempts
        XCTAssertEqual(connectAttempts, 1, "an auth rejection must not be retried")
    }

    func testATimelineThatCannotGoLiveStillShowsTheLastDurableSnapshot() async throws {
        let cached = makeEvent(id: "evt-cached", correlationId: "corr-1")
        let harness = Harness(
            initialEvents: [cached], initialExecutions: [],
            connectorError: EngineClientError.unauthorized(operation: "GET /v1/stream"))

        await harness.model.watchLive(projectId: "proj-a", reconnectDelay: .zero)

        XCTAssertEqual(harness.model.connectionState, .failed)
        XCTAssertEqual(harness.model.state(for: "proj-a").events.map(\.id), ["evt-cached"])
    }

    // MARK: - Rehydration window (findings-review #62-2): the reload follows the connect

    func testAnUpdatePublishedBetweenTheInitialSnapshotAndTheConnectStillLands() async throws {
        // The first connect is gated, so the test controls the instant it
        // happens. An update committed after the initial snapshot but
        // before the connect is in neither the snapshot nor the live
        // stream (the hub replays nothing, and the fresh connection's
        // sequence baseline cannot see the hole) — only the reload that
        // follows the connect can bring it in.
        let late = makeEvent(id: "evt-late", correlationId: "corr-1")
        let harness = Harness(
            initialEvents: [], initialExecutions: [],
            reloadedEvents: [late],
            gateConnectAttempt: 1)
        let watch = harness.startWatching(projectId: "proj-a")

        // The initial snapshot is already taken.
        await harness.waitUntil { await harness.refreshCount == 1 }
        // The engine commits and emits `evt-late` now — after the
        // snapshot, before the connect. It is delivered to nothing (no
        // connection yet); the reload after the connect is the only way
        // it can reach the Timeline.
        await harness.emit(harness.message(sequence: 1, projectId: "proj-a", event: late))
        await harness.openGate("connect-1")

        await harness.waitUntil {
            harness.model.state(for: "proj-a").events.map(\.id).contains("evt-late")
        }
        await harness.finishCurrentStream()
        watch.cancel()
        _ = await watch.result

        XCTAssertTrue(
            harness.model.state(for: "proj-a").events.map(\.id).contains("evt-late"),
            "an update published between the snapshot and the connect must still land in the Timeline")
    }

    func testAnUpdateCommittedWhileDisconnectedLandsOnceTheReconnectReloads() async throws {
        // The provider returns a mutable "durable" array; committing into
        // it models the engine having committed an update — a snapshot
        // taken before that moment cannot contain it, whichever side of
        // the reconnect the snapshot is fetched on.
        let preDrop = makeEvent(id: "evt-pre", correlationId: "corr-1")
        let late = makeEvent(id: "evt-late", correlationId: "corr-1")
        let harness = Harness(
            initialEvents: [], initialExecutions: [],
            liveDurableState: [preDrop],
            gateConnectAttempt: 2,
            gateRefreshAttempt: 2)
        let watch = harness.startWatching(projectId: "proj-a")
        await harness.waitUntilLive()

        // The connection drops.
        await harness.finishCurrentStream()
        // The reload's snapshot is taken now — the engine has not
        // committed `evt-late` yet, so it cannot be in it.
        await harness.waitUntil { await harness.refreshCount == 2 }
        await harness.openGate("refresh-2")
        // ...and only now does the engine commit it, still disconnected.
        await harness.commit(late)
        // The reconnect happens after that.
        await harness.openGate("connect-2")

        await harness.waitUntil {
            harness.model.state(for: "proj-a").events.map(\.id).contains("evt-late")
        }
        await harness.finishCurrentStream()
        watch.cancel()
        _ = await watch.result

        XCTAssertTrue(
            harness.model.state(for: "proj-a").events.map(\.id).contains("evt-late"),
            "the reload must follow the reconnect, not precede it: a snapshot fetched while disconnected cannot contain an update committed in the gap")
    }

    // MARK: - Connection-state lifecycle (findings-review #62-6)

    func testAReentryBeginsReconnectingNeverWithAStaleLiveState() async throws {
        // The provider sleeps, so the entry window is observable: between
        // the watch starting and its first connect, the badge must read
        // "reconnecting" — never the stale "live" the previous watch left
        // behind (cancellation is not a state reset).
        let harness = Harness(
            initialEvents: [], initialExecutions: [],
            refreshDelay: .milliseconds(300))
        let first = harness.startWatching(projectId: "proj-a")
        await harness.waitUntilLive()
        first.cancel()
        _ = await first.result
        XCTAssertEqual(
            harness.model.connectionState, .live,
            "the state is left as the previous watch's — the next watch must reset it")

        let second = harness.startWatching(projectId: "proj-a")
        // The entry snapshot is in flight (the provider is sleeping) —
        // this watch has not connected yet.
        await harness.waitUntil { await harness.refreshCount >= 3 }
        XCTAssertEqual(
            harness.model.connectionState, .reconnecting,
            "a watch that has not connected yet must not read as the previous watch's live")

        await harness.waitUntil(timeout: 3) { harness.model.connectionState == .live }
        second.cancel()
        _ = await second.result
    }

    func testACancelledWatchCannotOverwriteTheIncomingWatchesState() async throws {
        // A Project switch: the outgoing watch is cancelled while its
        // reconnect is suspended inside the connector; the incoming watch
        // goes live; then the outgoing connector fails terminally. Its
        // `.failed` must not overwrite the incoming watch's `.live`.
        let harness = Harness(
            initialEvents: [], initialExecutions: [],
            connectorError: EngineClientError.unauthorized(operation: "GET /v1/stream"),
            terminalOnAttempt: 2,
            gateConnectAttempt: 2)
        let outgoing = harness.startWatching(projectId: "proj-a")
        await harness.waitUntilLive()

        await harness.finishCurrentStream()
        // The outgoing watch is now suspended inside its (terminal)
        // reconnect attempt.
        await harness.waitUntil { await harness.connectAttempts >= 2 }
        outgoing.cancel()

        let incoming = harness.startWatching(projectId: "proj-a")
        await harness.waitUntil { harness.model.connectionState == .live }
        // Release the outgoing connector: it throws its terminal error
        // now — but it was cancelled, so it must stay silent.
        await harness.openGate("connect-2")
        // Give the outgoing watch a turn to (not) write.
        await Task.yield()
        await Task.yield()

        XCTAssertEqual(
            harness.model.connectionState, .live,
            "a cancelled watch's terminal failure must not overwrite the incoming watch's state")
        await harness.finishCurrentStream()
        incoming.cancel()
        _ = await incoming.result
    }

    // MARK: - Fixtures

    private func makeEvent(
        id: String, correlationId: String, occurredAt: Date? = nil,
        producer: String = "development", type: String = "scm.work-item.tag-added"
    ) -> TimelineEvent {
        TimelineEvent(
            id: id, type: type, kind: .request, occurredAt: occurredAt ?? t0, producer: producer,
            correlationId: correlationId)
    }

    private func makeExecution(
        id: String, correlationId: String?, status: TimelineExecution.Status = .running
    ) -> TimelineExecution {
        TimelineExecution(
            id: id, projectId: "proj-a", moduleInstanceId: "development", status: status,
            attempt: 1, createdAt: t0, correlationId: correlationId)
    }
}

/// Thrown by the harness's `StreamConnector` to simulate a transient
/// connect failure — a plain drop/refuse, distinct from the terminal
/// `EngineClientError.unauthorized`/`.hostNotAllowed` a test can inject via
/// `connectorError` instead.
private struct TransientConnectFailure: Error, Sendable {}

/// Drives one `ProjectTimelineModel` under test: a scripted `TimelineProvider`
/// counting calls, and a `StreamConnector` whose connections this harness
/// controls by hand (`emit`, `finishCurrentStream`) instead of a real socket.
@MainActor
private final class Harness {
    let model: ProjectTimelineModel
    private let reconnectDelay: Duration
    private let box: Box

    /// Counters and the in-flight continuation, actor-isolated because the
    /// `@Sendable` `provider`/`streamConnector` closures run on the model's
    /// own Task, which this object's own MainActor calls are not
    /// synchronised with.
    private actor Box {
        var refreshCount = 0
        var connectAttempts = 0
        var cancellationExecutionIDs: [String] = []
        var durable: [TimelineEvent] = []
        var openGates: Set<String> = []
        var gateWaiters: [String: CheckedContinuation<Void, Never>] = [:]
        var currentContinuation: AsyncThrowingStream<TimelineStreamMessage, Error>.Continuation?

        init(durable: [TimelineEvent]) {
            self.durable = durable
        }

        func recordRefresh() -> Int {
            refreshCount += 1
            return refreshCount
        }

        func recordConnectAttempt() -> Int {
            connectAttempts += 1
            return connectAttempts
        }

        func recordCancellation(_ executionId: String) {
            cancellationExecutionIDs.append(executionId)
        }

        func setContinuation(
            _ continuation: AsyncThrowingStream<TimelineStreamMessage, Error>.Continuation
        ) {
            currentContinuation = continuation
        }

        func emit(_ message: TimelineStreamMessage) {
            currentContinuation?.yield(message)
        }

        func finish() {
            currentContinuation?.finish()
            currentContinuation = nil
        }

        func commit(_ event: TimelineEvent) {
            durable.append(event)
        }

        /// The test controls when a gated call proceeds. Opening a gate
        /// before anyone waits simply records it: the waiter passes
        /// straight through. The check and the waiter registration are
        /// one synchronous actor step, so no open can slip between them.
        func awaitGate(_ name: String) async {
            if openGates.contains(name) { return }
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                gateWaiters[name] = continuation
            }
        }

        func openGate(_ name: String) {
            if let waiter = gateWaiters[name] {
                gateWaiters[name] = nil
                waiter.resume()
            } else {
                openGates.insert(name)
            }
        }
    }

    init(
        initialEvents: [TimelineEvent], initialExecutions: [TimelineExecution],
        reloadedEvents: [TimelineEvent]? = nil,
        /// When set, the provider returns this mutable "durable" array (the
        /// test commits into it) instead of the scripted
        /// `initialEvents`/`reloadedEvents` fiction — the only way to make
        /// a snapshot's content depend on *when* it is fetched, which the
        /// findings-review #62-2 window tests need.
        liveDurableState: [TimelineEvent]? = nil,
        connectorError: (any Error & Sendable)? = nil,
        failOnAttempt: Int? = nil,
        /// Only on this attempt, the connector throws `connectorError`
        /// (a terminal rejection) — after suspending at the connect gate,
        /// so a test can cancel the watch mid-connect and then release it.
        terminalOnAttempt: Int? = nil,
        /// The connector suspends before returning on this attempt, until
        /// the test calls `openGate("connect-\(attempt)")` — the test
        /// controls the instant the (re)connect happens.
        gateConnectAttempt: Int? = nil,
        /// The provider suspends before reading the snapshot on this
        /// attempt, until the test calls
        /// `openGate("refresh-\(attempt)")` — the test controls the instant
        /// the snapshot is taken.
        gateRefreshAttempt: Int? = nil,
        /// The provider sleeps after recording its call, modelling an
        /// in-flight snapshot (the findings-review #62-6 entry-window test
        /// observes the badge during this sleep).
        refreshDelay: Duration = .zero,
        cancellationError: (any Error & Sendable)? = nil,
        reconnectDelay: Duration = .zero
    ) {
        self.reconnectDelay = reconnectDelay
        let session = EngineSessionModel(
            supervisor: EngineSupervisor(resources: .developmentBuild()))
        let box = Box(durable: liveDurableState ?? [])
        self.box = box

        let provider: ProjectTimelineModel.TimelineProvider = { _ in
            let attempt = await box.recordRefresh()
            if let gateRefreshAttempt, attempt == gateRefreshAttempt {
                await box.awaitGate("refresh-\(attempt)")
            }
            if refreshDelay > .zero {
                // A snapshot that takes a while: a window during which the
                // test can observe the badge, or publish on the stream.
                try? await Task.sleep(for: refreshDelay)
            }
            let events: [TimelineEvent]
            if liveDurableState != nil {
                events = await box.durable
            } else {
                events = attempt == 1 ? initialEvents : (reloadedEvents ?? initialEvents)
            }
            return (events: events, executions: initialExecutions)
        }
        let cancellationProvider: ProjectTimelineModel.CancellationProvider = { executionId in
            await box.recordCancellation(executionId)
            if let cancellationError { throw cancellationError }
            return initialExecutions.first { $0.id == executionId }!
        }
        let connector: ProjectTimelineModel.StreamConnector = {
            let attempt = await box.recordConnectAttempt()
            if let gateConnectAttempt, attempt == gateConnectAttempt {
                await box.awaitGate("connect-\(attempt)")
            }
            if attempt == failOnAttempt {
                throw TransientConnectFailure()
            }
            if let terminalOnAttempt {
                if attempt == terminalOnAttempt {
                    throw (connectorError ?? TransientConnectFailure())
                }
            } else if let connectorError {
                throw connectorError
            }
            let (stream, continuation) =
                AsyncThrowingStream<TimelineStreamMessage, Error>.makeStream()
            await box.setContinuation(continuation)
            return stream
        }

        model = ProjectTimelineModel(
            session: session, provider: provider, streamConnector: connector,
            cancellationProvider: cancellationProvider)
    }

    var refreshCount: Int {
        get async { await box.refreshCount }
    }

    var connectAttempts: Int {
        get async { await box.connectAttempts }
    }

    var cancellationExecutionIDs: [String] {
        get async { await box.cancellationExecutionIDs }
    }

    func startWatching(projectId: String) -> Task<Void, Never> {
        Task { [model, reconnectDelay] in
            await model.watchLive(projectId: projectId, reconnectDelay: reconnectDelay)
        }
    }

    func message(
        sequence: Int, projectId: String, sessionId: String? = "session-1",
        event: TimelineEvent? = nil, execution: TimelineExecution? = nil
    ) -> TimelineStreamMessage {
        if let event {
            return TimelineStreamMessage(
                sequence: sequence, projectId: projectId, sessionId: sessionId,
                payload: .event(event))
        }
        return TimelineStreamMessage(
            sequence: sequence, projectId: projectId, sessionId: sessionId,
            payload: .execution(execution!))
    }

    func emit(_ message: TimelineStreamMessage) async {
        await box.emit(message)
    }

    func finishCurrentStream() async {
        await box.finish()
    }

    func commit(_ event: TimelineEvent) async {
        await box.commit(event)
    }

    func openGate(_ name: String) async {
        await box.openGate(name)
    }

    func waitUntil(
        timeout: TimeInterval = 2, _ condition: @MainActor () async -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !(await condition()) && Date() < deadline {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    /// `startWatching`'s Task connects asynchronously (it fetches the
    /// initial snapshot first); a test must not `emit` before that
    /// connection exists, or the message is delivered to nothing and
    /// silently lost — exactly as a real connect-then-send would require.
    func waitUntilLive(timeout: TimeInterval = 2) async {
        await waitUntil(timeout: timeout) { self.model.connectionState == .live }
    }
}
