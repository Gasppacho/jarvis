import Foundation
import JarvisAPI
import XCTest

@testable import JarvisCore

/// Ticket #18: the emergent graph is fetched through a fake provider, so the
/// valid, orphaned and ambiguous states are tested without a live Engine.
@MainActor
final class ProjectGraphModelTests: XCTestCase {
    func testValidGraphUsesEngineRowsAndIgnoresStaleSelection() async throws {
        let graph = try decode(Self.validFixture, projectId: "valid")
        let model = makeModel { _ in graph }

        await model.refresh(projectId: "valid")

        guard case .loaded(let loaded) = model.state(for: "valid") else {
            return XCTFail("expected a loaded graph")
        }
        let presentation = ProjectGraphPresentation(state: .loaded(loaded))
        XCTAssertEqual(presentation.status, .loaded)
        XCTAssertEqual(presentation.valid, true)
        XCTAssertEqual(
            presentation.outline?.rows.map(\.statusLabel),
            ["Enabled", "Resolved → worker", "Enabled", "Resolved → worker"])
        let firstRow = try XCTUnwrap(presentation.outline?.rows.first)
        XCTAssertTrue(firstRow.accessibilityLabel.contains("producer"))
        XCTAssertTrue(firstRow.accessibilityLabel.contains("Enabled"))
        XCTAssertEqual(
            presentation.outline?.rows.map(\.title),
            ["Producer", "work.requested.v1 · Request · Produced", "Worker", "work.requested.v1 · Request · Consumed"])
        XCTAssertNil(presentation.outline?.selectionDetail(forID: "stale-selection"))
        XCTAssertNil(model.state(for: "other-project"))
    }

    func testOrphanedGraphKeepsEngineIssueAndRoutingStatus() async throws {
        let graph = try decode(Self.orphanedFixture, projectId: "orphaned")
        let model = makeModel { _ in graph }

        await model.refresh(projectId: "orphaned")

        guard case .loaded(let loaded) = model.state(for: "orphaned") else {
            return XCTFail("expected a loaded graph")
        }
        let presentation = ProjectGraphPresentation(state: .loaded(loaded))
        XCTAssertEqual(presentation.valid, false)
        XCTAssertEqual(presentation.issues.map(\.code), ["project.request-orphaned"])
        XCTAssertEqual(presentation.outline?.rows.last?.statusLabel, "Orphaned — no consumer")
    }

    func testAmbiguousGraphPreservesCandidatesFromTheResponse() async throws {
        let graph = try decode(Self.ambiguousFixture, projectId: "ambiguous")
        let model = makeModel { _ in graph }

        await model.refresh(projectId: "ambiguous")

        guard case .loaded(let loaded) = model.state(for: "ambiguous") else {
            return XCTFail("expected a loaded graph")
        }
        let outline = try XCTUnwrap(ProjectGraphPresentation(state: .loaded(loaded)).outline)
        let request = try XCTUnwrap(
            outline.rows.first { $0.role == .contract && $0.direction == .produced })
        XCTAssertEqual(request.statusLabel, "Ambiguous — candidate-a, candidate-b")
        XCTAssertEqual(request.findings, ["project.request-ambiguous"])
    }

    func testEmptyResponseIsNeverActivatedAndProviderFailureIsScoped() async throws {
        let empty = try decode(Self.emptyFixture, projectId: "new")
        let emptyModel = makeModel { _ in empty }
        await emptyModel.refresh(projectId: "new")
        XCTAssertEqual(emptyModel.state(for: "new"), .neverActivated)
        XCTAssertEqual(
            ProjectGraphPresentation(state: .neverActivated).status, .neverActivated)

        let unavailable = ProjectGraphPresentation(state: .error("Engine is unavailable"))
        XCTAssertEqual(unavailable.status, .error("Engine is unavailable"))
        XCTAssertNil(unavailable.outline)

        let failedModel = makeModel { _ in throw FixtureError.failed }
        await failedModel.refresh(projectId: "broken")
        guard case .error = failedModel.state(for: "broken") else {
            return XCTFail("expected a scoped provider error")
        }
        XCTAssertNil(failedModel.state(for: "new"))
    }

    private enum FixtureError: Error { case failed }

    private func makeModel(
        provider: @escaping ProjectGraphModel.GraphProvider
    ) -> ProjectGraphModel {
        ProjectGraphModel(
            session: EngineSessionModel(supervisor: EngineSupervisor(resources: .developmentBuild())),
            provider: provider)
    }

    private func decode(_ json: String, projectId: String) throws -> ProjectGraph {
        ProjectGraph(
            projectId: projectId,
            payload: try JSONDecoder().decode(
                Components.Schemas.ProjectGraph.self, from: Data(json.utf8)))
    }

    private static let validFixture = """
        {
          "nodes":[
            {"instanceId":"producer","moduleId":"module.producer","enabled":true,"moduleVersion":"1.0.0","displayName":"Producer","findings":[]},
            {"instanceId":"worker","moduleId":"module.worker","enabled":true,"moduleVersion":"1.0.0","displayName":"Worker","findings":[]}
          ],
          "edges":[
            {"kind":"request","contract":{"type":"work.requested","version":1,"kind":"request"},"from":{"instanceId":"producer","moduleId":"module.producer"},"to":{"instanceId":"worker","moduleId":"module.worker"},"routing":{"status":"resolved","consumer":{"instanceId":"worker","moduleId":"module.worker"}},"findings":[]}
          ],
          "valid":true,
          "issues":[]
        }
        """

    private static let orphanedFixture = """
        {
          "nodes":[{"instanceId":"producer","moduleId":"module.producer","enabled":true,"moduleVersion":"1.0.0","displayName":"Producer","findings":[]}],
          "edges":[{"kind":"request","contract":{"type":"work.requested","version":1,"kind":"request"},"from":{"instanceId":"producer","moduleId":"module.producer"},"routing":{"status":"orphaned"},"findings":["project.request-orphaned"]}],
          "valid":false,
          "issues":[{"id":"f1","code":"project.request-orphaned","severity":"error","message":"No active consumer resolves this request.","target":{"kind":"project","field":"requestRoutes"}}]
        }
        """

    private static let ambiguousFixture = """
        {
          "nodes":[
            {"instanceId":"producer","moduleId":"module.producer","enabled":true,"moduleVersion":"1.0.0","displayName":"Producer","findings":[]},
            {"instanceId":"candidate-a","moduleId":"module.worker","enabled":true,"moduleVersion":"1.0.0","displayName":"Worker A","findings":[]},
            {"instanceId":"candidate-b","moduleId":"module.worker","enabled":true,"moduleVersion":"1.0.0","displayName":"Worker B","findings":[]}
          ],
          "edges":[{"kind":"request","contract":{"type":"work.requested","version":1,"kind":"request"},"from":{"instanceId":"producer","moduleId":"module.producer"},"routing":{"status":"ambiguous","candidates":[{"instanceId":"candidate-a","moduleId":"module.worker"},{"instanceId":"candidate-b","moduleId":"module.worker"}]},"findings":["project.request-ambiguous"]}],
          "valid":false,
          "issues":[{"id":"f1","code":"project.request-ambiguous","severity":"error","message":"More than one active consumer resolves this request.","target":{"kind":"project","field":"requestRoutes"}}]
        }
        """

    private static let emptyFixture = """
        {"nodes":[],"edges":[],"valid":true,"issues":[]}
        """
}
