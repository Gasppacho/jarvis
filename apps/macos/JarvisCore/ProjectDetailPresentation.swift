import Foundation

/// Complete, data-driven content and action inventory rendered by ProjectDetailView.
/// SwiftUI owns only bindings and side-effect handlers; this value is testable in JarvisCore.
public struct ProjectDetailPresentation: Sendable, Equatable {
    public struct Slot: Identifiable, Sendable, Equatable {
        public let id: String
        public let requirement: String
        public let optional: Bool
        public let description: String?
        public let candidates: [ProjectResourceCandidate]
    }

    public struct ResourceBinding: Identifiable, Sendable, Equatable {
        public let id: String
        public let requiredCapabilities: [String]
        public let candidates: [ProjectResourceCandidate]
        public let selectedCandidateID: String?
        public let status: ProjectResourceBindingStatus
        public let unavailableExplanation: String
        public let impact: String
        public let repairAction: String
        public let accessibilityLabel: String
        public let accessibilityHint: String
    }

    public struct StartingPoint: Identifiable, Sendable, Equatable {
        public let id: String
        public let displayName: String
        public let description: String
        public let action: Action.Edit
    }

    public struct ModuleCard: Identifiable, Sendable, Equatable {
        public let id: UUID
        public let displayName: String
        public let description: String
        public let eventSummary: String
        public let requiredCapabilities: String
        public let compatibility: String
        public let missingResources: String
        public let technicalDetails: String
    }

    public struct AutomationEventOption: Identifiable, Sendable, Equatable {
        public var id: String { "\(type).v\(version).\(kind)" }
        public let label: String
        public let type: String
        public let version: Int
        public let kind: String
        public let detail: String
        public let routingStatus: String
        public let routingExplanation: String
        public let selectedConsumerID: String?
        public let compatibleConsumerInstanceIDs: [String]
    }

    public struct AutomationRuleRow: Identifiable, Sendable, Equatable {
        public enum SelectionStatus: Sendable, Equatable { case known, unknown }

        public let id: UUID
        public let moduleID: UUID
        public let ruleID: String
        public let inputEventType: String
        public let matchJSON: String
        public let emissionEventType: String
        public let payloadJSON: String
        public let target: AutomationRuleDraft.Target
        public let targetChoices: [String]
        public let inputChoices: [AutomationEventOption]
        public let emissionChoices: [AutomationEventOption]
        public let inputStatus: SelectionStatus
        public let emissionStatus: SelectionStatus
        public let inputHint: String
        public let emissionHint: String
        public let routingStatus: String
        public let routingExplanation: String
        public let sentence: String
    }

    public struct ReviewRow: Identifiable, Sendable, Equatable {
        public enum Category: String, CaseIterable, Sendable, Equatable {
            case module = "Module Instances"
            case eventPath = "Event paths"
            case capability = "Capabilities"
            case binding = "Local Bindings"
            case finding = "Needs repair"
        }

        public enum Status: String, Sendable, Equatable {
            case ready = "Ready"
            case informational = "Information"
            case needsAttention = "Needs attention"
        }

        public let id: String
        public let category: Category
        public let title: String
        public let detail: String
        public let status: Status
        public let repairAction: String?
        public let navigationTarget: String?
        public let accessibilityLabel: String
        public let accessibilityHint: String
    }

    public struct Validation: Sendable, Equatable {
        public enum Status: Sendable, Equatable {
            case unvalidated, validating, valid, invalid, stale, failed
        }

        public struct Finding: Identifiable, Sendable, Equatable {
            public let id: String
            public let code: String
            public let targetKind: ProjectValidationFinding.Target.Kind
            public let reference: String
            public let unavailable: String
            public let impact: String
            public let correctiveAction: String
            public let diagnostic: String
            public let accessibilityLabel: String
        }

        public struct RequestRoute: Identifiable, Sendable, Equatable {
            public let id: String
            public let contractIdentity: String
            public let route: String
        }

        public struct SatisfiedCapability: Identifiable, Sendable, Equatable {
            public let id: String
            public let capability: String
            public let detail: String
        }

        public let status: Status
        public let title: String
        public let errorMessage: String?
        public let findings: [Finding]
        public let requestRoutes: [RequestRoute]
        public let satisfiedCapabilities: [SatisfiedCapability]
    }

    public struct DeletionConfirmation: Sendable, Equatable {
        public let title: String
        public let message: String
        public let isEnabled: Bool
        public let confirmAction: Action.Asynchronous
        public let cancelAction: Action.NoOp
    }

    public enum Action: Sendable, Equatable, Hashable {
        case edit(Edit)
        case asynchronous(Asynchronous)
        case repositoryPicker(RepositoryPicker)
        case confirmation(Confirmation)
        case noOp(NoOp)

        public struct Edit: Sendable, Equatable, Hashable {
            public enum Operation: Sendable, Equatable, Hashable {
                case setProjectName(String)
                case chooseStartingPoint(String)
                case addSlot(String, String)
                case removeSlot(String)
                case renameSlot(String, String)
                case setSlotRequirement(String, String)
                case setSlotOptional(String, Bool)
                case setSlotDescription(String, String?)
                case addModule(String)
                case removeModule(UUID)
                case setModulePackage(UUID, String)
                case setModuleInstanceID(UUID, String)
                case setModuleEnabled(UUID, Bool)
                case setModuleRuntimeSlot(UUID, String)
                case addModuleBinding(UUID)
                case removeModuleBinding(UUID, String)
                case renameModuleBinding(UUID, String, String)
                case setModuleBinding(UUID, String, String)
                case setModuleConfiguration(UUID, String, String)
                case addAutomationRule(UUID)
                case removeAutomationRule(UUID, UUID)
                case setAutomationRuleID(UUID, UUID, String)
                case setAutomationRuleInput(UUID, UUID, String)
                case setAutomationRuleMatch(UUID, UUID, String)
                case setAutomationRuleEmission(UUID, UUID, String, String?)
                case setAutomationRulePayload(UUID, UUID, String)
                case setAutomationRuleTarget(UUID, UUID, String)
            }

            public let operation: Operation
            public let label: String

            private init(_ operation: Operation, label: String) {
                self.operation = operation
                self.label = label
            }

            public static func setProjectName(_ name: String) -> Self {
                Self(.setProjectName(name), label: "Set project name")
            }

            public static func chooseStartingPoint(_ id: String, displayName: String) -> Self {
                Self(.chooseStartingPoint(id), label: "Use \(displayName)")
            }

            public static func addSlot(name: String, requirement: String) -> Self {
                Self(.addSlot(name, requirement), label: "Add slot")
            }

            public static func removeSlot(_ slotId: String) -> Self {
                Self(.removeSlot(slotId), label: "Remove slot")
            }

            public static func renameSlot(_ oldName: String, _ newName: String) -> Self {
                Self(.renameSlot(oldName, newName), label: "Rename slot")
            }

            public static func setSlotRequirement(_ slotId: String, _ requirement: String) -> Self {
                Self(.setSlotRequirement(slotId, requirement), label: "Set slot requirement")
            }

            public static func setSlotOptional(_ slotId: String, _ optional: Bool) -> Self {
                Self(.setSlotOptional(slotId, optional), label: "Set slot optionality")
            }

            public static func setSlotDescription(_ slotId: String, _ description: String?) -> Self {
                Self(.setSlotDescription(slotId, description), label: "Set slot description")
            }

            public static func addModule(_ packageId: String) -> Self {
                Self(.addModule(packageId), label: "Add Module Instance")
            }

            public static func removeModule(_ moduleId: UUID) -> Self {
                Self(.removeModule(moduleId), label: "Remove Module Instance")
            }

            public static func setModulePackage(_ moduleId: UUID, _ packageId: String) -> Self {
                Self(.setModulePackage(moduleId, packageId), label: "Set Module Package")
            }

            public static func setModuleInstanceID(_ moduleId: UUID, _ instanceId: String) -> Self {
                Self(.setModuleInstanceID(moduleId, instanceId), label: "Set Instance ID")
            }

            public static func setModuleEnabled(_ moduleId: UUID, _ enabled: Bool) -> Self {
                Self(.setModuleEnabled(moduleId, enabled), label: "Set Module enabled")
            }

            public static func setModuleRuntimeSlot(_ moduleId: UUID, _ slotId: String) -> Self {
                Self(.setModuleRuntimeSlot(moduleId, slotId), label: "Set runtime slot")
            }

            public static func addModuleBinding(_ moduleId: UUID) -> Self {
                Self(.addModuleBinding(moduleId), label: "Add module binding")
            }

            public static func removeModuleBinding(_ moduleId: UUID, _ key: String) -> Self {
                Self(.removeModuleBinding(moduleId, key), label: "Remove module binding")
            }

            public static func renameModuleBinding(
                _ moduleId: UUID,
                _ oldKey: String,
                _ newKey: String
            ) -> Self {
                Self(
                    .renameModuleBinding(moduleId, oldKey, newKey),
                    label: "Rename module binding")
            }

            public static func setModuleBinding(
                _ moduleId: UUID,
                _ key: String,
                _ value: String
            ) -> Self {
                Self(.setModuleBinding(moduleId, key, value), label: "Set module binding")
            }

            public static func setModuleConfiguration(
                _ moduleId: UUID,
                _ key: String,
                _ value: String
            ) -> Self {
                Self(
                    .setModuleConfiguration(moduleId, key, value),
                    label: "Set module configuration")
            }

            public static func addAutomationRule(_ moduleID: UUID) -> Self {
                Self(.addAutomationRule(moduleID), label: "Add Automation Rule")
            }

            public static func removeAutomationRule(_ moduleID: UUID, _ ruleID: UUID) -> Self {
                Self(.removeAutomationRule(moduleID, ruleID), label: "Remove Automation Rule")
            }

            public static func setAutomationRuleID(
                _ moduleID: UUID, _ ruleID: UUID, _ value: String
            ) -> Self {
                Self(.setAutomationRuleID(moduleID, ruleID, value), label: "Set Rule ID")
            }

            public static func setAutomationRuleInput(
                _ moduleID: UUID, _ ruleID: UUID, _ eventType: String
            ) -> Self {
                Self(.setAutomationRuleInput(moduleID, ruleID, eventType), label: "Set input Fact")
            }

            public static func setAutomationRuleMatch(
                _ moduleID: UUID, _ ruleID: UUID, _ json: String
            ) -> Self {
                Self(.setAutomationRuleMatch(moduleID, ruleID, json), label: "Set bounded match")
            }

            public static func setAutomationRuleEmission(
                _ moduleID: UUID,
                _ ruleID: UUID,
                _ eventType: String,
                resolvedConsumerID: String?
            ) -> Self {
                Self(
                    .setAutomationRuleEmission(
                        moduleID, ruleID, eventType, resolvedConsumerID),
                    label: "Set emitted Request")
            }

            public static func setAutomationRulePayload(
                _ moduleID: UUID, _ ruleID: UUID, _ json: String
            ) -> Self {
                Self(.setAutomationRulePayload(moduleID, ruleID, json), label: "Set Request payload")
            }

            public static func setAutomationRuleTarget(
                _ moduleID: UUID, _ ruleID: UUID, _ target: String
            ) -> Self {
                Self(.setAutomationRuleTarget(moduleID, ruleID, target), label: "Set Request target")
            }
        }

        public struct Asynchronous: Sendable, Equatable, Hashable {
            public enum Operation: Sendable, Equatable, Hashable {
                case setLocalBinding(String, String?)
                case saveLocal
                case saveRepository
                case validate
                case confirmProjectDeletion
            }

            public let operation: Operation
            public let label: String

            private init(_ operation: Operation, label: String) {
                self.operation = operation
                self.label = label
            }

            public static func setLocalBinding(_ slotId: String, _ candidateId: String?) -> Self {
                Self(.setLocalBinding(slotId, candidateId), label: "Set Local Binding")
            }

            public static let saveLocal = Self(.saveLocal, label: "Save locally")
            public static let saveRepository = Self(
                .saveRepository,
                label: "Save and write .jarvis/project.yaml")
            public static let validate = Self(.validate, label: "Validate Project")
            public static let confirmProjectDeletion = Self(
                .confirmProjectDeletion,
                label: "Delete Project")
        }

        public struct RepositoryPicker: Sendable, Equatable, Hashable {
            public enum Operation: Sendable, Equatable, Hashable {
                case chooseRepository(String)
            }

            public let operation: Operation
            public let label: String

            private init(_ operation: Operation, label: String) {
                self.operation = operation
                self.label = label
            }

            public static func chooseRepository(_ repositoryId: String) -> Self {
                Self(.chooseRepository(repositoryId), label: "Choose repository…")
            }
        }

        public struct Confirmation: Sendable, Equatable, Hashable {
            public enum Operation: Sendable, Equatable, Hashable {
                case deleteProject
            }

            public let operation: Operation
            public let label: String

            private init(_ operation: Operation, label: String) {
                self.operation = operation
                self.label = label
            }

            public static let deleteProject = Self(.deleteProject, label: "Delete Project…")
        }

        public struct NoOp: Sendable, Equatable, Hashable {
            public enum Operation: Sendable, Equatable, Hashable {
                case cancelProjectDeletion
            }

            public let operation: Operation
            public let label: String

            private init(_ operation: Operation, label: String) {
                self.operation = operation
                self.label = label
            }

            public static let cancelProjectDeletion = Self(
                .cancelProjectDeletion,
                label: "Cancel")
        }

    }

    public let repositories: [ProjectBinding]
    public let startingPoints: [StartingPoint]
    public let modules: [ProjectModuleDraft]
    public let moduleCards: [ModuleCard]
    public let automationRuleRows: [AutomationRuleRow]
    public let slots: [Slot]
    public let resourceBindings: [ResourceBinding]
    public let actions: [Action]
    public let deletionConfirmation: DeletionConfirmation
    public let reviewRows: [ReviewRow]
    public let validation: Validation
    public let isSaveEnabled: Bool
    public let isReadyForValidation: Bool

    public init(
        project: Project,
        detail: ProjectDetail?,
        state: ProjectConfigurationState,
        packages: [ModulePackage],
        isDeleting: Bool = false
    ) {
        repositories = detail?.bindings ?? []
        startingPoints = (state.compositionGuide?.startingPoints ?? []).map {
            StartingPoint(
                id: $0.id,
                displayName: $0.displayName,
                description: $0.description,
                action: .chooseStartingPoint($0.id, displayName: $0.displayName))
        }
        modules = state.draft?.modules ?? []
        moduleCards = modules.map { module in
            let choice = state.compositionGuide?.moduleInstances.first {
                $0.instanceId == module.instanceId
            }
            let package = packages.first { $0.moduleId == module.moduleId }
            let consumes = choice?.consumes ?? package?.consumes ?? []
            let produces = choice?.produces ?? package?.produces ?? []
            let eventLabel: (String) -> String = { contractId in
                state.compositionGuide?.eventChoices.first {
                    contractId == "\($0.type).v\($0.version)"
                }?.label ?? contractId
            }
            let consumedLabels = consumes.map(eventLabel)
            let producedLabels = produces.map(eventLabel)
            let required = choice?.requiredCapabilities ?? package?.requires ?? []
            let missing = choice?.missingResources ?? []
            return ModuleCard(
                id: module.id,
                displayName: choice?.displayName ?? package?.displayName ?? "Unavailable Module Package",
                description: choice?.description ?? package?.description
                    ?? "Choose an available Module Package.",
                eventSummary:
                    "Consumes: \(consumedLabels.isEmpty ? "None" : consumedLabels.joined(separator: ", ")). Emits: \(producedLabels.isEmpty ? "None" : producedLabels.joined(separator: ", ")).",
                requiredCapabilities: required.isEmpty
                    ? "No required capabilities" : required.joined(separator: ", "),
                compatibility: choice?.compatibility ?? "unavailable",
                missingResources: missing.isEmpty
                    ? "No missing resources" : missing.joined(separator: ", "),
                technicalDetails:
                    "Instance ID: \(module.instanceId) · Package: \(module.moduleId) · Version: \(choice?.version ?? package?.version ?? "unavailable") · Contracts: \((consumes + produces).joined(separator: ", "))"
            )
        }
        let eventChoices = state.compositionGuide?.eventChoices ?? []
        automationRuleRows = modules.flatMap { module -> [AutomationRuleRow] in
            guard let rules = module.automationRules else { return [] }
            let inputChoices = eventChoices.filter {
                $0.kind == "fact"
                    && $0.compatibleConsumerInstanceIDs.contains(module.instanceId)
            }.map(Self.automationEventOption)
            let emissionChoices = eventChoices.filter {
                $0.kind == "request" && $0.producerInstanceIDs.contains(module.instanceId)
            }.map(Self.automationEventOption)
            return rules.map { rule in
                let input = inputChoices.first { $0.type == rule.inputEventType }
                let emission = emissionChoices.first { $0.type == rule.emissionEventType }
                let targetLabel =
                    emission?.selectedConsumerID.map(Self.instanceLabel)
                    ?? Self.targetLabel(rule.target)
                return AutomationRuleRow(
                    id: rule.id,
                    moduleID: module.id,
                    ruleID: rule.ruleID,
                    inputEventType: rule.inputEventType,
                    matchJSON: rule.matchJSON,
                    emissionEventType: rule.emissionEventType,
                    payloadJSON: rule.payloadJSON ?? "{}",
                    target: rule.target,
                    targetChoices: emission?.compatibleConsumerInstanceIDs ?? [],
                    inputChoices: inputChoices,
                    emissionChoices: emissionChoices,
                    inputStatus: input == nil ? .unknown : .known,
                    emissionStatus: emission == nil ? .unknown : .known,
                    inputHint: input == nil
                        ? "Advanced custom value is unknown to the Event Catalog and blocks readiness."
                        : input?.detail ?? "",
                    emissionHint: emission == nil
                        ? "Advanced custom value is unknown to the Event Catalog and blocks readiness."
                        : emission?.detail ?? "",
                    routingStatus: emission?.routingStatus ?? "unknown",
                    routingExplanation: emission?.routingExplanation
                        ?? "No Engine routing explanation is available for this custom Request.",
                    sentence:
                        "When \(input?.label ?? rule.inputEventType) matches, emit \(emission?.label ?? rule.emissionEventType) to \(targetLabel)."
                )
            }
        }
        let choicesBySlot = Dictionary(
            uniqueKeysWithValues: state.resourceChoices.map { ($0.slotId, $0) })
        slots = (state.draft?.slotRequirements ?? [:]).keys.sorted().map { slotId in
            let slot = state.draft?.slotRequirements[slotId]
            let requirement = slot?.requires ?? ""
            return Slot(
                id: slotId,
                requirement: requirement,
                optional: slot?.optional ?? false,
                description: slot?.description,
                candidates: choicesBySlot[slotId]?.candidates ?? [])
        }
        resourceBindings = state.resourceChoices.sorted { $0.slotId < $1.slotId }.map { choice in
            let selected = state.localBindings?.slots.first { $0.slotId == choice.slotId }
                .map { "\($0.kind.rawValue)/\($0.ref)" }
            let capabilities = choice.requiredCapabilities.joined(separator: ", ")
            let unavailable: String
            switch choice.status {
            case .bound, .available:
                unavailable = "Eligible Project resources are available for \(capabilities)."
            case .missing:
                unavailable =
                    "No Project-granted resource provides every required capability: \(capabilities)."
            case .inaccessible:
                unavailable = "The bound resource is no longer accessible to this Project."
            case .incompatible:
                unavailable =
                    "Project resources exist, but none provides every required capability: \(capabilities)."
            }
            return ResourceBinding(
                id: choice.slotId,
                requiredCapabilities: choice.requiredCapabilities,
                candidates: choice.candidates,
                selectedCandidateID: selected,
                status: choice.status,
                unavailableExplanation: unavailable,
                impact: choice.impact,
                repairAction: choice.repairAction,
                accessibilityLabel: "\(choice.slotId), \(choice.status.rawValue), \(capabilities)",
                accessibilityHint: "\(choice.impact) \(choice.repairAction)")
        }

        var inventory: [Action] = repositories.map {
            .repositoryPicker(.chooseRepository($0.repositoryId))
        }
        if let name = state.draft?.name {
            inventory.append(.edit(.setProjectName(name)))
        }
        inventory.append(contentsOf: startingPoints.map { .edit($0.action) })
        inventory.append(.edit(.addSlot(name: "", requirement: "")))
        inventory.append(contentsOf: packages.map { .edit(.addModule($0.moduleId)) })
        inventory.append(
            contentsOf: slots.flatMap { slot in
            [
                .edit(.removeSlot(slot.id)),
                .edit(.renameSlot(slot.id, slot.id)),
                .edit(.setSlotRequirement(slot.id, slot.requirement)),
                .edit(.setSlotOptional(slot.id, slot.optional)),
                .edit(.setSlotDescription(slot.id, slot.description)),
                .asynchronous(.setLocalBinding(slot.id, nil)),
            ] + slot.candidates.map { .asynchronous(.setLocalBinding(slot.id, $0.id)) }
        })
        for module in modules {
            inventory.append(.edit(.removeModule(module.id)))
            inventory.append(.edit(.setModulePackage(module.id, module.moduleId)))
            inventory.append(.edit(.setModuleInstanceID(module.id, module.instanceId)))
            inventory.append(.edit(.setModuleEnabled(module.id, module.enabled)))
            inventory.append(.edit(.setModuleRuntimeSlot(module.id, module.runtimeSlot)))
            inventory.append(.edit(.addModuleBinding(module.id)))
            for key in module.bindings.keys.sorted() {
                inventory.append(.edit(.removeModuleBinding(module.id, key)))
                inventory.append(.edit(.renameModuleBinding(module.id, key, key)))
                inventory.append(
                    .edit(.setModuleBinding(module.id, key, module.bindings[key] ?? "")))
            }
            inventory.append(
                contentsOf: module.configurationValues.keys.sorted().map {
                    .edit(
                        .setModuleConfiguration(
                            module.id, $0, module.configurationValues[$0] ?? ""))
                })
            if let rules = module.automationRules {
                inventory.append(.edit(.addAutomationRule(module.id)))
                for rule in rules {
                    inventory.append(.edit(.removeAutomationRule(module.id, rule.id)))
                    inventory.append(.edit(.setAutomationRuleID(module.id, rule.id, rule.ruleID)))
                    inventory.append(
                        .edit(
                            .setAutomationRuleInput(
                                module.id, rule.id, rule.inputEventType)))
                    inventory.append(
                        .edit(.setAutomationRuleMatch(module.id, rule.id, rule.matchJSON)))
                    inventory.append(
                        .edit(
                            .setAutomationRulePayload(
                                module.id, rule.id, rule.payloadJSON ?? "{}")))
                    let consumer = eventChoices.first {
                        $0.type == rule.emissionEventType && $0.kind == "request"
                    }?.selectedConsumerID
                    inventory.append(
                        .edit(
                            .setAutomationRuleEmission(
                                module.id,
                                rule.id,
                                rule.emissionEventType,
                                resolvedConsumerID: consumer)))
                }
            }
        }
        inventory.append(
            contentsOf: [
                .asynchronous(.saveLocal),
                .asynchronous(.saveRepository),
                .asynchronous(.validate),
                .confirmation(.deleteProject),
                .asynchronous(.confirmProjectDeletion),
                .noOp(.cancelProjectDeletion),
            ])
        actions = inventory
        reviewRows = Self.reviewRows(
            review: state.compositionReview,
            automationRules: automationRuleRows)
        validation = Self.validation(from: state.validation)
        deletionConfirmation = DeletionConfirmation(
            title: "Delete “\(project.name)”?",
            message:
                "This removes the Project Registry record, project-scoped engine state, Local Bindings, and the Repository Grant from this Mac. Repository files, including .jarvis/project.yaml, remain untouched.",
            isEnabled: project.status != .active && !isDeleting,
            confirmAction: .confirmProjectDeletion,
            cancelAction: .cancelProjectDeletion
        )
        isSaveEnabled = state.draft?.validationIssues.isEmpty == true && !state.isSaving
        isReadyForValidation =
            state.isDraftSaved
            && state.compositionReview?.readyToValidate == true
            && !state.isSaving
    }

    private static func validation(from state: ProjectValidationState) -> Validation {
        switch state {
        case .unvalidated:
            return Validation(
                status: .unvalidated,
                title: "Not validated",
                errorMessage: nil,
                findings: [],
                requestRoutes: [],
                satisfiedCapabilities: [])
        case .validating:
            return Validation(
                status: .validating,
                title: "Validating Project…",
                errorMessage: nil,
                findings: [],
                requestRoutes: [],
                satisfiedCapabilities: [])
        case .valid(let report):
            return validationReport(
                report, status: .valid, title: "Project validation passed")
        case .invalid(let report):
            return validationReport(
                report, status: .invalid, title: "Project validation needs attention")
        case .stale:
            return Validation(
                status: .stale,
                title: "Validation report is stale",
                errorMessage:
                    "The Project composition changed after this report was generated. Save the change and revalidate before relying on readiness, routes, capabilities, or findings.",
                findings: [],
                requestRoutes: [],
                satisfiedCapabilities: [])
        case .failed(let message):
            return Validation(
                status: .failed,
                title: "Validation report unavailable",
                errorMessage: message,
                findings: [],
                requestRoutes: [],
                satisfiedCapabilities: [])
        }
    }

    private static func validationReport(
        _ report: ProjectValidationReport,
        status: Validation.Status,
        title: String
    ) -> Validation {
        let findings = report.findings
            .map(validationFinding)
            .sorted {
                ($0.code, $0.reference) < ($1.code, $1.reference)
            }
        return Validation(
            status: status,
            title: title,
            errorMessage: nil,
            findings: findings,
            requestRoutes: report.requestRoutes.map { route in
                Validation.RequestRoute(
                    id: "\(route.contract.identity)-\(route.producer.instanceId)-\(route.consumer.instanceId)",
                    contractIdentity: route.contract.identity,
                    route: "\(route.producer.instanceId) (\(route.producer.moduleId)) → \(route.consumer.instanceId) (\(route.consumer.moduleId))")
            },
            satisfiedCapabilities: report.satisfiedCapabilities.map { capability in
                Validation.SatisfiedCapability(
                    id: "\(capability.capability)-\(capability.target.reference)-\(capability.source.reference)",
                    capability: capability.capability,
                    detail: "\(capability.target.reference) ← \(capability.source.reference)")
            })
    }

    private static func validationFinding(
        _ finding: ProjectValidationFinding
    ) -> Validation.Finding {
        let guidance: (unavailable: String, impact: String, correction: String) =
            switch finding.code {
            case .compositionIncomplete:
                (
                    "Complete Project composition is unavailable.",
                    "Validation cannot assess every configured behaviour.",
                    "Complete the referenced Project field, save the Draft, and validate again."
                )
            case .bindingMissing:
                (
                    "A required Local Binding is unavailable.",
                    "The affected behaviour cannot reach its project-scoped resource.",
                    "Choose an eligible resource for the referenced Slot, then validate again."
                )
            case .capabilityUnresolved:
                (
                    "A required capability is unavailable.",
                    "The referenced Slot or Module Instance cannot provide its affected behaviour.",
                    "Bind a compatible resource or repair the Module Instance, then validate again."
                )
            case .contractIncompatible:
                (
                    "A compatible Event contract is unavailable.",
                    "The producer and consumer cannot exchange the affected behaviour.",
                    "Choose Module Instances with matching contract versions, then validate again."
                )
            case .instanceConfigInvalid:
                (
                    "Valid Module Instance configuration is unavailable.",
                    "The referenced Module Instance cannot run its configured behaviour.",
                    "Correct the referenced configuration field, save, and validate again."
                )
            case .modulePackageUnavailable:
                (
                    "The configured Module Package is unavailable.",
                    "The referenced Module Instance cannot supply its behaviour.",
                    "Choose an available Module Package or restore the configured package, then validate again."
                )
            case .requestAmbiguous:
                (
                    "A single consumer for this Project Request is unavailable.",
                    "The request cannot route deterministically to the affected behaviour.",
                    "Adjust the candidate Module Instances until exactly one active consumer remains."
                )
            case .requestOrphaned:
                (
                    "A consumer for this Project Request is unavailable.",
                    "The produced request cannot reach the affected behaviour.",
                    "Add or enable one compatible consumer, then validate again."
                )
            }
        let reference = finding.target.stableReference
        return Validation.Finding(
            id: "\(finding.code.rawValue)-\(reference)",
            code: finding.code.rawValue,
            targetKind: finding.target.kind,
            reference: reference,
            unavailable: guidance.unavailable,
            impact: guidance.impact,
            correctiveAction: guidance.correction,
            diagnostic: finding.message,
            accessibilityLabel:
                "\(finding.code.rawValue), \(reference). \(guidance.unavailable) \(guidance.impact) \(guidance.correction)"
        )
    }

    private static func reviewRows(
        review: ProjectCompositionReview?,
        automationRules: [AutomationRuleRow]
    ) -> [ReviewRow] {
        let unknownEventRows = automationRules.compactMap { rule -> ReviewRow? in
            guard rule.inputStatus == .unknown || rule.emissionStatus == .unknown else {
                return nil
            }
            return makeReviewRow(
                id: "unknown-event-\(rule.id)",
                category: .finding,
                title: "Unknown Advanced Event value",
                detail: rule.inputStatus == .unknown ? rule.inputHint : rule.emissionHint,
                status: .needsAttention,
                repairAction: "Choose a validated Event from the searchable selector.",
                navigationTarget: "module-\(rule.moduleID)")
        }
        guard let review else { return unknownEventRows }

        var rows = review.compositionGuide.moduleInstances.map { module in
            makeReviewRow(
                id: "module-\(module.instanceId)",
                category: .module,
                title: module.displayName,
                detail: "\(module.instanceId) · \(module.compatibility) · requires \(module.requiredCapabilities.isEmpty ? "no capabilities" : module.requiredCapabilities.joined(separator: ", "))",
                status: module.compatibility == "compatible" && module.missingResources.isEmpty
                    ? .ready : .needsAttention,
                repairAction: module.missingResources.isEmpty
                    ? nil : "Resolve: \(module.missingResources.joined(separator: ", ")).",
                navigationTarget: "module-instance-\(module.instanceId)")
        }
        rows += review.compositionGuide.eventChoices.map { event in
            let needsRepair = event.routingStatus == "orphaned" || event.routingStatus == "ambiguous"
                || event.consumerLabels.contains { $0.contains("incompatible") }
            return makeReviewRow(
                id: "event-\(event.id)",
                category: .eventPath,
                title: "\(event.label) · \(event.kind.capitalized)",
                detail: "Producers: \(event.producerLabels.joined(separator: ", ")). Consumers: \(event.consumerLabels.joined(separator: ", ")). \(event.routingExplanation)",
                status: needsRepair ? .needsAttention : .informational,
                repairAction: needsRepair
                    ? "Return to Module Instances or Automation Rules and repair this Event path."
                    : nil,
                navigationTarget: needsRepair
                    ? event.producerInstanceIDs.first.map { "module-instance-\($0)" }
                        ?? "automation-rules"
                    : nil)
        }
        rows += review.satisfiedCapabilities.map { capability in
            makeReviewRow(
                id: "capability-\(capability.capability)-\(capability.target)",
                category: .capability,
                title: capability.capability,
                detail: "\(capability.target) is satisfied by \(capability.source).",
                status: .ready,
                repairAction: nil,
                navigationTarget: nil)
        }
        rows += review.resourceChoices.slots.map { binding in
            let ready = binding.status == .bound
            return makeReviewRow(
                id: "binding-\(binding.slotId)",
                category: .binding,
                title: binding.slotId,
                detail: "\(binding.status.rawValue.capitalized). \(binding.impact)",
                status: ready ? .ready : .needsAttention,
                repairAction: ready ? nil : binding.repairAction,
                navigationTarget: ready ? nil : "resource-\(binding.slotId)")
        }
        rows += unknownEventRows
        rows += review.findings.map { finding in
            let target = finding.targetKind == "project"
                ? "starting-point"
                : finding.slot.map { "resource-\($0)" }
                    ?? finding.instanceId.map { "module-instance-\($0)" }
                    ?? "automation-rules"
            return makeReviewRow(
                id: "finding-\(finding.code)-\(finding.message)",
                category: .finding,
                title: finding.code,
                detail: finding.message,
                status: .needsAttention,
                repairAction: repairAction(for: finding),
                navigationTarget: target)
        }
        return rows
    }

    private static func repairAction(for finding: ProjectCompositionReview.Finding) -> String {
        switch finding.code {
        case "project.request-orphaned":
            return "Enable exactly one compatible consumer or choose another Request."
        case "project.request-ambiguous":
            return "Choose a target or disable extra consumers."
        case "project.contract-incompatible":
            return "Choose Module Packages with compatible Event contract versions."
        case "project.binding-missing", "project.capability-unresolved":
            return "Choose or grant a compatible Project resource in Local Bindings."
        case "project.composition-incomplete":
            return "Choose a starting point or add the first Module Instance and Project Slot."
        case "project.module-package-unavailable":
            return "Choose an available bundled Module Package."
        default:
            return "Repair the affected Module Configuration field."
        }
    }

    private static func makeReviewRow(
        id: String,
        category: ReviewRow.Category,
        title: String,
        detail: String,
        status: ReviewRow.Status,
        repairAction: String?,
        navigationTarget: String?
    ) -> ReviewRow {
        ReviewRow(
            id: id,
            category: category,
            title: title,
            detail: detail,
            status: status,
            repairAction: repairAction,
            navigationTarget: navigationTarget,
            accessibilityLabel: "\(category.rawValue), \(title), \(status.rawValue)",
            accessibilityHint: [detail, repairAction].compactMap { $0 }.joined(separator: " "))
    }

    private static func automationEventOption(
        _ choice: ProjectCompositionEventChoice
    ) -> AutomationEventOption {
        let producers =
            choice.producerLabels.isEmpty
            ? "No active producer" : "Producer: \(choice.producerLabels.joined(separator: ", "))"
        let consumers =
            choice.consumerLabels.isEmpty
            ? "No active consumer" : "Consumers: \(choice.consumerLabels.joined(separator: ", "))"
        return AutomationEventOption(
            label: choice.label,
            type: choice.type,
            version: choice.version,
            kind: choice.kind,
            detail:
                "\(choice.kind.capitalized) · v\(choice.version) · \(producers) · \(consumers) · \(choice.routingStatus)",
            routingStatus: choice.routingStatus,
            routingExplanation: choice.routingExplanation,
            selectedConsumerID: choice.selectedConsumerID,
            compatibleConsumerInstanceIDs: choice.compatibleConsumerInstanceIDs)
    }

    private static func instanceLabel(_ id: String) -> String {
        ProjectCompositionEventChoice.instanceLabel(id)
    }

    private static func targetLabel(_ target: AutomationRuleDraft.Target) -> String {
        switch target {
        case .moduleInstance(let id): instanceLabel(id)
        case .binding(let id): "binding \(id)"
        }
    }
}
