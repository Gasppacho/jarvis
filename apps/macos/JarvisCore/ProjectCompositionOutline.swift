import Foundation

/// The hierarchical outline #50 retained (docs/product/UX.md → "Graphe
/// émergent" → "Représentation retenue"): each Module Instance is a parent
/// row, its produced/consumed contracts and required capabilities are child
/// rows carrying their own routing status, and Project Slots form a separate
/// rail. Built only from `ProjectCompositionGraph` (#49) — no consumer,
/// compatibility or routing decision is recomputed here.
public struct ProjectCompositionOutline: Sendable, Equatable {
    public struct Row: Identifiable, Sendable, Equatable {
        public enum Role: Sendable, Equatable {
            case moduleInstance
            case contract
            case capability
        }

        public enum Direction: Sendable, Equatable {
            case produced
            case consumed
        }

        /// Qualified by Module Instance, role and index so no two rows in the
        /// whole outline collide, even when the same contract appears under
        /// more than one Module Instance (MISSION-0016's Ambiguous fixture).
        public let id: String
        /// 0 for a Module Instance parent row, 1 for a child row.
        public let depth: Int
        public let role: Role
        public let instanceId: String
        public let title: String
        public let direction: Direction?
        public let contractVersion: Int?
        public let statusLabel: String
        public let statusSymbol: String
        public let findings: [String]
        public let accessibilityLabel: String
    }

    public struct RailRow: Identifiable, Sendable, Equatable {
        public let id: String
        public let slot: String
        public let capability: String
        public let bindingRef: String?
        public let statusLabel: String
        public let statusSymbol: String
        public let findings: [String]
        public let accessibilityLabel: String
    }

    public let rows: [Row]
    public let rail: [RailRow]

    public init(graph: ProjectCompositionGraph) {
        var rows: [Row] = []
        for node in graph.nodes {
            rows.append(Self.moduleInstanceRow(node))
            for (edgeIndex, edge) in graph.edges.enumerated() {
                if edge.from.instanceId == node.instanceId {
                    rows.append(
                        Self.contractRow(
                            edge: edge, instanceId: node.instanceId, direction: .produced,
                            index: edgeIndex))
                }
                if edge.to?.instanceId == node.instanceId {
                    rows.append(
                        Self.contractRow(
                            edge: edge, instanceId: node.instanceId, direction: .consumed,
                            index: edgeIndex))
                }
            }
            for (railIndex, item) in graph.instanceRail.enumerated()
            where item.instanceId == node.instanceId {
                rows.append(Self.capabilityRow(item, index: railIndex))
            }
        }
        self.rows = rows
        rail = graph.slotRail.enumerated().map(Self.railRow)
    }

    private static func moduleInstanceRow(_ node: ProjectCompositionGraph.Node) -> Row {
        let statusLabel = node.enabled ? "Enabled" : "Disabled"
        return Row(
            id: "instance:\(node.instanceId)",
            depth: 0,
            role: .moduleInstance,
            instanceId: node.instanceId,
            title: node.displayName ?? node.moduleId,
            direction: nil,
            contractVersion: nil,
            statusLabel: statusLabel,
            statusSymbol: node.enabled ? "checkmark.circle" : "slash.circle",
            findings: node.findings,
            accessibilityLabel: "Module Instance \(node.instanceId), \(node.moduleId), \(statusLabel)")
    }

    private static func contractRow(
        edge: ProjectCompositionGraph.Edge,
        instanceId: String,
        direction: Row.Direction,
        index: Int
    ) -> Row {
        let statusLabel = routingLabel(edge)
        let contractName = "\(edge.contract.type).v\(edge.contract.version)"
        let kindLabel = edge.kind == .request ? "Request" : "Fact"
        return Row(
            id: "instance:\(instanceId):contract:\(direction == .produced ? "produced" : "consumed"):\(index)",
            depth: 1,
            role: .contract,
            instanceId: instanceId,
            title: "\(contractName) · \(kindLabel) · \(direction == .produced ? "Produced" : "Consumed")",
            direction: direction,
            contractVersion: edge.contract.version,
            statusLabel: statusLabel,
            statusSymbol: routingSymbol(edge),
            findings: edge.findings,
            accessibilityLabel:
                "\(contractName), \(kindLabel), \(direction == .produced ? "produced" : "consumed"), \(statusLabel)")
    }

    private static func capabilityRow(
        _ item: ProjectCompositionGraph.InstanceRailItem,
        index: Int
    ) -> Row {
        let statusLabel = capabilityStateLabel(item.state)
        return Row(
            id: "instance:\(item.instanceId):capability:\(index)",
            depth: 1,
            role: .capability,
            instanceId: item.instanceId,
            title: "Requires \(item.capability)",
            direction: nil,
            contractVersion: nil,
            statusLabel: statusLabel,
            statusSymbol: capabilitySymbol(item.state),
            findings: item.findings,
            accessibilityLabel: "Required capability \(item.capability), \(statusLabel)")
    }

    private static func railRow(
        index: Int,
        item: ProjectCompositionGraph.SlotRailItem
    ) -> RailRow {
        let statusLabel = capabilityStateLabel(item.state)
        return RailRow(
            id: "slot:\(item.slot):\(index)",
            slot: item.slot,
            capability: item.capability,
            bindingRef: item.bindingRef,
            statusLabel: statusLabel,
            statusSymbol: capabilitySymbol(item.state),
            findings: item.findings,
            accessibilityLabel: "Project Slot \(item.slot), requires \(item.capability), \(statusLabel)")
    }

    private static func routingLabel(_ edge: ProjectCompositionGraph.Edge) -> String {
        switch edge.kind {
        case .fact:
            guard let to = edge.to else { return "Broadcast — no consumer" }
            return "Broadcast → \(to.instanceId)"
        case .request:
            switch edge.routing {
            case .resolved(let consumer): return "Resolved → \(consumer.instanceId)"
            case .orphaned, .none: return "Orphaned — no consumer"
            case .ambiguous(let candidates):
                let names = candidates.map(\.instanceId).joined(separator: ", ")
                return "Ambiguous — \(names)"
            }
        }
    }

    private static func routingSymbol(_ edge: ProjectCompositionGraph.Edge) -> String {
        switch edge.kind {
        case .fact: return "arrow.triangle.branch"
        case .request:
            switch edge.routing {
            case .resolved: return "checkmark.circle.fill"
            case .orphaned, .none: return "exclamationmark.triangle.fill"
            case .ambiguous: return "questionmark.diamond.fill"
            }
        }
    }

    private static func capabilityStateLabel(_ state: ProjectCompositionGraph.CapabilityState) -> String {
        switch state {
        case .bound: "bound"
        case .unbound: "unbound"
        case .unresolved: "unresolved"
        }
    }

    private static func capabilitySymbol(_ state: ProjectCompositionGraph.CapabilityState) -> String {
        switch state {
        case .bound: "checkmark.circle.fill"
        case .unbound: "circle.dashed"
        case .unresolved: "exclamationmark.triangle.fill"
        }
    }
}
