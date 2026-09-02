import Foundation

/// Presentation-only fixture shaped around the versioned composition-choice response.
/// Routing status and explanations are supplied by the Engine; this value never derives routes.
public struct GuidedCompositionFixture: Sendable, Equatable {
    public enum State: Sendable, Equatable {
        case fresh
        case valid
        case orphaned
        case ambiguous
    }

    public struct ModuleInstance: Sendable, Equatable {
        public let instanceId: String
        public let displayName: String
        public let enabled: Bool

        public init(instanceId: String, displayName: String, enabled: Bool) {
            self.instanceId = instanceId
            self.displayName = displayName
            self.enabled = enabled
        }
    }

    public struct EventChoice: Sendable, Equatable {
        public enum Kind: String, Sendable, Equatable { case request, fact }
        public enum Routing: String, Sendable, Equatable {
            case broadcast
            case resolved
            case orphaned
            case ambiguous
        }

        public let id: String
        public let draftSentence: String
        public let kind: Kind
        public let routing: Routing
        public let routingExplanation: String

        public init(
            id: String,
            draftSentence: String,
            kind: Kind,
            routing: Routing,
            routingExplanation: String
        ) {
            self.id = id
            self.draftSentence = draftSentence
            self.kind = kind
            self.routing = routing
            self.routingExplanation = routingExplanation
        }
    }

    public struct ResourceBinding: Sendable, Equatable {
        public let slotId: String
        public let displayName: String
        public let selectedCandidate: String?
        public let eligibleCandidateCount: Int

        public init(
            slotId: String,
            displayName: String,
            selectedCandidate: String?,
            eligibleCandidateCount: Int
        ) {
            self.slotId = slotId
            self.displayName = displayName
            self.selectedCandidate = selectedCandidate
            self.eligibleCandidateCount = eligibleCandidateCount
        }
    }

    public let apiVersion = "jarvis.dev/project-composition-choices/v1"
    public let state: State
    public let projectName: String
    public let startingPoint: String?
    public let moduleInstances: [ModuleInstance]
    public let eventChoices: [EventChoice]
    public let resourceBindings: [ResourceBinding]

    public init(
        state: State,
        projectName: String,
        startingPoint: String?,
        moduleInstances: [ModuleInstance],
        eventChoices: [EventChoice],
        resourceBindings: [ResourceBinding]
    ) {
        self.state = state
        self.projectName = projectName
        self.startingPoint = startingPoint
        self.moduleInstances = moduleInstances
        self.eventChoices = eventChoices
        self.resourceBindings = resourceBindings
    }
}

public enum GuidedCompositionStage: String, CaseIterable, Sendable, Equatable {
    case startingPoint
    case moduleInstances
    case automationRules
    case resources
    case review
}

/// Data-driven content, action, keyboard, and accessibility inventory for the selected grammar.
/// A future SwiftUI surface may render this value but must not add routing policy to it.
public struct GuidedCompositionInventory: Sendable, Equatable {
    public enum Grammar: Sendable, Equatable { case guidedStages }
    public enum Status: Sendable, Equatable { case ready, needsAttention, blocked, informational }
    public enum Action: Sendable, Equatable {
        case chooseStartingPoint
        case addModuleInstance
        case editModuleInstance(String)
        case addRule
        case repairEvent(String)
        case bindResource(String)
        case reviewDraft
    }

    public struct Accessibility: Sendable, Equatable {
        public enum Role: String, Sendable, Equatable { case button, group, status }
        public let role: Role
        public let label: String
        public let value: String
        public let hint: String
    }

    public struct Row: Identifiable, Sendable, Equatable {
        public let id: String
        public let title: String
        public let detail: String
        public let status: Status
        public let action: Action?
        public let keyboardOrder: Int
        public let accessibility: Accessibility

        fileprivate func ordered(_ order: Int) -> Self {
            Self(
                id: id,
                title: title,
                detail: detail,
                status: status,
                action: action,
                keyboardOrder: order,
                accessibility: accessibility)
        }
    }

    public struct Section: Sendable, Equatable {
        public let stage: GuidedCompositionStage
        public let title: String
        public let rows: [Row]
    }

    public let grammar = Grammar.guidedStages
    public let fixtureState: GuidedCompositionFixture.State
    public let sections: [Section]
    public var rows: [Row] { sections.flatMap(\.rows) }

    public init(fixture: GuidedCompositionFixture) {
        fixtureState = fixture.state

        let starting = Self.row(
            id: "starting-point",
            title: fixture.startingPoint ?? "Choose a starting point",
            detail: fixture.startingPoint.map { "Selected: \($0)" }
                ?? "Start with GitHub Development or a Custom composition.",
            status: fixture.startingPoint == nil ? .needsAttention : .ready,
            action: .chooseStartingPoint,
            value: fixture.startingPoint ?? "Not selected",
            hint: "Choose a template or begin a Custom composition.")

        var modules = fixture.moduleInstances.map { module in
            Self.row(
                id: "module-\(module.instanceId)",
                title: module.displayName,
                detail: "Module Instance \(module.instanceId); \(module.enabled ? "enabled" : "disabled")",
                status: module.enabled ? .ready : .informational,
                action: .editModuleInstance(module.instanceId),
                value: module.enabled ? "Enabled" : "Disabled",
                hint: "Edit this Module Instance.")
        }
        modules.append(
            Self.row(
                id: "add-module",
                title: fixture.moduleInstances.isEmpty ? "Add your first Module Instance" : "Add Module Instance",
                detail: "Choose from Engine-provided Module Packages.",
                status: fixture.moduleInstances.isEmpty ? .needsAttention : .informational,
                action: .addModuleInstance,
                value: "\(fixture.moduleInstances.count) configured",
                hint: "Choose a Module Package to add."))

        var rules = fixture.eventChoices.map { event in
            Self.row(
                id: Self.eventRowID(event.id),
                title: event.draftSentence,
                detail: event.routingExplanation,
                status: Self.status(event.routing),
                action: event.routing == .orphaned || event.routing == .ambiguous
                    ? .repairEvent(event.id) : nil,
                value: "\(event.kind.rawValue.capitalized); \(event.routing.rawValue)",
                hint: event.routing == .orphaned || event.routing == .ambiguous
                    ? "Review Engine routing choices without replacing your sentence."
                    : "Review this Automation Rule." )
        }
        rules.append(
            Self.row(
                id: "add-rule",
                title: fixture.eventChoices.isEmpty ? "Add your first Automation Rule" : "Add Automation Rule",
                detail: "Build a sentence from Engine-provided Event choices.",
                status: fixture.eventChoices.isEmpty ? .needsAttention : .informational,
                action: .addRule,
                value: "\(fixture.eventChoices.count) configured",
                hint: "Add a sentence-style Automation Rule."))

        let resources: [Row]
        if fixture.resourceBindings.isEmpty {
            resources = [
                Self.row(
                    id: "resources-empty",
                    title: "No resource slots required",
                    detail: "Resource choices appear when a Module Instance requires one.",
                    status: .informational,
                    action: nil,
                    value: "No requirements",
                    hint: "Continue to Review or add a Module Instance.")
            ]
        } else {
            resources = fixture.resourceBindings.map { binding in
                let value = binding.selectedCandidate
                    ?? "Unbound; \(binding.eligibleCandidateCount) eligible choices"
                return Self.row(
                    id: "resource-\(binding.slotId)",
                    title: binding.displayName,
                    detail: binding.selectedCandidate.map { "Bound to \($0)." }
                        ?? (binding.eligibleCandidateCount == 0
                            ? "No eligible project-granted resource is available."
                            : "Choose an eligible project-granted resource."),
                    status: binding.selectedCandidate == nil ? .needsAttention : .ready,
                    action: .bindResource(binding.slotId),
                    value: value,
                    hint: "Choose or repair the Project-scoped resource binding.")
            }
        }

        let reviewStatus: Status = fixture.state == .valid ? .ready : .needsAttention
        let reviewValue = fixture.state == .valid ? "Ready" : "Needs attention"
        let review = Self.row(
            id: "review-draft",
            title: "Review \(fixture.projectName)",
            detail: fixture.state == .valid
                ? "Composition choices are ready for Engine validation."
                : "Review incomplete or conflicting choices before validation.",
            status: reviewStatus,
            action: .reviewDraft,
            value: reviewValue,
            hint: "Review Module Instances, Event paths, resources, and draft status.")

        let unordered = [
            Section(stage: .startingPoint, title: "Starting point", rows: [starting]),
            Section(stage: .moduleInstances, title: "Module Instances", rows: modules),
            Section(stage: .automationRules, title: "Automation Rules", rows: rules),
            Section(stage: .resources, title: "Resources", rows: resources),
            Section(stage: .review, title: "Review", rows: [review]),
        ]
        var order = 0
        sections = unordered.map { section in
            let ordered = section.rows.map { row in
                defer { order += 1 }
                return row.ordered(order)
            }
            return Section(stage: section.stage, title: section.title, rows: ordered)
        }
    }

    private static func row(
        id: String,
        title: String,
        detail: String,
        status: Status,
        action: Action?,
        value: String,
        hint: String
    ) -> Row {
        Row(
            id: id,
            title: title,
            detail: detail,
            status: status,
            action: action,
            keyboardOrder: 0,
            accessibility: Accessibility(
                role: action == nil ? .status : .button,
                label: title,
                value: value,
                hint: hint))
    }

    private static func status(_ routing: GuidedCompositionFixture.EventChoice.Routing) -> Status {
        switch routing {
        case .resolved: return .ready
        case .broadcast: return .informational
        case .orphaned: return .needsAttention
        case .ambiguous: return .blocked
        }
    }

    private static func eventRowID(_ id: String) -> String {
        let meaningful = id.split(separator: ".").filter { $0 != "implementation" && $0 != "v1" }
        return "event-\(meaningful.joined(separator: "-"))"
    }
}
