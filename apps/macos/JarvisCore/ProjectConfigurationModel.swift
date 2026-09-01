import Foundation
import JarvisAPI
import Observation

public struct ProjectConfigurationState: Sendable, Equatable {
    public var detail: ProjectDetail?
    public var localBindings: LocalProjectBindings?
    public var candidates: [ProjectResourceCandidate] = []
    public var draft: ProjectConfigurationDraft?
    public var isLoading = false
    public var isSaving = false
    public var errorMessage: String?
}

/// Project Wizard coordinator for composition edits and project-scoped grants.
/// Project import/list state remains owned by `ProjectsModel`.
@MainActor
@Observable
public final class ProjectConfigurationModel {
    public private(set) var states: [String: ProjectConfigurationState] = [:]

    private let session: EngineSessionModel
    private let projects: ProjectsModel

    public init(session: EngineSessionModel, projects: ProjectsModel) {
        self.session = session
        self.projects = projects
    }

    private var client: EngineClient? { session.client }

    public func state(for projectId: String) -> ProjectConfigurationState {
        states[projectId] ?? ProjectConfigurationState()
    }

    public func refresh(projectId: String, packages: [ModulePackage] = []) async {
        guard let client else {
            update(projectId) { $0.errorMessage = Self.engineUnavailable }
            return
        }
        update(projectId) {
            $0.isLoading = true
            $0.candidates = []
        }
        defer { update(projectId) { $0.isLoading = false } }
        do {
            let detail = try await client.getProject(id: projectId)
            let bindings = try await client.getProjectBindings(projectId: projectId)
            let candidates = try await client.listProjectBindingCandidates(projectId: projectId)
            let draft: ProjectConfigurationDraft?
            if let configuration = detail.portableConfiguration {
                draft = ProjectConfigurationDraft(configuration: configuration, packages: packages)
            } else if let partial = detail.partialPortableConfigurationJSON {
                draft = try ProjectConfigurationDraft(
                    partialConfigurationJSON: partial,
                    project: detail.project,
                    packages: packages)
            } else {
                draft = nil
            }
            update(projectId) {
                $0.detail = detail
                $0.localBindings = bindings
                $0.candidates = candidates
                $0.draft = draft
                $0.errorMessage = nil
            }
        } catch {
            update(projectId) {
                $0.candidates = []
                $0.errorMessage = ProjectsModel.describe(error)
            }
        }
    }

    public func editDraft(
        projectId: String,
        _ edit: (inout ProjectConfigurationDraft) -> Void
    ) {
        update(projectId) { state in
            guard var draft = state.draft else { return }
            edit(&draft)
            state.draft = draft
            state.errorMessage = nil
        }
    }

    public func addModule(projectId: String, package: ModulePackage) {
        editDraft(projectId: projectId) { $0.add(package: package) }
    }

    public func removeModule(projectId: String, moduleId: UUID) {
        editDraft(projectId: projectId) { $0.modules.removeAll { $0.id == moduleId } }
    }

    public func addSlot(projectId: String) {
        editDraft(projectId: projectId) { draft in
            var index = draft.slotRequirements.count + 1
            var name = "slot\(index)"
            while draft.slotRequirements[name] != nil {
                index += 1
                name = "slot\(index)"
            }
            draft.slotRequirements[name] = ProjectSlotDraft(requires: "capability.required")
        }
    }

    public func removeSlot(projectId: String, slotId: String) {
        editDraft(projectId: projectId) { $0.slotRequirements[slotId] = nil }
    }

    public func renameSlot(projectId: String, from oldName: String, to newName: String) {
        guard !newName.isEmpty, newName != oldName else { return }
        let current = state(for: projectId)
        if current.localBindings?.slots.contains(where: { $0.slotId == oldName }) == true {
            update(projectId) {
                $0.errorMessage =
                    "Unbind \(oldName) before renaming it so Local Bindings remain valid."
            }
            return
        }
        editDraft(projectId: projectId) { draft in
            guard draft.slotRequirements[newName] == nil,
                let requirement = draft.slotRequirements.removeValue(forKey: oldName)
            else { return }
            draft.slotRequirements[newName] = requirement
            for index in draft.modules.indices {
                if draft.modules[index].runtimeSlot == oldName {
                    draft.modules[index].runtimeSlot = newName
                }
                for (binding, target) in draft.modules[index].bindings where target == oldName {
                    draft.modules[index].bindings[binding] = newName
                }
            }
        }
    }

    @discardableResult
    public func saveDraft(projectId: String, writeToRepository: Bool) async -> ProjectDetail? {
        do {
            guard let draft = state(for: projectId).draft else {
                update(projectId) {
                    $0.errorMessage =
                        "No editable Project Configuration is loaded. Reload this Project and try again."
                }
                return nil
            }
            return await saveConfiguration(
                projectId: projectId,
                portableConfig: try draft.payload(),
                writeToRepository: writeToRepository)
        } catch {
            update(projectId) { $0.errorMessage = error.localizedDescription }
            return nil
        }
    }

    @discardableResult
    public func saveConfiguration(
        projectId: String,
        portableConfig: Components.Schemas.PortableProjectConfiguration,
        writeToRepository: Bool
    ) async -> ProjectDetail? {
        guard !state(for: projectId).isSaving else { return nil }
        guard let client else {
            update(projectId) { $0.errorMessage = Self.engineUnavailable }
            return nil
        }
        update(projectId) { $0.isSaving = true }
        defer { update(projectId) { $0.isSaving = false } }
        do {
            let detail = try await client.replaceProjectConfiguration(
                projectId: projectId,
                portableConfig: portableConfig,
                writeToRepository: writeToRepository)
            let candidates: [ProjectResourceCandidate]
            let candidateError: String?
            do {
                candidates = try await client.listProjectBindingCandidates(projectId: projectId)
                candidateError = nil
            } catch {
                candidates = []
                candidateError =
                    "Configuration was saved, but eligible Local Binding candidates could not be refreshed. Reload this Project before binding a slot."
            }
            update(projectId) {
                $0.detail = detail
                $0.candidates = candidates
                $0.errorMessage = candidateError
            }
            await projects.refresh()
            return detail
        } catch {
            update(projectId) { $0.errorMessage = ProjectsModel.describe(error) }
            return nil
        }
    }

    public func setLocalBinding(
        projectId: String,
        slotId: String,
        candidate: ProjectResourceCandidate?
    ) async -> LocalProjectBindings? {
        guard var payload = state(for: projectId).localBindings?.wirePayload else {
            update(projectId) {
                $0.errorMessage =
                    "Local Bindings are not loaded. Reload this Project before binding a slot."
            }
            return nil
        }
        if let candidate {
            payload.slots.additionalProperties[slotId] = .init(
                kind: candidate.kind.payload, ref: candidate.ref)
        } else {
            payload.slots.additionalProperties.removeValue(forKey: slotId)
        }
        return await saveBindings(projectId: projectId, bindings: payload)
    }

    @discardableResult
    public func saveBindings(
        projectId: String,
        bindings: Components.Schemas.ProjectBindings
    ) async -> LocalProjectBindings? {
        guard !state(for: projectId).isSaving else { return nil }
        guard let client else {
            update(projectId) { $0.errorMessage = Self.engineUnavailable }
            return nil
        }
        update(projectId) { $0.isSaving = true }
        defer { update(projectId) { $0.isSaving = false } }
        do {
            let saved = try await client.replaceProjectBindings(
                projectId: projectId, bindings: bindings)
            update(projectId) {
                $0.localBindings = saved
                $0.errorMessage = nil
            }
            return saved
        } catch {
            update(projectId) { $0.errorMessage = ProjectsModel.describe(error) }
            return nil
        }
    }

    private static let engineUnavailable =
        "The engine is not running. Project Configuration cannot be loaded or saved. Restart Jarvis."

    private func update(
        _ projectId: String,
        _ change: (inout ProjectConfigurationState) -> Void
    ) {
        var value = states[projectId] ?? ProjectConfigurationState()
        change(&value)
        states[projectId] = value
    }
}
