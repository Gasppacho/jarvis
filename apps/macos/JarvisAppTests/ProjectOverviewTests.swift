import Foundation
import JarvisAPI
import XCTest

@testable import JarvisCore

/// Tickets #199/#201: Overview is a read model. These fixtures prove that the
/// shell keeps every Engine eligibility reason, native blocker and polling
/// state readable without reconstructing policy locally.
@MainActor
final class ProjectOverviewTests: XCTestCase {
    func testFixtureMapsStatusesReasonsBlockersAndPolling() throws {
        let overview = try decode(Self.fixedFixture)

        XCTAssertEqual(overview.status, .degraded)
        XCTAssertEqual(overview.primaryAction, .refresh)
        XCTAssertEqual(overview.polling.state, .failed)
        XCTAssertEqual(overview.polling.lastPollAt, Date(timeIntervalSince1970: 1_700_000_000))
        XCTAssertEqual(overview.polling.errorReason, "GitHub returned HTTP 503")
        XCTAssertEqual(overview.stages.map(\.id), [.github, .development, .pullRequest])
        XCTAssertEqual(overview.issues.map(\.status), [
            .eligible, .waiting, .inProgress, .blocked, .ineligible, .unavailable,
        ])

        let blocked = try XCTUnwrap(overview.issues.first { $0.status == .blocked })
        XCTAssertEqual(blocked.issueNumber, 4)
        XCTAssertEqual(blocked.reason, "open-native-blockers")
        XCTAssertEqual(
            blocked.explanation,
            "Blocked by two open GitHub native dependencies.")
        XCTAssertEqual(blocked.openDependencyCount, 2)
        XCTAssertEqual(
            blocked.blockerRefs,
            [
                "github://owner/repo/issues/10",
                "github://owner/repo/issues/11",
            ])
        XCTAssertEqual(
            ProjectOverviewPresentation.issueStatusLabel(blocked.status),
            "Bloquée par des dépendances")
        XCTAssertEqual(
            ProjectOverviewPresentation.pollingLabel(overview.polling.state),
            "Connexion en échec")
    }

    func testLegacyOverviewUsesFixedMigrationStagesOnly() throws {
        let overview = try decode(Self.fixture)
        XCTAssertEqual(overview.stages.map(\.id), [.github, .development, .pullRequest])
    }

    func testRefreshFailureKeepsTheLastSnapshotAsStale() async throws {
        let snapshot = try decode(Self.fixture)
        let attempts = CallCounter()
        let model = ProjectOverviewModel(
            session: EngineSessionModel(
                supervisor: EngineSupervisor(resources: .developmentBuild())),
            provider: { _ in
                let attempt = await attempts.next()
                if attempt == 1 { return snapshot }
                if attempt == 2 { throw FixtureError.offline }
                try await Task.sleep(for: .milliseconds(60))
                return snapshot
            })

        await model.refresh(projectId: snapshot.projectId)
        XCTAssertEqual(model.state(for: snapshot.projectId).overview, snapshot)

        await model.refresh(projectId: snapshot.projectId)

        let state = model.state(for: snapshot.projectId)
        XCTAssertEqual(state.overview, snapshot)
        XCTAssertFalse(state.isLoading)
        XCTAssertNotNil(state.errorMessage)
        XCTAssertEqual(
            ProjectOverviewPresentation(state).state,
            .stale(snapshot, state.errorMessage ?? ""))
        let retry = Task { await model.refresh(projectId: snapshot.projectId) }
        while !model.state(for: snapshot.projectId).isLoading { await Task.yield() }
        XCTAssertNotNil(model.state(for: snapshot.projectId).errorMessage, "A pending retry must keep the stale warning")
        await retry.value
        XCTAssertNil(model.state(for: snapshot.projectId).errorMessage)
    }

    func testInitialFailureIsSeparateFromAStaleSnapshot() async {
        let model = ProjectOverviewModel(
            session: EngineSessionModel(
                supervisor: EngineSupervisor(resources: .developmentBuild())),
            provider: { _ in throw FixtureError.offline })

        await model.refresh(projectId: "offline")

        let state = model.state(for: "offline")
        XCTAssertNil(state.overview)
        XCTAssertFalse(state.isLoading)
        guard case .failed = ProjectOverviewPresentation(state).state else {
            return XCTFail("an initial provider failure must render as failed")
        }
    }

    func testFocusPrefersActiveWorkAndKeepsFailureAfterEligibilityChanges() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        var payload = try decoder.decode(Components.Schemas.ProjectOverviewV1.self, from: Data(Self.fixture.utf8))
        payload.selectedWorkItemRef = "github://owner/repo/issues/3"
        payload.issues[2].executionId = "active"
        payload.issues[2].lastExecutionStatus = .running
        payload.issues[4].executionId = "failed"
        payload.issues[4].lastExecutionStatus = .failed
        payload.issues[4].executionStartedAt = Date()
        let active = ProjectOverview(payload: payload)
        XCTAssertEqual(active.selectedWorkItemRef, "github://owner/repo/issues/3")
        XCTAssertEqual(ProjectOverviewPresentation.focusedIssue(active)?.executionId, "active")
        payload.issues[2].executionId = nil
        let failed = ProjectOverview(payload: payload)
        let focused = try XCTUnwrap(ProjectOverviewPresentation.focusedIssue(failed))
        XCTAssertEqual(focused.executionId, "failed")
        XCTAssertEqual(focused.status, .ineligible)
        XCTAssertEqual(ProjectOverviewPresentation.workStatusLabel(focused), "Échec à examiner")
    }

    func testAnotherProjectsOverviewIsRejected() async throws {
        let snapshot = try decode(Self.fixture)
        let model = ProjectOverviewModel(session: EngineSessionModel(supervisor: EngineSupervisor(resources: .developmentBuild())), provider: { _ in snapshot })
        await model.refresh(projectId: "other")
        XCTAssertNil(model.state(for: "other").overview)
        XCTAssertNotNil(model.state(for: "other").errorMessage)
    }

    private func decode(_ json: String) throws -> ProjectOverview {
        let decoder = JSONDecoder()
        let transcoder = FlexibleISO8601DateTranscoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            return try transcoder.decode(container.decode(String.self))
        }
        let payload = try decoder.decode(
            Components.Schemas.ProjectOverviewV1.self,
            from: Data(json.utf8))
        return ProjectOverview(payload: payload)
    }

    private enum FixtureError: Error, Sendable {
        case offline
    }

    private static let fixture = """
        {
          "apiVersion":"jarvis.dev/project-overview/v1",
          "kind":"ProjectOverview",
          "projectId":"project-199",
          "name":"Jarvis",
          "status":"degraded",
          "primaryAction":"refresh",
          "polling":{"state":"failed","lastPollAt":"2023-11-14T22:13:20Z","errorReason":"GitHub returned HTTP 503"},
          "workflow":{
            "available":true,
            "stages":[
              {"id":"github","label":"GitHub","status":"ready","detail":"Repository connected"},
              {"id":"development","label":"Development","status":"active","detail":"One issue is running"},
              {"id":"pull-request","label":"Pull Request","status":"waiting","detail":"The next expected state is a pull request"}
            ],
            "nextStep":"Retry GitHub polling"
          },
          "issues":[
            {"workItemRef":"github://owner/repo/issues/1","title":"Ready issue","issueNumber":1,"repositoryId":"main","status":"eligible","reason":"ready","explanation":"Ready to start.","openDependencyCount":0,"blockerRefs":[],"readinessLabel":"ready-to-dev"},
            {"workItemRef":"github://owner/repo/issues/2","title":"Missing label","issueNumber":2,"repositoryId":"main","status":"waiting","reason":"ready-label-missing","explanation":"Waiting for the readiness label.","openDependencyCount":0,"blockerRefs":[],"readinessLabel":"ready-to-dev"},
            {"workItemRef":"github://owner/repo/issues/3","title":"Active issue","issueNumber":3,"repositoryId":"main","status":"in-progress","reason":"execution-active","explanation":"An execution is already active.","openDependencyCount":0,"blockerRefs":[],"readinessLabel":"ready-to-dev"},
            {"workItemRef":"github://owner/repo/issues/4","title":"Blocked issue","issueNumber":4,"repositoryId":"main","status":"blocked","reason":"open-native-blockers","explanation":"Blocked by two open GitHub native dependencies.","openDependencyCount":2,"blockerRefs":["github://owner/repo/issues/10","github://owner/repo/issues/11"],"readinessLabel":"ready-to-dev"},
            {"workItemRef":"github://owner/repo/issues/5","title":"Wrong label","issueNumber":5,"repositoryId":"main","status":"ineligible","reason":"readiness-label-mismatch","explanation":"This issue does not have the configured readiness label.","openDependencyCount":0,"blockerRefs":[],"readinessLabel":"ready-to-dev"},
            {"workItemRef":"github://owner/repo/issues/6","title":"Unavailable issue","issueNumber":6,"repositoryId":"main","status":"unavailable","reason":"github-request-failed","explanation":"Jarvis could not verify this issue.","openDependencyCount":0,"blockerRefs":[],"readinessLabel":"ready-to-dev"}
          ],
          "activeExecutionCount":1,
          "activeWorkItemRefs":["github://owner/repo/issues/3"],
          "readinessHelp":"The readiness label is ready-to-dev."
        }
        """

    private static let fixedFixture = fixture
}

private actor CallCounter {
    private var count = 0

    func next() -> Int {
        count += 1
        return count
    }
}
