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

    /// A pure projection from a row's or rail entry's unique id to what #52
    /// asks a selection to reveal: stable identifiers, contract version,
    /// routing status and applicable findings. Every field is copied from
    /// `ProjectCompositionGraph` (or the row built from it) - selecting never
    /// recomputes a consumer, a compatibility decision or a routing status.
    public struct SelectionDetail: Identifiable, Sendable, Equatable {
        public enum Kind: Sendable, Equatable {
            case moduleInstance
            case producedContract
            case consumedContract
            case capability
            case railEntry
        }

        public let id: String
        public let kind: Kind
        /// The owning Module Instance's stable id (nil for a rail entry, which
        /// is keyed by Project Slot instead).
        public let instanceId: String?
        /// The Module Instance's Module Package id (Module Instance rows only).
        public let moduleId: String?
        /// The Project Slot name (rail entries only).
        public let slot: String?
        /// The required capability identifier (capability rows and rail entries).
        public let capability: String?
        /// The event contract's type identifier (contract rows only).
        public let contractType: String?
        public let contractVersion: Int?
        public let bindingRef: String?
        public let statusLabel: String
        public let findings: [String]
        public let accessibilityLabel: String
    }

    public let rows: [Row]
    public let rail: [RailRow]
    public let selectionDetails: [String: SelectionDetail]

    public init(graph: ProjectCompositionGraph) {
        var rows: [Row] = []
        var details: [String: SelectionDetail] = [:]
        for node in graph.nodes {
            let (row, detail) = Self.moduleInstanceRow(node)
            rows.append(row)
            details[row.id] = detail
            for (edgeIndex, edge) in graph.edges.enumerated() {
                if edge.from.instanceId == node.instanceId {
                    let (row, detail) = Self.contractRow(
                        edge: edge, instanceId: node.instanceId, direction: .produced,
                        index: edgeIndex)
                    rows.append(row)
                    details[row.id] = detail
                }
                if edge.to?.instanceId == node.instanceId {
                    let (row, detail) = Self.contractRow(
                        edge: edge, instanceId: node.instanceId, direction: .consumed,
                        index: edgeIndex)
                    rows.append(row)
                    details[row.id] = detail
                }
            }
            for (railIndex, item) in graph.instanceRail.enumerated()
            where item.instanceId == node.instanceId {
                let (row, detail) = Self.capabilityRow(item, index: railIndex)
                rows.append(row)
                details[row.id] = detail
            }
        }
        self.rows = rows
        let railRows = graph.slotRail.enumerated().map(Self.railRow)
        rail = railRows.map(\.0)
        for (railRow, detail) in railRows {
            details[railRow.id] = detail
        }
        selectionDetails = details
    }

    /// The detail for a selected row or rail entry id, or `nil` for an
    /// unknown or stale id - never a crash.
    public func selectionDetail(forID id: String) -> SelectionDetail? {
        selectionDetails[id]
    }

    private static func moduleInstanceRow(
        _ node: ProjectCompositionGraph.Node
    ) -> (Row, SelectionDetail) {
        let statusLabel = node.enabled ? "Enabled" : "Disabled"
        let id = "instance:\(node.instanceId)"
        let accessibilityLabel = "Module Instance \(node.instanceId), \(node.moduleId), \(statusLabel)"
        let row = Row(
            id: id,
            depth: 0,
            role: .moduleInstance,
            instanceId: node.instanceId,
            title: node.displayName ?? node.moduleId,
            direction: nil,
            contractVersion: nil,
            statusLabel: statusLabel,
            statusSymbol: node.enabled ? "checkmark.circle" : "slash.circle",
            findings: node.findings,
            accessibilityLabel: accessibilityLabel)
        let detail = SelectionDetail(
            id: id,
            kind: .moduleInstance,
            instanceId: node.instanceId,
            moduleId: node.moduleId,
            slot: nil,
            capability: nil,
            contractType: nil,
            contractVersion: nil,
            bindingRef: nil,
            statusLabel: statusLabel,
            findings: node.findings,
            accessibilityLabel: accessibilityLabel)
        return (row, detail)
    }

    private static func contractRow(
        edge: ProjectCompositionGraph.Edge,
        instanceId: String,
        direction: Row.Direction,
        index: Int
    ) -> (Row, SelectionDetail) {
        let statusLabel = routingLabel(edge)
        let contractName = "\(edge.contract.type).v\(edge.contract.version)"
        let kindLabel = edge.kind == .request ? "Request" : "Fact"
        let id = "instance:\(instanceId):contract:\(direction == .produced ? "produced" : "consumed"):\(index)"
        let accessibilityLabel =
            "\(contractName), \(kindLabel), \(direction == .produced ? "produced" : "consumed"), \(statusLabel)"
        let row = Row(
            id: id,
            depth: 1,
            role: .contract,
            instanceId: instanceId,
            title: "\(contractName) · \(kindLabel) · \(direction == .produced ? "Produced" : "Consumed")",
            direction: direction,
            contractVersion: edge.contract.version,
            statusLabel: statusLabel,
            statusSymbol: routingSymbol(edge),
            findings: edge.findings,
            accessibilityLabel: accessibilityLabel)
        let detail = SelectionDetail(
            id: id,
            kind: direction == .produced ? .producedContract : .consumedContract,
            instanceId: instanceId,
            moduleId: nil,
            slot: nil,
            capability: nil,
            contractType: edge.contract.type,
            contractVersion: edge.contract.version,
            bindingRef: nil,
            statusLabel: statusLabel,
            findings: edge.findings,
            accessibilityLabel: accessibilityLabel)
        return (row, detail)
    }

    private static func capabilityRow(
        _ item: ProjectCompositionGraph.InstanceRailItem,
        index: Int
    ) -> (Row, SelectionDetail) {
        let statusLabel = capabilityStateLabel(item.state)
        let id = "instance:\(item.instanceId):capability:\(index)"
        let accessibilityLabel = "Required capability \(item.capability), \(statusLabel)"
        let row = Row(
            id: id,
            depth: 1,
            role: .capability,
            instanceId: item.instanceId,
            title: "Requires \(item.capability)",
            direction: nil,
            contractVersion: nil,
            statusLabel: statusLabel,
            statusSymbol: capabilitySymbol(item.state),
            findings: item.findings,
            accessibilityLabel: accessibilityLabel)
        let detail = SelectionDetail(
            id: id,
            kind: .capability,
            instanceId: item.instanceId,
            moduleId: nil,
            slot: nil,
            capability: item.capability,
            contractType: nil,
            contractVersion: nil,
            bindingRef: item.bindingRef,
            statusLabel: statusLabel,
            findings: item.findings,
            accessibilityLabel: accessibilityLabel)
        return (row, detail)
    }

    private static func railRow(
        index: Int,
        item: ProjectCompositionGraph.SlotRailItem
    ) -> (RailRow, SelectionDetail) {
        let statusLabel = capabilityStateLabel(item.state)
        let id = "slot:\(item.slot):\(index)"
        let accessibilityLabel = "Project Slot \(item.slot), requires \(item.capability), \(statusLabel)"
        let railRow = RailRow(
            id: id,
            slot: item.slot,
            capability: item.capability,
            bindingRef: item.bindingRef,
            statusLabel: statusLabel,
            statusSymbol: capabilitySymbol(item.state),
            findings: item.findings,
            accessibilityLabel: accessibilityLabel)
        let detail = SelectionDetail(
            id: id,
            kind: .railEntry,
            instanceId: nil,
            moduleId: nil,
            slot: item.slot,
            capability: item.capability,
            contractType: nil,
            contractVersion: nil,
            bindingRef: item.bindingRef,
            statusLabel: statusLabel,
            findings: item.findings,
            accessibilityLabel: accessibilityLabel)
        return (railRow, detail)
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
