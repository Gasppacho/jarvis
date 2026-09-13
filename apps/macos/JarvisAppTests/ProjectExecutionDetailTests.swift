import Foundation
import XCTest
import JarvisAPI

@testable import JarvisCore

/// Ticket #200: lifecycle labels, connection badges and proof gaps stay
/// deterministic without a running Engine or SwiftUI rendering.
@MainActor
final class ProjectExecutionDetailTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    func testVisibleDetailRefreshesCheckpointsWithoutTimelineEventsAndRetainsItsSnapshotOnDisconnect() async throws {
        let provider = DetailProbe(detail: makeDetail(status: .running))
        let model = ProjectExecutionDetailModel(session: EngineSessionModel(supervisor: EngineSupervisor(resources: .developmentBuild())), provider: { _, _ in try await provider.load() })
        let watch = Task { await model.watch(projectId: "project-a", executionId: "execution-a") }
        defer { watch.cancel() }
        while model.state(for: "project-a", executionId: "execution-a").detail == nil { await Task.yield() }
        let retained = model.state(for: "project-a", executionId: "execution-a").detail
        await provider.failLoads()
        let deadline = Date().addingTimeInterval(3)
        while model.state(for: "project-a", executionId: "execution-a").errorMessage == nil && Date() < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertNotNil(model.state(for: "project-a", executionId: "execution-a").errorMessage)
        XCTAssertEqual(model.state(for: "project-a", executionId: "execution-a").detail, retained)
    }

    func testDecodesDurableEngineSnapshotsWithoutLosingFailureOrRepairHistory() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "ExecutionDetailSnapshots", withExtension: "json", subdirectory: "Fixtures"))
        let decoder = JSONDecoder()
        let transcoder = FlexibleISO8601DateTranscoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            try transcoder.decode(decoder.singleValueContainer().decode(String.self))
        }
        let payloads = try decoder.decode([String: Components.Schemas.ExecutionDetailV1].self, from: Data(contentsOf: url))
        let snapshots = payloads.mapValues(ProjectExecutionDetail.init(payload:))
        let expected: [(String, ProjectExecutionDetail.Step.Status)] = [
            ("running", .active), ("failed", .failed), ("repairing", .repairing), ("repaired", .proved),
        ]
        for (name, status) in expected {
            let detail = try XCTUnwrap(snapshots[name])
            XCTAssertEqual(detail.steps.first(where: { $0.id == .checks })?.status, status)
            XCTAssertNotNil(detail.lastActivityAt)
            XCTAssertEqual(Set(detail.checks.map(\.id)).count, detail.checks.count)
        }
        let repaired = try XCTUnwrap(snapshots["repaired"])
        XCTAssertEqual(repaired.checks.map(\.status), [.failed, .passed])
        XCTAssertEqual(repaired.checks.map(\.attempt), [1, 2])
        XCTAssertNil(repaired.failure)
        let repairing = try XCTUnwrap(snapshots["repairing"])
        XCTAssertEqual(repairing.checks.first?.status, .failed)
        XCTAssertNotNil(repairing.failure)
        XCTAssertEqual(snapshots["cancelled"]?.steps.first(where: { $0.id == .agentRunning })?.status, .cancelled)
        let disconnected = ProjectExecutionDetailPresentation(ProjectExecutionDetailState(detail: repairing), connection: .failed)
        XCTAssertTrue(disconnected.isSnapshot)
        guard case .loaded(let retained) = disconnected.state else { return XCTFail("Lost durable snapshot") }
        XCTAssertEqual(retained.checks, repairing.checks)
    }

    func testPresentsEveryExecutionLifecycleStateWithAStableLabel() {
        let cases: [(ProjectExecutionDetail.ExecutionStatus, String)] = [
            (.queued, "Queued"),
            (.running, "Running"),
            (.cancelling, "Cancelling"),
            (.completed, "Completed"),
            (.failed, "Failed"),
            (.timedOut, "Timed out"),
            (.cancelled, "Cancelled"),
        ]

        for (status, label) in cases {
            let detail = makeDetail(status: status)
            let presentation = ProjectExecutionDetailPresentation(
                ProjectExecutionDetailState(detail: detail), connection: .live)

            XCTAssertEqual(
                ProjectExecutionDetailPresentation.executionStatusLabel(status), label)
            XCTAssertEqual(presentation.currentExecution(detail)?.status, status)
            XCTAssertEqual(presentation.connectionLabel, "Live")
            XCTAssertFalse(presentation.isSnapshot)
        }
    }

    func testReconnectingAndFailedConnectionsKeepSnapshotSemantics() {
        let detail = makeDetail(status: .completed)

        let reconnecting = ProjectExecutionDetailPresentation(
            ProjectExecutionDetailState(detail: detail), connection: .reconnecting)
        XCTAssertEqual(reconnecting.connectionLabel, "Reconnecting…")
        XCTAssertEqual(reconnecting.connectionSymbol, "arrow.triangle.2.circlepath")
        XCTAssertTrue(reconnecting.isSnapshot)

        let failed = ProjectExecutionDetailPresentation(
            ProjectExecutionDetailState(detail: detail), connection: .failed)
        XCTAssertEqual(failed.connectionLabel, "Snapshot précédent")
        XCTAssertEqual(failed.connectionSymbol, "clock.arrow.circlepath")
        XCTAssertTrue(failed.isSnapshot)
    }

    func testRefreshFailureKeepsThePreviousDetailSnapshotVisible() {
        let detail = makeDetail(status: .completed)
        let presentation = ProjectExecutionDetailPresentation(
            ProjectExecutionDetailState(
                detail: detail, isLoading: false, errorMessage: "Engine disconnected"),
            connection: .failed)

        guard case .stale(let snapshot, let message) = presentation.state else {
            return XCTFail("a failed refresh must keep the previous detail as stale")
        }
        XCTAssertEqual(snapshot, detail)
        XCTAssertEqual(message, "Engine disconnected")
        XCTAssertEqual(presentation.connectionLabel, "Snapshot précédent")
    }

    func testMissingEvidenceAndManualReviewLabelsRemainExplicit() {
        let detail = makeDetail(status: .failed)
        XCTAssertEqual(
            ProjectExecutionDetailPresentation.stepStatusLabel(.unavailable),
            "Information indisponible")
        XCTAssertEqual(
            ProjectExecutionDetailPresentation.checkStatusLabel(.unavailable),
            "Information indisponible")
        XCTAssertNil(detail.pullRequest)
        XCTAssertNil(detail.retryDeliveryId)
        XCTAssertNil(detail.cancellableExecutionId)
    }

    func testRetryAndPullRequestResultsStayAvailableAsSeparateActions() {
        let detail = ProjectExecutionDetail(
            projectId: "project-a",
            correlationId: "corr-a",
            workItem: nil,
            executions: [
                ProjectExecutionDetail.Execution(
                    id: "execution-a",
                    moduleInstanceId: "development",
                    status: .failed,
                    attempt: 1,
                    createdAt: t0,
                    error: "validation failed",
                    completedAt: t0.addingTimeInterval(1),
                    inputEventId: "event-a",
                    durationMs: 1_000),
            ],
            steps: [],
            checks: [],
            agentExcerpts: [],
            workspace: nil,
            artifacts: nil,
            pullRequest: ProjectExecutionDetail.PullRequest(
                ref: "github:pull/42", number: 42, title: "Execution detail",
                url: "https://github.com/Gasppacho/jarvis/pull/42",
                repositoryId: "Gasppacho/jarvis"),
            lastEvent: nil,
            technical: ProjectExecutionDetail.Technical(
                inputEventIds: ["event-a"], correlationId: "corr-a", causationIds: [], events: []),
            failure: nil,
            retryDeliveryId: "delivery-a",
            cancellableExecutionId: nil)

        XCTAssertEqual(detail.pullRequest?.number, 42)
        XCTAssertEqual(detail.pullRequest?.title, "Execution detail")
        XCTAssertEqual(detail.retryDeliveryId, "delivery-a")
        XCTAssertNil(detail.cancellableExecutionId)
    }

    func testStaleSnapshotKeepsRetryAvailableAndInvokesItsDelivery() async {
        let detail = makeDetail(status: .failed, retryDeliveryId: "delivery-a")
        let probe = DetailProbe(detail: detail)
        let model = ProjectExecutionDetailModel(
            session: EngineSessionModel(
                supervisor: EngineSupervisor(resources: .developmentBuild())),
            provider: { _, _ in try await probe.load() },
            retryProvider: { deliveryId in await probe.retry(deliveryId) })

        await model.refresh(projectId: "project-a", executionId: "execution-a")
        await probe.failLoads()
        await model.refresh(projectId: "project-a", executionId: "execution-a")

        let staleState = model.state(for: "project-a", executionId: "execution-a")
        XCTAssertEqual(staleState.detail, detail)
        XCTAssertEqual(staleState.errorMessage, "detail unavailable")
        let didRetry = await model.retry(projectId: "project-a", executionId: "execution-a")
        let retryIDs = await probe.retryIDs()
        XCTAssertTrue(didRetry)
        XCTAssertEqual(retryIDs, ["delivery-a"])
    }

    func testCancellationUsesDetailProviderWithoutTimelineState() async {
        let detail = makeDetail(
            status: .running, cancellableExecutionId: "execution-a")
        let probe = DetailProbe(detail: detail)
        let model = ProjectExecutionDetailModel(
            session: EngineSessionModel(
                supervisor: EngineSupervisor(resources: .developmentBuild())),
            provider: { _, _ in try await probe.load() },
            cancellationProvider: { executionId in await probe.cancel(executionId) })

        await model.refresh(projectId: "project-a", executionId: "execution-a")
        let cancellation = Task {
            await model.cancelExecution(projectId: "project-a", executionId: "execution-a")
        }
        for _ in 0..<100 where await probe.cancellationIDs().isEmpty {
            await Task.yield()
        }
        let cancellationIDs = await probe.cancellationIDs()
        XCTAssertEqual(cancellationIDs, ["execution-a"])
        XCTAssertTrue(model.state(for: "project-a", executionId: "execution-a").isCancelling)

        await probe.releaseCancellation()
        let didCancel = await cancellation.value
        XCTAssertTrue(didCancel)
    }

    func testCancellationUsesTheDetailAnchorWhenTargetIsALaterAttempt() async {
        let detail = makeDetail(
            status: .running,
            executionId: "execution-latest",
            cancellableExecutionId: "execution-latest")
        let probe = DetailProbe(detail: detail)
        let model = ProjectExecutionDetailModel(
            session: EngineSessionModel(
                supervisor: EngineSupervisor(resources: .developmentBuild())),
            provider: { _, _ in try await probe.load() },
            cancellationProvider: { executionId in await probe.cancel(executionId) })

        await model.refresh(projectId: "project-a", executionId: "execution-anchor")
        let cancellation = Task {
            await model.cancelExecution(
                projectId: "project-a",
                executionId: "execution-anchor",
                targetExecutionId: "execution-latest")
        }
        for _ in 0..<100 where await probe.cancellationIDs().isEmpty {
            await Task.yield()
        }
        let cancellationIDs = await probe.cancellationIDs()
        XCTAssertEqual(cancellationIDs, ["execution-latest"])
        await probe.releaseCancellation()
        let didCancel = await cancellation.value
        XCTAssertTrue(didCancel)
    }

    private func makeDetail(
        status: ProjectExecutionDetail.ExecutionStatus,
        executionId: String = "execution-a",
        retryDeliveryId: String? = nil,
        cancellableExecutionId: String? = nil
    ) -> ProjectExecutionDetail {
        ProjectExecutionDetail(
            projectId: "project-a",
            correlationId: "corr-a",
            workItem: ProjectExecutionDetail.WorkItem(
                ref: "github:issue/42", title: "Issue 42", issueNumber: 42,
                repositoryId: "Gasppacho/jarvis"),
            executions: [
                ProjectExecutionDetail.Execution(
                    id: executionId,
                    moduleInstanceId: "development",
                    status: status,
                    attempt: 1,
                    createdAt: t0,
                    error: status == .failed ? "failed" : nil,
                    completedAt: status == .running || status == .queued || status == .cancelling
                        ? nil : t0.addingTimeInterval(1),
                    inputEventId: "event-a",
                    durationMs: status == .running || status == .queued || status == .cancelling
                        ? nil : 1_000),
            ],
            steps: [],
            checks: [],
            agentExcerpts: [],
            workspace: nil,
            artifacts: nil,
            pullRequest: nil,
            lastEvent: nil,
            technical: ProjectExecutionDetail.Technical(
                inputEventIds: ["event-a"], correlationId: "corr-a", causationIds: [], events: []),
            failure: nil,
            retryDeliveryId: retryDeliveryId,
            cancellableExecutionId: cancellableExecutionId)
    }
}

private actor DetailProbe {
    private let detail: ProjectExecutionDetail
    private var shouldFail = false
    private var cancellationReleased = false
    private var recordedRetryIDs: [String] = []
    private var recordedCancellationIDs: [String] = []

    init(detail: ProjectExecutionDetail) {
        self.detail = detail
    }

    func load() throws -> ProjectExecutionDetail {
        if shouldFail { throw ProbeError.detailUnavailable }
        return detail
    }

    func failLoads() {
        shouldFail = true
    }

    func retry(_ deliveryId: String) -> TimelineExecution {
        recordedRetryIDs.append(deliveryId)
        return TimelineExecution(
            id: "execution-a", projectId: "project-a", moduleInstanceId: "development",
            status: .queued, attempt: 2, createdAt: Date(timeIntervalSince1970: 1_700_000_001))
    }

    func retryIDs() -> [String] {
        recordedRetryIDs
    }

    func cancel(_ executionId: String) async -> TimelineExecution {
        recordedCancellationIDs.append(executionId)
        while !cancellationReleased {
            await Task.yield()
        }
        return TimelineExecution(
            id: executionId, projectId: "project-a", moduleInstanceId: "development",
            status: .cancelling, attempt: 1, createdAt: Date(timeIntervalSince1970: 1_700_000_000))
    }

    func cancellationIDs() -> [String] {
        recordedCancellationIDs
    }

    func releaseCancellation() {
        cancellationReleased = true
    }
}

private enum ProbeError: Error, LocalizedError {
    case detailUnavailable

    var errorDescription: String? {
        "detail unavailable"
    }
}
