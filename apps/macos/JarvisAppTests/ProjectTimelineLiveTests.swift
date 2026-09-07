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
        // Only the initial load fetched from REST — the new row arrived live.
        let refreshCount = await harness.refreshCount
        XCTAssertEqual(refreshCount, 1)
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
        XCTAssertEqual(refreshCount, 1, "another Project's message must never trigger a reload")
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
            refreshCount, 1,
            "a skip explained by another Project's message must never be treated as a gap")
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
        XCTAssertEqual(refreshCount, 2, "the gap must trigger exactly one reload")
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
        await harness.waitUntil {
            harness.model.state(for: "proj-a").events.map(\.id) == ["evt-1"]
        }

        // The connection just ends — no error, no more messages.
        await harness.finishCurrentStream()
        await harness.waitUntil { await harness.refreshCount == 2 }

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
        XCTAssertEqual(refreshCount, 2)
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
    private let box = Box()

    /// Counters and the in-flight continuation, actor-isolated because the
    /// `@Sendable` `provider`/`streamConnector` closures run on the model's
    /// own Task, which this object's own MainActor calls are not
    /// synchronised with.
    private actor Box {
        var refreshCount = 0
        var connectAttempts = 0
        var currentContinuation: AsyncThrowingStream<TimelineStreamMessage, Error>.Continuation?

        func recordRefresh() -> Int {
            refreshCount += 1
            return refreshCount
        }

        func recordConnectAttempt() -> Int {
            connectAttempts += 1
            return connectAttempts
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
    }

    init(
        initialEvents: [TimelineEvent], initialExecutions: [TimelineExecution],
        reloadedEvents: [TimelineEvent]? = nil,
        connectorError: (any Error & Sendable)? = nil,
        failOnAttempt: Int? = nil,
        reconnectDelay: Duration = .zero
    ) {
        self.reconnectDelay = reconnectDelay
        let session = EngineSessionModel(
            supervisor: EngineSupervisor(resources: .developmentBuild()))
        let box = self.box

        let provider: ProjectTimelineModel.TimelineProvider = { _ in
            let attempt = await box.recordRefresh()
            let events = attempt == 1 ? initialEvents : (reloadedEvents ?? initialEvents)
            return (events: events, executions: initialExecutions)
        }
        let connector: ProjectTimelineModel.StreamConnector = {
            let attempt = await box.recordConnectAttempt()
            if attempt == failOnAttempt {
                throw TransientConnectFailure()
            }
            if let connectorError {
                throw connectorError
            }
            let (stream, continuation) =
                AsyncThrowingStream<TimelineStreamMessage, Error>.makeStream()
            await box.setContinuation(continuation)
            return stream
        }

        model = ProjectTimelineModel(
            session: session, provider: provider, streamConnector: connector)
    }

    var refreshCount: Int {
        get async { await box.refreshCount }
    }

    var connectAttempts: Int {
        get async { await box.connectAttempts }
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
