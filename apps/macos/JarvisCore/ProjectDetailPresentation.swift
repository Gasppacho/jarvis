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

        public enum Edit: Sendable, Equatable, Hashable {
            case setProjectName(String)
            case addSlot
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

            public var label: String {
                switch self {
                case .setProjectName: "Set project name"
                case .addSlot: "Add slot"
                case .removeSlot: "Remove slot"
                case .renameSlot: "Rename slot"
                case .setSlotRequirement: "Set slot requirement"
                case .setSlotOptional: "Set slot optionality"
                case .setSlotDescription: "Set slot description"
                case .addModule: "Add Module Instance"
                case .removeModule: "Remove Module Instance"
                case .setModulePackage: "Set Module Package"
                case .setModuleInstanceID: "Set Instance ID"
                case .setModuleEnabled: "Set Module enabled"
                case .setModuleRuntimeSlot: "Set runtime slot"
                case .addModuleBinding: "Add module binding"
                case .removeModuleBinding: "Remove module binding"
                case .renameModuleBinding: "Rename module binding"
                case .setModuleBinding: "Set module binding"
                case .setModuleConfiguration: "Set module configuration"
                }
            }
        }

        public enum Asynchronous: Sendable, Equatable, Hashable {
            case setLocalBinding(String, String?)
            case saveLocal
            case saveRepository
            case confirmProjectDeletion

            public var label: String {
                switch self {
                case .setLocalBinding: "Set Local Binding"
                case .saveLocal: "Save locally"
                case .saveRepository: "Save and write .jarvis/project.yaml"
                case .confirmProjectDeletion: "Delete Project"
                }
            }
        }

        public enum RepositoryPicker: Sendable, Equatable, Hashable {
            case chooseRepository(String)

            public var label: String {
                switch self {
                case .chooseRepository: "Choose repository…"
                }
            }
        }

        public enum Confirmation: Sendable, Equatable, Hashable {
            case deleteProject

            public var label: String {
                switch self {
                case .deleteProject: "Delete Project…"
                }
            }
        }

        public enum NoOp: Sendable, Equatable, Hashable {
            case cancelProjectDeletion

            public var label: String {
                switch self {
                case .cancelProjectDeletion: "Cancel"
                }
            }
        }

    }

    public let repositories: [ProjectBinding]
    public let modules: [ProjectModuleDraft]
    public let slots: [Slot]
    public let actions: [Action]
    public let deletionConfirmation: DeletionConfirmation
    public let isSaveEnabled: Bool

    public init(
        project: Project,
        detail: ProjectDetail?,
        state: ProjectConfigurationState,
        packages: [ModulePackage],
        isDeleting: Bool = false
    ) {
        repositories = detail?.bindings ?? []
        modules = state.draft?.modules ?? []
        slots = (state.draft?.slotRequirements ?? [:]).keys.sorted().map { slotId in
            let slot = state.draft?.slotRequirements[slotId]
            let requirement = slot?.requires ?? ""
            return Slot(
                id: slotId,
                requirement: requirement,
                optional: slot?.optional ?? false,
                description: slot?.description,
                candidates: state.candidates.filter { $0.capabilities.contains(requirement) })
        }

        var inventory: [Action] = repositories.map {
            .repositoryPicker(.chooseRepository($0.repositoryId))
        }
        if let name = state.draft?.name {
            inventory.append(.edit(.setProjectName(name)))
        }
        inventory.append(.edit(.addSlot))
        inventory.append(contentsOf: packages.map { .edit(.addModule($0.moduleId)) })
        inventory.append(contentsOf: slots.flatMap { slot in
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
        }
        inventory.append(
            contentsOf: [
                .asynchronous(.saveLocal),
                .asynchronous(.saveRepository),
                .confirmation(.deleteProject),
                .asynchronous(.confirmProjectDeletion),
                .noOp(.cancelProjectDeletion),
            ])
        actions = inventory
        deletionConfirmation = DeletionConfirmation(
            title: "Delete “\(project.name)”?",
            message:
                "This removes the Project Registry record, project-scoped engine state, Local Bindings, and the Repository Grant from this Mac. Repository files, including .jarvis/project.yaml, remain untouched.",
            isEnabled: project.status != .active && !isDeleting,
            confirmAction: .confirmProjectDeletion,
            cancelAction: .cancelProjectDeletion
        )
        isSaveEnabled = state.draft?.validationIssues.isEmpty == true && !state.isSaving
    }
}
