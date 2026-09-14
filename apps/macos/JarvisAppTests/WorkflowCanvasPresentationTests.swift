import JarvisAPI
import XCTest

@testable import JarvisCore

final class WorkflowCanvasPresentationTests: XCTestCase {
    func testProjectsEngineEdgesWithoutInventingCycleEdges() throws {
        let graph = try decode("""
        {"apiVersion":"jarvis.dev/project-composition-graph/v1","kind":"ProjectCompositionGraph","projectId":"p",
         "nodes":[{"instanceId":"github","moduleId":"jarvis.module.github","enabled":true,"moduleVersion":"1","displayName":"GitHub","findings":[]},{"instanceId":"development","moduleId":"jarvis.module.development","enabled":true,"moduleVersion":"1","displayName":"Development","findings":[]}],
         "edges":[{"kind":"request","contract":{"type":"development.implementation.requested","version":1,"kind":"request"},"from":{"instanceId":"github","moduleId":"jarvis.module.github"},"to":{"instanceId":"development","moduleId":"jarvis.module.development"},"routing":{"status":"resolved","consumer":{"instanceId":"development","moduleId":"jarvis.module.development"}},"findings":[]},{"kind":"fact","contract":{"type":"scm.work-item.ready","version":1,"kind":"fact"},"from":{"instanceId":"development","moduleId":"jarvis.module.development"},"to":{"instanceId":"github","moduleId":"jarvis.module.github"},"findings":[]}],"rail":[],"findings":[]}
        """)
        let canvas = WorkflowCanvasPresentation(graph: graph)
        XCTAssertEqual(canvas.nodes.map(\.id), ["github", "development"])
        XCTAssertLessThan(canvas.nodes[0].x, canvas.nodes[1].x)
        XCTAssertEqual(canvas.edges.map(\.id), [
            "edge:0:request:github:development.implementation.requested:1",
            "edge:1:fact:development:scm.work-item.ready:1"])
        XCTAssertEqual(canvas.edges.compactMap(\.to), ["development", "github"])
        XCTAssertTrue(canvas.edges[0].compatibilityLabel.contains("request"))
        XCTAssertTrue(canvas.edges[0].triggerLabel.contains("resolved"))
    }

    func testKeepsDisabledNodeAndLeavesOrphanTargetEmpty() throws {
        let graph = try decode("""
        {"apiVersion":"jarvis.dev/project-composition-graph/v1","kind":"ProjectCompositionGraph","projectId":"p",
         "nodes":[{"instanceId":"github","moduleId":"jarvis.module.github","enabled":false,"moduleVersion":"1","displayName":"GitHub","findings":[]}],
         "edges":[{"kind":"request","contract":{"type":"development.implementation.requested","version":1,"kind":"request"},"from":{"instanceId":"github","moduleId":"jarvis.module.github"},"routing":{"status":"orphaned"},"findings":["project.request-orphaned"]}],"rail":[],"findings":[]}
        """)
        let canvas = WorkflowCanvasPresentation(graph: graph)
        XCTAssertEqual(canvas.nodes.map(\.enabled), [false])
        XCTAssertNil(canvas.edges.first?.to)
        XCTAssertTrue(canvas.edges.first?.accessibilityLabel.contains("orphaned") == true)
    }

    private func decode(_ json: String) throws -> ProjectCompositionGraph {
        ProjectCompositionGraph(payload: try JSONDecoder().decode(
            Components.Schemas.ProjectCompositionGraphV1.self, from: Data(json.utf8)))
    }
}
