import Foundation

/// Complete, data-driven content and action inventory rendered by ProjectDetailView.
/// SwiftUI owns only bindings and side-effect handlers; this value is testable in JarvisCore.
public struct ProjectDetailPresentation: Sendable, Equatable {
    public struct Slot: Identifiable, Sendable, Equatable {
        public let id: String
        public let requirement: String
        public let candidates: [ProjectResourceCandidate]
    }

    public enum Action: Sendable, Equatable, Hashable {
        case chooseRepository(String)
        case addSlot
        case removeSlot(String)
        case addModule(String)
        case removeModule(UUID)
        case addModuleBinding(UUID)
        case removeModuleBinding(UUID, String)
        case setLocalBinding(String, String?)
        case saveLocal
        case saveRepository

        public var label: String {
            switch self {
            case .chooseRepository: "Choose repository…"
            case .addSlot: "Add slot"
            case .removeSlot: "Remove slot"
            case .addModule: "Add Module Instance"
            case .removeModule: "Remove Module Instance"
            case .addModuleBinding: "Add module binding"
            case .removeModuleBinding: "Remove module binding"
            case .setLocalBinding: "Set Local Binding"
            case .saveLocal: "Save locally"
            case .saveRepository: "Save and write .jarvis/project.yaml"
            }
        }
    }

    public let repositories: [ProjectBinding]
    public let modules: [ProjectModuleDraft]
    public let slots: [Slot]
    public let actions: [Action]
    public let isSaveEnabled: Bool

    public init(
        detail: ProjectDetail?,
        state: ProjectConfigurationState,
        packages: [ModulePackage]
    ) {
        repositories = detail?.bindings ?? []
        modules = state.draft?.modules ?? []
        slots = (state.draft?.slotRequirements ?? [:]).keys.sorted().map { slotId in
            let requirement = state.draft?.slotRequirements[slotId]?.requires ?? ""
            return Slot(
                id: slotId,
                requirement: requirement,
                candidates: state.candidates.filter { $0.capabilities.contains(requirement) })
        }

        var inventory: [Action] = repositories.map {
            .chooseRepository($0.repositoryId)
        }
        inventory.append(.addSlot)
        inventory.append(contentsOf: packages.map { .addModule($0.moduleId) })
        inventory.append(contentsOf: slots.flatMap { slot in
            [.removeSlot(slot.id), .setLocalBinding(slot.id, nil)]
                + slot.candidates.map { .setLocalBinding(slot.id, $0.id) }
        })
        for module in modules {
            inventory.append(.removeModule(module.id))
            inventory.append(.addModuleBinding(module.id))
            inventory.append(
                contentsOf: module.bindings.keys.sorted().map {
                    .removeModuleBinding(module.id, $0)
                })
        }
        inventory.append(contentsOf: [.saveLocal, .saveRepository])
        actions = inventory
        isSaveEnabled = state.draft?.validationIssues.isEmpty == true && !state.isSaving
    }
}
