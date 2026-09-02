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
        public let confirmLabel: String
        public let cancelLabel: String
        public let isEnabled: Bool
        public let confirmAction: Action
        public let cancelAction: Action
    }

    public enum Action: Sendable, Equatable, Hashable {
        case chooseRepository(String)
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
        case setLocalBinding(String, String?)
        case saveLocal
        case saveRepository
        case deleteProject
        case confirmProjectDeletion
        case cancelProjectDeletion

        public enum Routing: Sendable, Equatable {
            case edit
            case asynchronous
            case repositoryPicker
            case confirmation
            case noOp
        }

        public enum AsyncOperation: Sendable, Equatable {
            case setLocalBinding(String, String?)
            case saveLocal
            case saveRepository
            case confirmProjectDeletion
        }

        public var asyncOperation: AsyncOperation? {
            switch self {
            case .setLocalBinding(let slotId, let candidateId):
                .setLocalBinding(slotId, candidateId)
            case .saveLocal: .saveLocal
            case .saveRepository: .saveRepository
            case .confirmProjectDeletion: .confirmProjectDeletion
            case .chooseRepository, .setProjectName, .addSlot, .removeSlot, .renameSlot,
                .setSlotRequirement, .setSlotOptional, .setSlotDescription, .addModule,
                .removeModule, .setModulePackage, .setModuleInstanceID, .setModuleEnabled,
                .setModuleRuntimeSlot, .addModuleBinding, .removeModuleBinding,
                .renameModuleBinding, .setModuleBinding, .setModuleConfiguration, .deleteProject,
                .cancelProjectDeletion:
                nil
            }
        }

        public var routing: Routing {
            switch self {
            case .chooseRepository: .repositoryPicker
            case .setLocalBinding, .saveLocal, .saveRepository, .confirmProjectDeletion:
                .asynchronous
            case .deleteProject: .confirmation
            case .cancelProjectDeletion: .noOp
            case .setProjectName, .addSlot, .removeSlot, .renameSlot, .setSlotRequirement,
                .setSlotOptional, .setSlotDescription, .addModule, .removeModule,
                .setModulePackage, .setModuleInstanceID, .setModuleEnabled,
                .setModuleRuntimeSlot, .addModuleBinding, .removeModuleBinding,
                .renameModuleBinding, .setModuleBinding, .setModuleConfiguration:
                .edit
            }
        }

        public var label: String {
            switch self {
            case .chooseRepository: "Choose repository…"
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
            case .setLocalBinding: "Set Local Binding"
            case .saveLocal: "Save locally"
            case .saveRepository: "Save and write .jarvis/project.yaml"
            case .deleteProject: "Delete Project…"
            case .confirmProjectDeletion: "Delete Project"
            case .cancelProjectDeletion: "Cancel"
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
            .chooseRepository($0.repositoryId)
        }
        if let name = state.draft?.name {
            inventory.append(.setProjectName(name))
        }
        inventory.append(.addSlot)
        inventory.append(contentsOf: packages.map { .addModule($0.moduleId) })
        inventory.append(contentsOf: slots.flatMap { slot in
            [
                .removeSlot(slot.id),
                .renameSlot(slot.id, slot.id),
                .setSlotRequirement(slot.id, slot.requirement),
                .setSlotOptional(slot.id, slot.optional),
                .setSlotDescription(slot.id, slot.description),
                .setLocalBinding(slot.id, nil),
            ] + slot.candidates.map { .setLocalBinding(slot.id, $0.id) }
        })
        for module in modules {
            inventory.append(.removeModule(module.id))
            inventory.append(.setModulePackage(module.id, module.moduleId))
            inventory.append(.setModuleInstanceID(module.id, module.instanceId))
            inventory.append(.setModuleEnabled(module.id, module.enabled))
            inventory.append(.setModuleRuntimeSlot(module.id, module.runtimeSlot))
            inventory.append(.addModuleBinding(module.id))
            for key in module.bindings.keys.sorted() {
                inventory.append(.removeModuleBinding(module.id, key))
                inventory.append(.renameModuleBinding(module.id, key, key))
                inventory.append(.setModuleBinding(module.id, key, module.bindings[key] ?? ""))
            }
            inventory.append(
                contentsOf: module.configurationValues.keys.sorted().map {
                    .setModuleConfiguration(module.id, $0, module.configurationValues[$0] ?? "")
                })
        }
        inventory.append(
            contentsOf: [
                .saveLocal, .saveRepository, .deleteProject, .confirmProjectDeletion,
                .cancelProjectDeletion,
            ])
        actions = inventory
        deletionConfirmation = DeletionConfirmation(
            title: "Delete “\(project.name)”?",
            message:
                "This removes the Project Registry record, project-scoped engine state, Local Bindings, and the Repository Grant from this Mac. Repository files, including .jarvis/project.yaml, remain untouched.",
            confirmLabel: "Delete Project",
            cancelLabel: "Cancel",
            isEnabled: project.status != .active && !isDeleting,
            confirmAction: .confirmProjectDeletion,
            cancelAction: .cancelProjectDeletion
        )
        isSaveEnabled = state.draft?.validationIssues.isEmpty == true && !state.isSaving
    }
}
