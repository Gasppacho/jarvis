import Foundation
import JarvisAPI

/// The Engine-owned emergent graph returned by
/// `GET /v1/projects/{projectId}/graph`. It is a wire-to-domain mapping only:
/// routing, findings and validity remain the Engine's values.
public struct ProjectGraph: Sendable, Equatable {
    public struct Issue: Identifiable, Sendable, Equatable {
        public let id: String
        public let code: String
        public let severity: String
        public let message: String

        init(payload: Components.Schemas.ProjectCompositionGraphFindingV1) {
            id = payload.id
            code = wireString(payload.code)
            severity = wireString(payload.severity)
            message = payload.message
        }
    }

    public let projectId: String
    public let nodes: [ProjectCompositionGraph.Node]
    public let edges: [ProjectCompositionGraph.Edge]
    public let valid: Bool
    public let issues: [Issue]

    init(projectId: String, payload: Components.Schemas.ProjectGraph) {
        self.projectId = projectId
        nodes = payload.nodes.map(ProjectCompositionGraph.Node.init(payload:))
        edges = payload.edges.map(ProjectCompositionGraph.Edge.init(payload:))
        valid = payload.valid
        issues = payload.issues.map(Issue.init(payload:))
    }

    var isNeverActivated: Bool {
        nodes.isEmpty && edges.isEmpty && issues.isEmpty
    }

    var compositionGraph: ProjectCompositionGraph {
        ProjectCompositionGraph(projectId: projectId, nodes: nodes, edges: edges)
    }
}

extension ProjectCompositionGraph {
    init(projectId: String, nodes: [Node], edges: [Edge]) {
        self.projectId = projectId
        self.nodes = nodes
        self.edges = edges
        slotRail = []
        instanceRail = []
    }
}

extension ProjectCompositionOutline {
    /// Reuses the composition outline grammar for the rail-free emergent
    /// graph. Every row still comes from the Engine response.
    public init(graph: ProjectGraph) {
        self.init(graph: graph.compositionGraph)
    }
}
