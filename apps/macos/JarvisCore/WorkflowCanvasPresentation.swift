import Foundation

public struct WorkflowCatalogPresentation: Sendable, Equatable {
    public struct Item: Identifiable, Sendable, Equatable {
        public let id: String
        public let title: String
        public let description: String
        public let systemImage: String
        public let isAvailable: Bool
        public let isSelected: Bool
    }

    public let items: [Item]

    public init(availableModuleIDs: [String], selectedModuleIDs: [String]) {
        let available = Set(availableModuleIDs)
        let selected = Set(selectedModuleIDs)
        items = [
            Item(
                id: "jarvis.module.github",
                title: "GitHub",
                description: "Observe le dépôt et publie les changements.",
                systemImage: "chevron.left.forwardslash.chevron.right",
                isAvailable: available.contains("jarvis.module.github"),
                isSelected: selected.contains("jarvis.module.github")),
            Item(
                id: "jarvis.module.development",
                title: "Développeur",
                description: "Réalise le travail avec la CLI d’agent choisie.",
                systemImage: "hammer",
                isAvailable: available.contains("jarvis.module.development"),
                isSelected: selected.contains("jarvis.module.development")),
            Item(
                id: "jarvis.module.pull-request",
                title: "Pull Request",
                description: "Prépare le titre et la description de la PR après le développement.",
                systemImage: "arrow.triangle.pull",
                isAvailable: available.contains("jarvis.module.pull-request"),
                isSelected: selected.contains("jarvis.module.pull-request")),
        ]
    }
}

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
    public var connections: [Edge] { edges.filter { $0.to != nil && $0.from != $0.to } }
    public var unconnectedOutputs: [Edge] { edges.filter { $0.to == nil } }

    public init(graph: ProjectCompositionGraph) {
        let ordered = graph.nodes.sorted { $0.instanceId < $1.instanceId }
        let fixedOrder = ["github", "development", "pull-request"]
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
                title: node.moduleId == "jarvis.module.development" ? "Développement" : node.displayName ?? node.moduleId,
                moduleId: node.moduleId,
                enabled: node.enabled,
                x: position.0,
                y: position.1,
                accessibilityLabel: "Module \(node.displayName ?? node.moduleId), \(node.enabled ? "activé" : "désactivé")")
        }
        edges = graph.edges.enumerated().map { index, edge in
            let route: String
            switch edge.routing {
            case .resolved(let consumer): route = "vers \(consumer.instanceId)"
            case .orphaned: route = "Non connecté"
            case .ambiguous(let candidates): route = "plusieurs destinataires : \(candidates.map(\.instanceId).joined(separator: ", "))"
            case .none: route = edge.to.map { "diffusion vers \($0.instanceId)" } ?? "Non connecté"
            }
            return Edge(
                id: "edge:\(index):\(edge.kind):\(edge.from.instanceId):\(edge.contract.type):\(edge.contract.version)",
                from: edge.from.instanceId,
                to: edge.to?.instanceId,
                kind: edge.kind,
                contractType: edge.contract.type,
                contractVersion: edge.contract.version,
                label: Self.eventName(edge.contract.type),
                compatibilityLabel: "\(edge.contract.type).v\(edge.contract.version) · \(edge.kind == .request ? "demande" : "fait")",
                triggerLabel: edge.to == nil
                    ? "Non connecté"
                    : edge.contract.type == "scm.work-item.observed"
                    ? "Développement contrôle le label, la portée et les dépendances avant tout départ."
                    : "Routage : \(route)",
                accessibilityLabel: "\(Self.eventName(edge.contract.type)), \(route)")
        }
    }

    private static func eventName(_ type: String) -> String {
        switch type {
        case "scm.work-item.observed": "Observation des issues"
        case "scm.change-request.creation-requested": "Demande de Pull Request"
        case "scm.change-request.created": "Pull Request créée"
        case "scm.change-request.creation-failed": "Création de Pull Request échouée"
        case "development.implementation.requested": "Demande interne de développement"
        case "development.implementation.completed": "Développement terminé"
        case "development.implementation.failed": "Développement échoué"
        case "scm.work-item.tags-changed": "Labels modifiés"
        case "scm.work-item.tags-change-failed": "Modification des labels échouée"
        case "scm.work-item.ready": "Éligibilité historique"
        case "scm.work-item.tag-added": "Label ajouté (historique)"
        default: "Événement du module"
        }
    }
}
