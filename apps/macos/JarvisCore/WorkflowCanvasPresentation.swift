import Foundation

/// Fixed composition canvas projection. The Engine owns nodes, edges, contracts
/// and routing; this shell owns only deterministic coordinates and display text.
public struct WorkflowCanvasPresentation: Sendable, Equatable {
    public struct Node: Identifiable, Sendable, Equatable {
        public let id: String
        public let title: String
        public let moduleId: String
        public let enabled: Bool
        public let x: Double
        public let y: Double
        public let accessibilityLabel: String
    }

    public struct Edge: Identifiable, Sendable, Equatable {
        public let id: String
        public let from: String
        public let to: String?
        public let kind: ProjectCompositionGraph.Edge.Kind
        public let contractType: String
        public let contractVersion: Int
        public let label: String
        public let compatibilityLabel: String
        public let triggerLabel: String
        public let accessibilityLabel: String
    }

    public let nodes: [Node]
    public let edges: [Edge]

    public init(graph: ProjectCompositionGraph) {
        let ordered = graph.nodes.sorted { $0.instanceId < $1.instanceId }
        let fixedOrder = ["github", "development"]
        let order = ordered.sorted {
            let left = fixedOrder.firstIndex(of: $0.moduleId.replacingOccurrences(of: "jarvis.module.", with: "")) ?? fixedOrder.count
            let right = fixedOrder.firstIndex(of: $1.moduleId.replacingOccurrences(of: "jarvis.module.", with: "")) ?? fixedOrder.count
            return left == right ? $0.instanceId < $1.instanceId : left < right
        }
        let radius = min(0.32, max(0, Double(order.count - 1) * 0.12 + 0.08))
        nodes = order.enumerated().map { index, node in
            let angle = order.isEmpty ? 0 : (Double(index) / Double(order.count)) * 2 * .pi - .pi / 2
            let position: (Double, Double) = switch order.count {
            case 0: (0.5, 0.5)
            case 1: (0.5, 0.5)
            case 2: (index == 0 ? 0.25 : 0.75, 0.5)
            default: (0.5 + radius * cos(angle), 0.5 + radius * sin(angle))
            }
            return Node(
                id: node.instanceId,
                title: node.displayName ?? node.moduleId,
                moduleId: node.moduleId,
                enabled: node.enabled,
                x: position.0,
                y: position.1,
                accessibilityLabel: "Module \(node.displayName ?? node.moduleId), \(node.enabled ? "enabled" : "disabled")")
        }
        edges = graph.edges.enumerated().map { index, edge in
            let route: String
            switch edge.routing {
            case .resolved(let consumer): route = "resolved to \(consumer.instanceId)"
            case .orphaned: route = "orphaned, no consumer"
            case .ambiguous(let candidates): route = "ambiguous: \(candidates.map(\.instanceId).joined(separator: ", "))"
            case .none: route = edge.kind == .fact ? "broadcast" : "unresolved"
            }
            return Edge(
                id: "edge:\(index):\(edge.kind):\(edge.from.instanceId):\(edge.contract.type):\(edge.contract.version)",
                from: edge.from.instanceId,
                to: edge.to?.instanceId,
                kind: edge.kind,
                contractType: edge.contract.type,
                contractVersion: edge.contract.version,
                label: "\(edge.contract.type).v\(edge.contract.version)",
                compatibilityLabel: "Engine contract \(edge.contract.type).v\(edge.contract.version) (\(edge.kind == .request ? "request" : "fact"))",
                triggerLabel: edge.kind == .request ? "Engine routing: \(route)" : "Engine broadcast delivery",
                accessibilityLabel: "\(edge.kind == .request ? "Request" : "Fact") \(edge.contract.type), \(route)")
        }
    }
}
