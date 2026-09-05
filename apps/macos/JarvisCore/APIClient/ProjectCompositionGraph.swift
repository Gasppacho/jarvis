import Foundation
import JarvisAPI

/// The Engine-owned composition graph read model (#49), decoded from
/// `ProjectCompositionGraphV1` as-is. Nothing here recomputes a consumer,
/// a compatibility decision or a routing status: every field is copied
/// straight from the wire payload.
public struct ProjectCompositionGraph: Sendable, Equatable {
    public struct InstanceTarget: Sendable, Equatable {
        public let instanceId: String
        public let moduleId: String

        init(payload: Components.Schemas.ValidationInstanceTarget) {
            instanceId = payload.instanceId
            moduleId = payload.moduleId
        }
    }

    public struct Node: Identifiable, Sendable, Equatable {
        public var id: String { instanceId }
        public let instanceId: String
        public let moduleId: String
        public let enabled: Bool
        public let moduleVersion: String?
        public let displayName: String?
        /// Applicable finding codes (`project.instance-config-invalid`, ...).
        public let findings: [String]

        init(payload: Components.Schemas.ProjectCompositionGraphNodeV1) {
            instanceId = payload.instanceId
            moduleId = payload.moduleId
            enabled = payload.enabled
            moduleVersion = payload.moduleVersion
            displayName = payload.displayName
            findings = payload.findings
        }
    }

    public struct Contract: Sendable, Equatable {
        public enum Kind: Sendable, Equatable { case request, fact }
        public let type: String
        public let version: Int
        public let kind: Kind

        init(payload: Components.Schemas.ValidationContract) {
            type = payload._type
            version = payload.version
            let wireKind = wireString(payload.kind)
            switch wireKind {
            case "request": kind = .request
            case "fact": kind = .fact
            default: preconditionFailure("Generated contract kind drifted: \(wireKind)")
            }
        }
    }

    public enum Routing: Sendable, Equatable {
        case resolved(consumer: InstanceTarget)
        case orphaned
        case ambiguous(candidates: [InstanceTarget])
    }

    public struct Edge: Sendable, Equatable {
        public enum Kind: Sendable, Equatable { case request, fact }
        public let kind: Kind
        public let contract: Contract
        public let from: InstanceTarget
        /// Resolved request consumer or fact delivery consumer; nil for an
        /// unresolved (orphaned or ambiguous) request.
        public let to: InstanceTarget?
        /// Present on every request edge; facts are broadcast, not routed.
        public let routing: Routing?
        /// Applicable finding codes (`project.request-orphaned`, ...).
        public let findings: [String]

        init(payload: Components.Schemas.ProjectCompositionGraphEdgeV1) {
            kind = switch payload.kind {
            case .request: .request
            case .fact: .fact
            }
            contract = Contract(payload: payload.contract)
            from = InstanceTarget(payload: payload.from)
            to = payload.to.map(InstanceTarget.init(payload:))
            routing = payload.routing.map { routing in
                switch routing {
                case .case1(let resolved):
                    .resolved(consumer: InstanceTarget(payload: resolved.consumer))
                case .case2:
                    .orphaned
                case .case3(let ambiguous):
                    .ambiguous(candidates: ambiguous.candidates.map(InstanceTarget.init(payload:)))
                }
            }
            findings = payload.findings
        }
    }

    public enum CapabilityState: Sendable, Equatable { case bound, unbound, unresolved }

    /// A required capability rail entry not owned by a single Module Instance:
    /// a Project Slot, bound (or not) through Local Bindings.
    public struct SlotRailItem: Sendable, Equatable {
        public let slot: String
        public let capability: String
        public let bindingRef: String?
        public let state: CapabilityState
        /// Applicable finding codes (`project.binding-missing`, `project.capability-unresolved`).
        public let findings: [String]

        init(payload: Components.Schemas.ProjectCompositionGraphRailItemV1.Case1Payload) {
            slot = payload.slot
            capability = payload.capability
            bindingRef = payload.binding.map { "\($0.kind.rawValue)/\($0.ref)" }
            state = CapabilityState(payload: payload.state)
            findings = payload.findings
        }
    }

    /// A required capability rail entry owned by one Module Instance.
    public struct InstanceRailItem: Sendable, Equatable {
        public let instanceId: String
        public let capability: String
        public let bindingRef: String?
        public let state: CapabilityState
        /// Applicable finding codes (`project.capability-unresolved`).
        public let findings: [String]

        init(payload: Components.Schemas.ProjectCompositionGraphRailItemV1.Case2Payload) {
            instanceId = payload.instanceId
            capability = payload.capability
            bindingRef = payload.binding
            state = CapabilityState(payload: payload.state)
            findings = payload.findings
        }
    }

    public let projectId: String
    public let nodes: [Node]
    public let edges: [Edge]
    public let slotRail: [SlotRailItem]
    public let instanceRail: [InstanceRailItem]

    init(payload: Components.Schemas.ProjectCompositionGraphV1) {
        projectId = payload.projectId
        nodes = payload.nodes.map(Node.init(payload:))
        edges = payload.edges.map(Edge.init(payload:))
        var slotRail: [SlotRailItem] = []
        var instanceRail: [InstanceRailItem] = []
        for item in payload.rail {
            switch item {
            case .case1(let slotItem):
                slotRail.append(SlotRailItem(payload: slotItem))
            case .case2(let instanceItem):
                instanceRail.append(InstanceRailItem(payload: instanceItem))
            }
        }
        self.slotRail = slotRail
        self.instanceRail = instanceRail
    }
}

extension ProjectCompositionGraph.CapabilityState {
    init(payload: Components.Schemas.ProjectCompositionGraphRailItemV1.Case1Payload.statePayload) {
        self = switch payload {
        case .bound: .bound
        case .unbound: .unbound
        case .unresolved: .unresolved
        }
    }

    init(payload: Components.Schemas.ProjectCompositionGraphRailItemV1.Case2Payload.statePayload) {
        self = switch payload {
        case .bound: .bound
        case .unbound: .unbound
        case .unresolved: .unresolved
        }
    }
}
