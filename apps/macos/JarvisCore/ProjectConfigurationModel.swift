import Foundation
import JarvisAPI
import Observation

/// Ticket #55: the Wizard's Activate affordance, reflecting exactly what the
/// engine decided. `nil` code marks a client-side refusal (no current report,
/// or one with no `compositionFingerprint`) — never a guessed engine code.
public enum ProjectActivationState: Sendable, Equatable {
    case idle
    case activating
    case succeeded
    case rejected(code: String?, message: String)
    case transportFailure(String)
}

public struct ProjectConfigurationState: Sendable, Equatable {
    public var detail: ProjectDetail?
    public var localBindings: LocalProjectBindings?
    public var candidates: [ProjectResourceCandidate] = []
    public var resourceChoices: [ProjectResourceBindingChoice] = []
    public var compositionGuide: ProjectCompositionGuide?
    public var compositionReview: ProjectCompositionReview?
    public var compositionGraph: ProjectCompositionGraph?
    public var preflight: ProjectPreflightState = .unchecked
    public var preflightReceivedAt: Date?
    public var trialWorkItemRef: String?
    public var pendingScopeDescription: String?
    public var canRestoreTrial: Bool {
        trialWorkItemRef != nil && trialWorkItemRef == preflight.report?.configuredWorkItemRef
    }

    public var validation: ProjectValidationState = .unvalidated
    public var activation: ProjectActivationState = .idle
    public var draft: ProjectConfigurationDraft?
    /// Slots whose persisted Local Bindings must be deleted by the next Draft save.
    /// Re-adding a module does not cancel this explicit removal.
    public var removedBindingSlots: Set<String> = []
    public var hasPendingBindingEdits = false
    public var isDraftSaved = false
    public var isLoading = false
    public var loadFailed = false
    public var isSaving = false
    public var saveFailed = false
    public var pendingStartingPointID: String?
    public var migration: ProjectMigrationState = .unchecked
    public var errorMessage: String?
    public var saveStatus: String {
        if isSaving { return "Enregistrement…" }
        if saveFailed { return "Échec — Réessayer" }
        if isDraftSaved { return "Enregistré" }
        return "Modifications à enregistrer"
    }
    public var agentRuntimes: Components.Schemas.ProjectAgentRuntimeChoices?
    public var isRuntimeBusy = false
    public var runtimeMetadataUnavailable = false
    public var runtimePresentation: ProjectRuntimePresentation {
        ProjectRuntimePresentation(choices: agentRuntimes, isBusy: isRuntimeBusy)
    }
    public var runtimeAllowsActivation: Bool {
        !runtimeMetadataUnavailable && !isRuntimeBusy
            && (agentRuntimes?.required != true || agentRuntimes?.readiness.status == .ready)
    }
}

/// Project Wizard coordinator for composition edits and project-scoped grants.
/// Project import/list state remains owned by `ProjectsModel`.
@MainActor
@Observable
public final class ProjectConfigurationModel {
    public private(set) var states: [String: ProjectConfigurationState] = [:]

    typealias ValidationReportProvider =
        @Sendable (String) async throws
        -> ProjectValidationReport
    typealias ActivationProvider = @Sendable (String, String) async throws -> Project

    private let session: EngineSessionModel
    private let projects: ProjectsModel
    private let validationReportProvider: ValidationReportProvider?
    private let activationProvider: ActivationProvider?
    private let injectedPreflightAPI: (any ProjectPreflightAPI)?
    private var preflightAPI: (any ProjectPreflightAPI)? { injectedPreflightAPI ?? client }
    private let injectedMigrationAPI: (any ProjectMigrationAPI)?
    private var migrationAPI: (any ProjectMigrationAPI)? { injectedMigrationAPI ?? client }
    private let injectedRuntimeAPI: (any ProjectRuntimeAPI)?
    private var runtimeRevisions: [String: Int] = [:]
    private var runtimeAPI: (any ProjectRuntimeAPI)? { injectedRuntimeAPI ?? client }
    private var compositionRevisions: [String: Int] = [:]
    private var validationRevisions: [String: Int] = [:]
    private var refreshRevisions: [String: Int] = [:]
    private var lastValidationReports: [String: ProjectValidationReport] = [:]

    public init(session: EngineSessionModel, projects: ProjectsModel) {
        self.session = session
        self.projects = projects
        validationReportProvider = nil
        activationProvider = nil
        injectedRuntimeAPI = nil
        injectedPreflightAPI = nil
        injectedMigrationAPI = nil
    }

    init(
        session: EngineSessionModel,
        projects: ProjectsModel,
        validationReportProvider: ValidationReportProvider? = nil,
        activationProvider: ActivationProvider? = nil,
        runtimeAPI: (any ProjectRuntimeAPI)? = nil,
        preflightAPI: (any ProjectPreflightAPI)? = nil,
        migrationAPI: (any ProjectMigrationAPI)? = nil
    ) {
        self.session = session
        self.projects = projects
        self.validationReportProvider = validationReportProvider
        self.activationProvider = activationProvider
        injectedRuntimeAPI = runtimeAPI
        injectedPreflightAPI = preflightAPI
        injectedMigrationAPI = migrationAPI
    }

    private var client: EngineClient? { session.client }

    static func shouldPreviewMigration(
        _ configuration: Components.Schemas.PortableProjectConfiguration?
    ) -> Bool {
        guard let configuration,
            !configuration.modules.isEmpty || !configuration.slots.additionalProperties.isEmpty
        else { return false }
        return configuration.compositionMode != .fixed_hyphen_modules
    }

    public func state(for projectId: String) -> ProjectConfigurationState {
        if let state = states[projectId] { return state }
        var state = ProjectConfigurationState()
        state.trialWorkItemRef = UserDefaults.standard.string(
            forKey: "\(projects.preferenceNamespace)dev.jarvis.project-trial.v1.\(projectId)")
        return state
    }

    public func refresh(projectId: String, packages: [ModulePackage] = []) async {
        await refresh(projectId: projectId, packages: packages, preservingStaleValidation: false)
    }

    public func refreshAfterRepositoryBindingChange(
        projectId: String,
        packages: [ModulePackage] = []
    ) async {
        markValidationStale(projectId: projectId)
        await refresh(projectId: projectId, packages: packages, preservingStaleValidation: true)
    }

    public func refreshAfterConnectionManagement(
        projectId: String,
        packages: [ModulePackage] = []
    ) async {
        await refresh(projectId: projectId, packages: packages)
        await refreshCompositionChoices(projectId: projectId)
    }

    private func refresh(
        projectId: String,
        packages: [ModulePackage],
        preservingStaleValidation: Bool
    ) async {
        markValidationStale(projectId: projectId)
        guard let client else {
            update(projectId) {
                $0.loadFailed = true
                $0.errorMessage = Self.engineUnavailable
            }
            return
        }
        refreshRevisions[projectId, default: 0] += 1
        let refreshRevision = refreshRevisions[projectId, default: 0]
        let preservedDraft = state(for: projectId).isDraftSaved ? nil : state(for: projectId).draft
        let preservedBindings =
            state(for: projectId).hasPendingBindingEdits
            ? state(for: projectId).localBindings : nil
        validationRevisions[projectId, default: 0] += 1
        if !preservingStaleValidation {
            lastValidationReports[projectId] = nil
        }
        update(projectId) {
            $0.isLoading = true
            $0.loadFailed = false
            if !preservingStaleValidation {
                // A report evaluates the previously loaded snapshot. Reopening or
                // reloading requires a fresh engine evaluation before it is current.
                $0.validation = .unvalidated
                $0.preflight = .unchecked
            }
        }
        defer {
            if refreshRevisions[projectId, default: 0] == refreshRevision {
                update(projectId) { $0.isLoading = false }
            }
        }
        do {
            let detail = try await client.getProject(id: projectId)
            let bindings = try await client.getProjectBindings(projectId: projectId)
            let previewConfiguration = detail.portableConfiguration.flatMap { configuration in
                configuration.modules.isEmpty && configuration.slots.additionalProperties.isEmpty
                    ? nil : configuration
            }
            let shouldPreviewMigration = Self.shouldPreviewMigration(detail.portableConfiguration)
            let compositionReview = try await client.reviewProjectComposition(
                projectId: projectId,
                portableConfig: previewConfiguration)
            let migrationPreview: ProjectMigrationState?
            var migrationError: String?
            if shouldPreviewMigration, let migrationAPI {
                do {
                    migrationPreview = .current(
                        try await migrationAPI.previewGuidedMigration(projectId: projectId))
                    migrationError = nil
                } catch {
                    migrationPreview = nil
                    migrationError = ProjectsModel.describe(error)
                }
            } else {
                migrationPreview = nil
                migrationError = Self.engineUnavailable
            }
            let compositionGraph = try? await client.fetchProjectCompositionGraph(
                projectId: projectId,
                portableConfig: previewConfiguration)
            let persistedPreflight: Components.Schemas.ProjectPreflightV1?
            var persistedPreflightError: String?
            if let preflightAPI {
                do {
                    persistedPreflight = try await preflightAPI.currentProjectPreflight(
                        projectId: projectId)
                } catch {
                    persistedPreflight = nil
                    persistedPreflightError =
                        "La configuration est chargée, mais sa dernière vérification n’a pas pu être rechargée. Vérifiez à nouveau avant de l’appliquer."
                }
            } else {
                persistedPreflight = nil
            }
            let draft: ProjectConfigurationDraft?
            if let configuration = detail.portableConfiguration {
                draft = ProjectConfigurationDraft(configuration: configuration, packages: packages)
            } else if let partial = detail.partialPortableConfiguration {
                draft = try ProjectConfigurationDraft(
                    partialConfiguration: partial,
                    packages: packages)
            } else {
                draft = nil
            }
            guard refreshRevisions[projectId, default: 0] == refreshRevision else { return }
            update(projectId) {
                $0.detail = detail
                $0.localBindings = preservedBindings ?? bindings
                $0.candidates = compositionReview.resourceChoices.candidates
                $0.resourceChoices = compositionReview.resourceChoices.slots
                $0.agentRuntimes = compositionReview.resourceChoices.agentRuntimes
                $0.runtimeMetadataUnavailable = $0.agentRuntimes == nil
                $0.compositionGuide = compositionReview.compositionGuide
                $0.compositionReview = compositionReview
                $0.compositionGraph = compositionGraph
                if let persistedPreflight {
                    $0.preflight = .current(persistedPreflight)
                    $0.preflightReceivedAt = nil
                    $0.agentRuntimes = persistedPreflight.runtime
                    $0.runtimeMetadataUnavailable = false
                } else if let persistedPreflightError {
                    $0.preflight = .failed(persistedPreflightError)
                }
                if let migrationPreview {
                    $0.migration = migrationPreview
                } else if shouldPreviewMigration && $0.migration == .unchecked {
                    $0.migration = .failed(migrationError ?? Self.engineUnavailable)
                } else if !shouldPreviewMigration {
                    $0.migration = .unchecked
                }
                $0.draft = preservedDraft ?? draft
                $0.isDraftSaved = preservedDraft == nil
                if preservedDraft == nil { $0.saveFailed = false }
                $0.errorMessage = persistedPreflightError
            }
        } catch {
            guard refreshRevisions[projectId, default: 0] == refreshRevision else { return }
            update(projectId) {
                $0.loadFailed = true
                $0.errorMessage = ProjectsModel.describe(error)
            }
        }
    }

    public func editDraft(
        projectId: String,
        invalidatesVerification: Bool = true,
        _ edit: (inout ProjectConfigurationDraft) -> Void
    ) {
        refreshRevisions[projectId, default: 0] += 1
        var didEdit = false
        update(projectId) { state in
            guard var draft = state.draft else { return }
            state.isLoading = false
            edit(&draft)
            state.draft = draft
            state.compositionReview = nil
            state.compositionGraph = nil
            state.isDraftSaved = false
            state.saveFailed = false
            state.errorMessage = nil
            didEdit = true
        }
        guard didEdit else { return }
        compositionRevisions[projectId, default: 0] += 1
        if invalidatesVerification { markValidationStale(projectId: projectId) }
        Task { await refreshCompositionChoices(projectId: projectId) }
    }

    /// Applies an Engine-proposed repository reference replacement to the in-memory Draft.
    public func applyRepositoryReferenceReplacement(
        projectId: String,
        moduleInstanceID: String,
        replacement: ProjectRepositoryReferenceReplacement
    ) {
        guard replacement.field == "/configuration/repositories" else { return }
        editDraft(projectId: projectId) { draft in
            guard
                let index = draft.modules.firstIndex(where: {
                    $0.instanceId == moduleInstanceID
                }),
                let raw = draft.modules[index].configurationValues["repositories"],
                let data = raw.data(using: .utf8),
                var values = try? JSONDecoder().decode([String].self, from: data),
                values.contains(replacement.from)
            else { return }
            values = values.map { $0 == replacement.from ? replacement.to : $0 }
            guard let encoded = try? JSONEncoder().encode(values) else { return }
            draft.modules[index].configurationValues["repositories"] =
                String(decoding: encoded, as: UTF8.self)
        }
    }

    public func chooseStartingPoint(
        projectId: String, startingPointId: String, confirmedReplacement: Bool = false
    ) {
        // Custom means keeping the current composition editable, never erasing it.
        if startingPointId == "custom" { return }
        if !confirmedReplacement, let current = state(for: projectId).draft,
            !current.modules.isEmpty || !current.slotRequirements.isEmpty
        {
            update(projectId) { $0.pendingStartingPointID = startingPointId }
            return
        }
        guard let guide = state(for: projectId).compositionGuide,
            let startingPoint = guide.startingPoints.first(where: { $0.id == startingPointId })
        else { return }
        if let template = startingPoint.template {
            update(projectId) {
                $0.pendingStartingPointID = nil
                var replacement = ProjectConfigurationDraft(
                    configuration: template, packages: guide.modulePackages)
                // The proposal may precede the most recent edit. Keep user-owned project data.
                if let current = $0.draft {
                    replacement.name = current.name
                }
                $0.draft = replacement
                $0.compositionReview = nil
                $0.isDraftSaved = false
                $0.saveFailed = false
                $0.errorMessage = nil
            }
            compositionRevisions[projectId, default: 0] += 1
            markValidationStale(projectId: projectId)
            Task { await refreshCompositionChoices(projectId: projectId) }
        } else {
            editDraft(projectId: projectId) {
                $0.modules = []
                $0.slotRequirements = [:]
            }
        }
    }

    public func cancelStartingPointReplacement(projectId: String) {
        update(projectId) { $0.pendingStartingPointID = nil }
    }

    public func applyMigration(
        projectId: String,
        writeToRepository: Bool,
        packages: [ModulePackage] = []
    ) async {
        guard let preview = state(for: projectId).migration.preview,
            preview.canApply,
            let api = migrationAPI
        else { return }
        update(projectId) { $0.migration = .loading }
        do {
            let result = try await api.applyGuidedMigration(
                projectId: projectId,
                compositionFingerprint: preview.compositionFingerprint,
                writeToRepository: writeToRepository)
            await projects.refresh()
            await refresh(projectId: projectId, packages: packages)
            update(projectId) { $0.migration = .applied(result) }
        } catch {
            update(projectId) {
                $0.migration = .current(preview)
                $0.errorMessage = ProjectsModel.describe(error)
            }
        }
    }

    public func pauseForMigration(
        projectId: String,
        packages: [ModulePackage] = []
    ) async {
        guard let client else {
            update(projectId) { $0.errorMessage = Self.engineUnavailable }
            return
        }
        do {
            _ = try await client.pauseProject(projectId: projectId)
            await projects.refresh()
            await refresh(projectId: projectId, packages: packages)
        } catch {
            update(projectId) { $0.errorMessage = ProjectsModel.describe(error) }
        }
    }

    public func prepareFixedReconfiguration(projectId: String) {
        guard state(for: projectId).draft?.isFixedComposition != true,
            projectIsQuiescentForMigration(projectId: projectId)
        else { return }
        chooseStartingPoint(
            projectId: projectId,
            startingPointId: "github-development",
            confirmedReplacement: true)
    }

    private func projectIsQuiescentForMigration(projectId: String) -> Bool {
        guard let preview = state(for: projectId).migration.preview else { return false }
        return state(for: projectId).detail?.project.status == .paused
            && !preview.reasons.contains {
                $0.code == "project-active" || $0.code == "work-pending"
            }
    }

    public func setReadyLabel(projectId: String, label: String, moduleID: UUID? = nil) {
        editDraft(projectId: projectId, invalidatesVerification: false) { draft in
            guard
                let development = draft.modules.firstIndex(where: {
                    $0.moduleId == "jarvis.module.development"
                        && (moduleID == nil || $0.id == moduleID)
                })
            else { return }
            draft.modules[development].configurationValues["readyLabel"] = label
        }
    }

    public func stageGitHubConnection(projectId: String, connectionID: String) {
        let current = state(for: projectId)
        guard
            let module = current.draft?.modules.first(where: {
                $0.enabled && $0.moduleId == "jarvis.module.github"
            })
        else { return }
        let slots = Set(module.bindings.values)
        guard
            current.resourceChoices
                .filter({ slots.contains($0.slotId) })
                .flatMap(\.candidates)
                .contains(where: { $0.kind == .connection && $0.ref == connectionID })
        else { return }
        stageBinding(projectId: projectId, slots: slots, kind: .connection, ref: connectionID)
    }

    public func stageRuntime(projectId: String, ref: String) {
        let current = state(for: projectId)
        guard
            let slot = current.draft?.modules.first(where: {
                    $0.enabled && !$0.runtimeSlot.isEmpty
            })?.runtimeSlot,
            !slot.isEmpty,
            current.agentRuntimes?.items.contains(where: { $0.ref == ref && $0.selectable }) == true
        else { return }
        stageBinding(projectId: projectId, slots: [slot], kind: .runtime, ref: ref)
    }

    private func stageBinding(
        projectId: String,
        slots: Set<String>,
        kind: ProjectResourceKind,
        ref: String
    ) {
        guard !state(for: projectId).isSaving,
            var payload = state(for: projectId).localBindings?.wirePayload
        else { return }
        for slot in slots {
            let existing = payload.slots.additionalProperties[slot]
            if existing?.kind != kind.payload || existing?.ref != ref {
                payload.slots.additionalProperties[slot] = .init(kind: kind.payload, ref: ref)
            }
        }
        update(projectId) {
            $0.localBindings = LocalProjectBindings(payload: payload)
            $0.removedBindingSlots.subtract(slots)
            $0.hasPendingBindingEdits = true
            $0.isDraftSaved = false
            $0.saveFailed = false
            $0.errorMessage = nil
        }
        markValidationStale(projectId: projectId)
    }

    public func setGuidedReadyLabel(projectId: String, label: String) {
        editDraft(projectId: projectId, invalidatesVerification: false) { draft in
            for index in draft.modules.indices
            where draft.modules[index].moduleId == "jarvis.module.development" {
                draft.modules[index].configurationValues["readyLabel"] = label
            }
        }
    }

    public func refreshCompositionChoices(projectId: String) async {
        guard let client, let draft = state(for: projectId).draft,
            let portableConfig = try? draft.payload()
        else { return }
        let revision = compositionRevisions[projectId, default: 0]
        do {
            let review = try await client.reviewProjectComposition(
                projectId: projectId, portableConfig: portableConfig)
            let graph = try? await client.fetchProjectCompositionGraph(
                projectId: projectId, portableConfig: portableConfig)
            guard revision == compositionRevisions[projectId, default: 0] else { return }
            update(projectId) {
                $0.compositionGuide = review.compositionGuide
                $0.compositionReview = review
                $0.compositionGraph = graph
                $0.candidates = review.resourceChoices.candidates
                $0.resourceChoices = review.resourceChoices.slots
                $0.agentRuntimes = review.resourceChoices.agentRuntimes
                $0.runtimeMetadataUnavailable = $0.agentRuntimes == nil
                $0.errorMessage = nil
            }
        } catch {
            guard revision == compositionRevisions[projectId, default: 0] else { return }
            update(projectId) {
                $0.compositionGraph = nil
                $0.errorMessage =
                    "Impossible d’actualiser les choix du parcours. Votre brouillon est conservé. Réessayez cette modification ou rouvrez le projet."
            }
        }
    }

    public func addModule(projectId: String, package: ModulePackage) {
        let current = state(for: projectId)
        guard let draft = current.draft else { return }
        guard !draft.modules.contains(where: { $0.moduleId == package.moduleId }) else { return }
        if draft.isFixedComposition || (draft.modules.isEmpty && draft.slotRequirements.isEmpty),
            let guide = current.compositionGuide,
            let template = guide.startingPoints.first(where: { $0.id == "github-development" })?
                .template,
            let proposed = template.modules.first(where: { $0.moduleId == package.moduleId })
        {
            editDraft(projectId: projectId) { draft in
                if !draft.isFixedComposition {
                    var fixed = ProjectConfigurationDraft(
                        configuration: template, packages: guide.modulePackages)
                    fixed.name = draft.name
                    fixed.repositories = draft.repositories
                    fixed.modules = []
                    fixed.slotRequirements = [:]
                    draft = fixed
                }
                draft.modules.append(ProjectModuleDraft(payload: proposed, package: package))
                let slots =
                    Array(proposed.bindings?.additionalProperties.values ?? [:].values)
                    + [proposed.runtimeSlot].compactMap { $0 }
                for slot in slots where draft.slotRequirements[slot] == nil {
                    if let requirement = template.slots.additionalProperties[slot] {
                        draft.slotRequirements[slot] = ProjectSlotDraft(payload: requirement)
                    }
                }
            }
        } else {
            editDraft(projectId: projectId) { $0.add(package: package) }
        }
    }

    public func removeModule(projectId: String, moduleId: UUID) {
        guard let currentDraft = state(for: projectId).draft,
            let removed = currentDraft.modules.first(where: { $0.id == moduleId })
        else { return }
        let retainedSlots = Set(
            currentDraft.modules.filter { $0.id != moduleId }.flatMap { module in
                [module.runtimeSlot] + Array(module.bindings.values)
            })
        let removedSlots = Set(
            ([removed.runtimeSlot] + Array(removed.bindings.values)).filter {
                !$0.isEmpty && !retainedSlots.contains($0)
            })
        editDraft(projectId: projectId) { draft in
            draft.modules.removeAll { $0.id == moduleId }
            for slot in removedSlots { draft.slotRequirements[slot] = nil }
        }
        update(projectId) { state in
            state.removedBindingSlots.formUnion(removedSlots)
            guard var payload = state.localBindings?.wirePayload else { return }
            for slot in removedSlots { payload.slots.additionalProperties[slot] = nil }
            state.localBindings = LocalProjectBindings(payload: payload)
            state.resourceChoices.removeAll { removedSlots.contains($0.slotId) }
        }
    }

    public func addSlot(projectId: String, name: String, requirement: String) {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedRequirement = requirement.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty, !trimmedRequirement.isEmpty else {
            update(projectId) {
                $0.errorMessage =
                    "Name the Project slot and choose its required capability before adding it."
            }
            return
        }
        editDraft(projectId: projectId) { draft in
            guard draft.slotRequirements[trimmedName] == nil else { return }
            draft.slotRequirements[trimmedName] = ProjectSlotDraft(requires: trimmedRequirement)
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

    /// Applies synchronous Project Wizard edits through the presentation's action seam.
    public func apply(
        _ edit: ProjectDetailPresentation.Action.Edit,
        projectId: String,
        packages: [ModulePackage],
        bindingOptions: [String] = []
    ) {
        switch edit.operation {
        case .setProjectName(let name):
            editDraft(projectId: projectId) { $0.name = name }
        case .chooseStartingPoint(let id):
            chooseStartingPoint(projectId: projectId, startingPointId: id)
        case .addSlot(let name, let requirement):
            addSlot(projectId: projectId, name: name, requirement: requirement)
        case .removeSlot(let slotId):
            removeSlot(projectId: projectId, slotId: slotId)
        case .renameSlot(let oldName, let newName):
            renameSlot(projectId: projectId, from: oldName, to: newName)
        case .setSlotRequirement(let slotId, let requirement):
            editDraft(projectId: projectId) { $0.slotRequirements[slotId]?.requires = requirement }
        case .setSlotOptional(let slotId, let optional):
            editDraft(projectId: projectId) { $0.slotRequirements[slotId]?.optional = optional }
        case .setSlotDescription(let slotId, let description):
            editDraft(projectId: projectId) {
                $0.slotRequirements[slotId]?.description =
                    description?.isEmpty == true
                    ? nil : description
            }
        case .addModule(let packageId):
            guard let package = packages.first(where: { $0.moduleId == packageId }) else { return }
            addModule(projectId: projectId, package: package)
        case .removeModule(let moduleId):
            removeModule(projectId: projectId, moduleId: moduleId)
        case .setModulePackage(let moduleId, let packageId):
            guard let package = packages.first(where: { $0.moduleId == packageId }) else { return }
            editDraft(projectId: projectId) { $0.select(package: package, for: moduleId) }
        case .setModuleInstanceID(let moduleId, let instanceId):
            editModule(projectId: projectId, moduleId: moduleId) { $0.instanceId = instanceId }
        case .setModuleEnabled(let moduleId, let enabled):
            editModule(projectId: projectId, moduleId: moduleId) { $0.enabled = enabled }
        case .setModuleRuntimeSlot(let moduleId, let slotId):
            editModule(projectId: projectId, moduleId: moduleId) { $0.runtimeSlot = slotId }
        case .addModuleBinding(let moduleId):
            editModule(projectId: projectId, moduleId: moduleId) { module in
                var index = module.bindings.count + 1
                var key = "binding\(index)"
                while module.bindings[key] != nil {
                    index += 1
                    key = "binding\(index)"
                }
                module.bindings[key] = bindingOptions.first ?? "main"
            }
        case .removeModuleBinding(let moduleId, let key):
            editModule(projectId: projectId, moduleId: moduleId) { $0.bindings[key] = nil }
        case .renameModuleBinding(let moduleId, let oldKey, let newKey):
            guard !newKey.isEmpty, newKey != oldKey else { return }
            editModule(projectId: projectId, moduleId: moduleId) { module in
                guard module.bindings[newKey] == nil else { return }
                let value = module.bindings.removeValue(forKey: oldKey)
                module.bindings[newKey] = value
            }
        case .setModuleBinding(let moduleId, let key, let value):
            editModule(projectId: projectId, moduleId: moduleId) { $0.bindings[key] = value }
        case .setModuleConfiguration(let moduleId, let key, let value):
            if key == "readyLabel",
                state(for: projectId).draft?.modules.first(where: { $0.id == moduleId })?.moduleId
                    == "jarvis.module.development"
            {
                setReadyLabel(projectId: projectId, label: value, moduleID: moduleId)
                return
            }
            if key == "readyLabel" { return }
            editModule(projectId: projectId, moduleId: moduleId) {
                $0.configurationValues[key] = value
            }
        }
    }

    /// Performs asynchronous Project Configuration actions.
    public func perform(
        _ action: ProjectDetailPresentation.Action.Asynchronous,
        projectId: String
    ) async {
        switch action.operation {
        case .setLocalBinding(let slotId, let candidateId):
            let candidate = candidateId.flatMap { id in
                state(for: projectId).candidates.first { $0.id == id }
            }
            _ = await setLocalBinding(
                projectId: projectId, slotId: slotId, candidate: candidate)
        case .saveLocal:
            _ = await saveDraft(projectId: projectId, writeToRepository: false)
        case .validate:
            await validate(projectId: projectId)
        case .activate:
            await activate(projectId: projectId)
        case .confirmProjectDeletion:
            _ = await deleteProject(projectId: projectId)
        }
    }

    public func preflight(projectId: String) async {
        guard state(for: projectId).preflight != .loading else { return }
        guard state(for: projectId).draft == nil || state(for: projectId).isDraftSaved else {
            update(projectId) {
                $0.preflight = .stale($0.preflight.report)
                $0.errorMessage = "Enregistrez le brouillon avant de vérifier la configuration."
            }
            return
        }
        guard let api = preflightAPI else {
            update(projectId) { $0.preflight = .failed(Self.engineUnavailable) }
            return
        }
        let revision = validationRevisions[projectId, default: 0]
        update(projectId) {
            $0.preflight = .loading
            $0.activation = .idle
            $0.validation = .validating
        }
        do {
            let report = try await api.preflightProject(projectId: projectId)
            guard revision == validationRevisions[projectId, default: 0] else { return }
            guard report.projectId == projectId else {
                throw EngineClientError.unexpectedResponse(
                    "Le préflight appartient à un autre projet.")
            }
            let validation = try ProjectValidationReport(payload: report.validation)
            lastValidationReports[projectId] = validation
            update(projectId) {
                $0.preflight = .current(report)
                $0.preflightReceivedAt = Date()
                $0.pendingScopeDescription = nil
                $0.validation = report.valid ? .valid(validation) : .invalid(validation)
                $0.agentRuntimes = report.runtime
                $0.runtimeMetadataUnavailable = false
                $0.errorMessage = nil
            }
        } catch {
            guard revision == validationRevisions[projectId, default: 0] else { return }
            update(projectId) {
                $0.preflight = .failed(ProjectsModel.describe(error))
                $0.validation = .failed(ProjectsModel.describe(error))
            }
        }
    }

    public func scopeWorkflow(
        projectId: String, workItemRef: String?, packages: [ModulePackage] = []
    )
        async
    {
        guard case .current(let report) = state(for: projectId).preflight,
            state(for: projectId).isDraftSaved, let api = preflightAPI
        else { return }
        guard workItemRef != nil || state(for: projectId).canRestoreTrial else { return }
        guard report.configuredWorkItemRef == nil || state(for: projectId).canRestoreTrial else {
            update(projectId) {
                $0.errorMessage =
                    "La portée possède déjà un filtre exact. Relancez la vérification pour modifier le périmètre."
            }
            return
        }
        let revision = validationRevisions[projectId, default: 0]
        guard state(for: projectId).activation != .activating else { return }
        update(projectId) {
            $0.preflight = .loading
            $0.activation = .idle
        }
        do {
            let configuration = try await api.scopePreflightProject(
                projectId: projectId, fingerprint: report.compositionFingerprint,
                workItemRef: workItemRef)
            guard revision == validationRevisions[projectId, default: 0] else { return }
            markValidationStale(projectId: projectId)
            update(projectId) {
                $0.draft = ProjectConfigurationDraft(
                    configuration: configuration, packages: packages)
                $0.isDraftSaved = false
            }
            // The Engine returned a scoped fixed-module configuration. Saving it
            // withdraws the old active composition; activation remains explicit.
            guard await saveDraft(projectId: projectId, writeToRepository: false) != nil else {
                return
            }
            UserDefaults.standard.set(
                workItemRef,
                forKey: "\(projects.preferenceNamespace)dev.jarvis.project-trial.v1.\(projectId)")
            update(projectId) {
                $0.trialWorkItemRef = workItemRef
                $0.pendingScopeDescription =
                    workItemRef.map { "Essai limité à \(ProjectPreflightState.issueLabel($0))" }
                    ?? "Surveillance des issues prêtes — vérifiez à nouveau, puis activez explicitement."
                $0.preflight = .stale(nil)
            }
            await projects.refresh()
            if workItemRef != nil { await preflight(projectId: projectId) }
        } catch {
            guard revision == validationRevisions[projectId, default: 0] else { return }
            update(projectId) {
                $0.preflight = .failed(ProjectsModel.describe(error))
                $0.errorMessage = ProjectsModel.describe(error)
            }
        }
    }

    public func activateWorkflow(projectId: String) async {
        guard case .current(let report) = state(for: projectId).preflight,
            report.projectId == projectId, state(for: projectId).preflight.canStartWorkflow,
            state(for: projectId).draft == nil || state(for: projectId).isDraftSaved,
            state(for: projectId).activation != .activating,
            state(for: projectId).runtimeAllowsActivation, let api = preflightAPI
        else { return }
        update(projectId) { $0.activation = .activating }
        do {
            _ = try await api.activatePreflightProject(
                projectId: projectId, fingerprint: report.compositionFingerprint)
            update(projectId) { $0.activation = .succeeded }
            await projects.refresh()
        } catch let EngineClientError.engineError(_, code, message) {
            update(projectId) { $0.activation = .rejected(code: code, message: message) }
        } catch {
            update(projectId) { $0.activation = .transportFailure(ProjectsModel.describe(error)) }
        }
    }

    public func validate(projectId: String) async {
        let previousValidation = state(for: projectId).validation
        guard previousValidation != .validating else { return }
        let provider: ValidationReportProvider
        if let validationReportProvider {
            provider = validationReportProvider
        } else if let client {
            provider = { try await client.generateProjectValidationReport(projectId: $0) }
        } else {
            update(projectId) { $0.errorMessage = Self.engineUnavailable }
            return
        }

        let revision = validationRevisions[projectId, default: 0]
        update(projectId) {
            $0.validation = .validating
            $0.errorMessage = nil
        }
        do {
            let report = try await provider(projectId)
            guard revision == validationRevisions[projectId, default: 0] else { return }
            guard report.projectId == projectId else {
                update(projectId) {
                    $0.validation = .failed(
                        "The validation response belongs to a different Project. Reload this Project and validate again."
                    )
                }
                return
            }
            lastValidationReports[projectId] = report
            update(projectId) {
                $0.validation = report.valid ? .valid(report) : .invalid(report)
            }
        } catch is CancellationError {
            guard revision == validationRevisions[projectId, default: 0] else { return }
            update(projectId) { $0.validation = previousValidation }
        } catch {
            guard revision == validationRevisions[projectId, default: 0] else { return }
            let cause = ProjectsModel.describe(error)
            update(projectId) {
                $0.validation = .failed(
                    "Validation report is unavailable, so Project readiness cannot be determined. \(cause) Retry validation after correcting the problem."
                )
                $0.errorMessage = nil
            }
        }
    }

    /// Ticket #55: turns the #45 readiness signal into a real request. Only
    /// the exact report the Wizard currently shows for this Project can
    /// activate — its `compositionFingerprint` travels back verbatim, and its
    /// absence refuses activation locally rather than guessing or omitting
    /// it. The engine alone decides whether that fingerprint is still current;
    /// this method only reflects and forwards its answer.
    public func activate(projectId: String) async {
        guard state(for: projectId).runtimeAllowsActivation else {
            update(projectId) {
                $0.activation = .rejected(
                    code: nil,
                    message:
                        "Development ne peut pas démarrer. Vérifiez le runtime du projet avant d’activer le workflow."
                )
            }
            return
        }
        guard case .valid(let report) = state(for: projectId).validation,
            report.projectId == projectId
        else {
            update(projectId) {
                $0.activation = .rejected(
                    code: nil,
                    message:
                        "No current successful validation report is displayed for this Project. Validate again before activating."
                )
            }
            return
        }
        guard let fingerprint = report.compositionFingerprint else {
            update(projectId) {
                $0.activation = .rejected(
                    code: nil,
                    message:
                        "The displayed validation report carries no composition fingerprint, so activation was refused rather than guessed. Validate again."
                )
            }
            return
        }
        let provider: ActivationProvider
        if let activationProvider {
            provider = activationProvider
        } else if let client {
            provider = {
                try await client.activateProject(projectId: $0, compositionFingerprint: $1)
            }
        } else {
            update(projectId) { $0.activation = .transportFailure(Self.engineUnavailable) }
            return
        }
        update(projectId) { $0.activation = .activating }
        do {
            _ = try await provider(projectId, fingerprint)
            update(projectId) { $0.activation = .succeeded }
            await projects.refresh()
        } catch let EngineClientError.engineError(_, code, message) {
            update(projectId) { $0.activation = .rejected(code: code, message: message) }
        } catch {
            update(projectId) {
                $0.activation = .transportFailure(ProjectsModel.describe(error))
            }
        }
    }

    @discardableResult
    public func deleteProject(projectId: String) async -> ProjectDeletionResult {
        guard let detail = state(for: projectId).detail, detail.project.id == projectId else {
            let message =
                "Project details are not loaded, so deletion was not attempted. Reload this Project and try again."
            update(projectId) { $0.errorMessage = message }
            return .engineFailure(message)
        }
        let result = await projects.deleteProject(detail: detail)
        if result.engineDeletionSucceeded { states[projectId] = nil }
        return result
    }

    @discardableResult
    public func saveDraft(projectId: String, writeToRepository: Bool) async -> ProjectDetail? {
        do {
            guard let draft = state(for: projectId).draft else {
                update(projectId) {
                    $0.saveFailed = true
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
            update(projectId) {
                $0.saveFailed = true
                $0.errorMessage = error.localizedDescription
            }
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
            update(projectId) {
                $0.saveFailed = true
                $0.errorMessage = Self.engineUnavailable
            }
            return nil
        }
        let draftAtSaveStart = state(for: projectId).draft
        let removedBindingSlots = state(for: projectId).removedBindingSlots
        var stagedBindings: Components.Schemas.ProjectBindings?
        if state(for: projectId).hasPendingBindingEdits || !removedBindingSlots.isEmpty {
            stagedBindings = state(for: projectId).localBindings?.wirePayload
            for slot in removedBindingSlots {
                stagedBindings?.slots.additionalProperties[slot] = nil
            }
        }
        update(projectId) {
            $0.isSaving = true
            $0.saveFailed = false
        }
        defer { update(projectId) { $0.isSaving = false } }
        do {
            let detail = try await client.replaceProjectConfiguration(
                projectId: projectId,
                portableConfig: portableConfig,
                writeToRepository: writeToRepository,
                bindings: stagedBindings)
            // The settings picker stages a CLI choice; the Engine owns its local profile.
            let runtimeSlots = Set(
                portableConfig.modules.filter(\.enabled).compactMap(\.runtimeSlot))
            for slot in runtimeSlots.sorted() {
                guard let binding = stagedBindings?.slots.additionalProperties[slot],
                    binding.kind == .runtime,
                    binding.environment?.additionalProperties["PATH"]?
                        .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false
                else { continue }
                _ = try await client.bindProjectRuntime(projectId: projectId, ref: binding.ref)
            }
            var reloadErrors: [String] = []
            let persistedPreflight: Components.Schemas.ProjectPreflightV1?
            if let preflightAPI {
                do {
                    persistedPreflight = try await preflightAPI.currentProjectPreflight(
                        projectId: projectId)
                } catch {
                    persistedPreflight = nil
                    reloadErrors.append(
                        "Le brouillon est enregistré, mais sa vérification n’a pas pu être rechargée. Vérifiez à nouveau avant de l’appliquer.")
                }
            } else {
                persistedPreflight = nil
            }
            let bindings: LocalProjectBindings?
            do {
                bindings = try await client.getProjectBindings(projectId: projectId)
            } catch {
                bindings = nil
                reloadErrors.append(
                    "Le brouillon est enregistré, mais ses autorisations locales n’ont pas pu être rechargées. Rechargez ce projet avant de continuer.")
            }
            let review: ProjectCompositionReview?
            let reviewError: String?
            do {
                review = try await client.reviewProjectComposition(projectId: projectId)
                reviewError = nil
            } catch {
                review = nil
                let message =
                    "The Draft was saved, but its Engine review could not be refreshed. Reload this Project before validation."
                reviewError = message
                reloadErrors.append(message)
            }
            let graph = try? await client.fetchProjectCompositionGraph(
                projectId: projectId, portableConfig: nil)
            update(projectId) {
                $0.detail = detail
                $0.saveFailed = false
                guard $0.draft == draftAtSaveStart else {
                    $0.isDraftSaved = false
                    return
                }
                let savedSlots = detail.portableConfiguration?.slots.additionalProperties ?? [:]
                let retainedSlots =
                    $0.draft?.slotRequirements.filter { savedSlots[$0.key] != nil } ?? [:]
                $0.draft?.slotRequirements = retainedSlots
                $0.localBindings = bindings
                $0.removedBindingSlots.subtract(removedBindingSlots)
                $0.hasPendingBindingEdits = false
                $0.compositionGraph = graph
                $0.compositionGuide = review?.compositionGuide ?? $0.compositionGuide
                $0.compositionReview = review
                $0.candidates = review?.resourceChoices.candidates ?? []
                $0.resourceChoices = review?.resourceChoices.slots ?? []
                $0.runtimeMetadataUnavailable = review?.resourceChoices.agentRuntimes == nil
                $0.agentRuntimes = review?.resourceChoices.agentRuntimes ?? $0.agentRuntimes
                if let persistedPreflight {
                    $0.preflight = .current(persistedPreflight)
                    $0.agentRuntimes = persistedPreflight.runtime
                    $0.runtimeMetadataUnavailable = false
                }
                $0.isDraftSaved = true
                $0.errorMessage = reloadErrors.isEmpty ? reviewError : reloadErrors.joined(separator: " ")
            }
            update(projectId) { $0.isSaving = false }
            await projects.refresh()
            return detail
        } catch {
            update(projectId) {
                $0.saveFailed = true
                $0.errorMessage = ProjectsModel.describe(error)
            }
            return nil
        }
    }

    public func refreshRuntimeCandidates(
        projectId: String,
        discover: Bool = false,
        autoSelectUnique: Bool = true
    ) async {
        let hasUnsavedDraft =
            state(for: projectId).draft != nil
            && !state(for: projectId).isDraftSaved
        await runtimeOperation(projectId: projectId) { api in
            if discover { try await api.discoverProjectRuntimes() }
            guard
                let choices = try await api.listProjectBindingCandidates(projectId: projectId)
                    .agentRuntimes
            else {
                throw EngineClientError.unexpectedResponse("Runtime resources are unavailable")
            }
            return choices
        }
        if hasUnsavedDraft {
            await refreshCompositionChoices(projectId: projectId)
        }
        if autoSelectUnique {
            let choices = state(for: projectId).agentRuntimes
            await autoSelectUniqueRuntime(
                projectId: projectId,
                choices: choices,
                requiresSavedDraft: false)
        }
    }

    private func autoSelectUniqueConnection(projectId: String) async {
        guard state(for: projectId).isDraftSaved, !state(for: projectId).isSaving else { return }
        guard
            let choice = state(for: projectId).resourceChoices.first(where: {
                $0.status == .available && $0.candidates.count == 1
                    && $0.candidates[0].kind == .connection
            }), let candidate = choice.candidates.first
        else { return }
        _ = await bindGitHubConnection(projectId: projectId, connectionID: candidate.ref)
    }

    private func autoSelectUniqueRuntime(
        projectId: String,
        choices: Components.Schemas.ProjectAgentRuntimeChoices? = nil,
        requiresSavedDraft: Bool = true
    ) async {
        guard !requiresSavedDraft || state(for: projectId).isDraftSaved,
            !state(for: projectId).isSaving
        else { return }
        let choices = choices ?? state(for: projectId).agentRuntimes
        let selectable = choices?.items.filter(\.selectable) ?? []
        guard choices?.required == true,
            choices?.readiness.status == .unchecked,
            selectable.count == 1,
            selectable[0].bound == false
        else { return }
        await chooseRuntime(projectId: projectId, ref: selectable[0].ref)
    }

    public func chooseRuntime(projectId: String, ref: String) async {
        guard !state(for: projectId).isRuntimeBusy && !state(for: projectId).isSaving else {
            return
        }
        // Choosing also confirms the displayed local tool/login profile. The
        // server resolves slots and values; Swift never invents execution policy.
        if state(for: projectId).draft != nil && !state(for: projectId).isDraftSaved {
            guard await saveDraft(projectId: projectId, writeToRepository: false) != nil else {
                return
            }
        }
        markValidationStale(projectId: projectId)
        update(projectId) { $0.isSaving = true }
        defer { update(projectId) { $0.isSaving = false } }
        await runtimeOperation(projectId: projectId) { api in
            try await api.bindProjectRuntime(projectId: projectId, ref: ref)
        }
        if let runtimeAPI {
            do {
                let bindings = try await runtimeAPI.getProjectBindings(projectId: projectId)
                update(projectId) { $0.localBindings = bindings }
            } catch {
                invalidateRuntime(projectId: projectId)
                update(projectId) {
                    $0.localBindings = nil
                    $0.errorMessage =
                        "Le choix local n’a pas pu être rechargé. Rechargez le projet avant de continuer."
                }
                return
            }
        }
        if state(for: projectId).agentRuntimes?.readiness.status != .engine_hyphen_error {
            await checkRuntime(projectId: projectId)
        }
    }

    public func checkRuntime(projectId: String) async {
        guard state(for: projectId).draft == nil || state(for: projectId).isDraftSaved else {
            invalidateRuntime(projectId: projectId)
            update(projectId) {
                $0.agentRuntimes?.readiness.detail =
                    "Enregistrez le brouillon avant de vérifier son profil d’exécution."
            }
            return
        }
        await runtimeOperation(projectId: projectId) { api in
            try await api.checkProjectRuntime(projectId: projectId)
        }
    }

    private func runtimeOperation(
        projectId: String,
        operation: (any ProjectRuntimeAPI) async throws ->
            Components.Schemas.ProjectAgentRuntimeChoices
    ) async {
        guard !state(for: projectId).isRuntimeBusy else { return }
        runtimeRevisions[projectId, default: 0] += 1
        let revision = runtimeRevisions[projectId, default: 0]
        update(projectId) {
            $0.isRuntimeBusy = true
            $0.agentRuntimes?.readiness = .init(
                status: .checking, checkedAt: nil,
                detail: "Vérification en cours. Development ne peut pas démarrer.")
        }
        defer {
            if revision == runtimeRevisions[projectId, default: 0] {
                update(projectId) { $0.isRuntimeBusy = false }
            }
        }
        do {
            guard let runtimeAPI else {
                throw EngineClientError.unexpectedResponse("Engine unavailable")
            }
            let choices = try await operation(runtimeAPI)
            guard revision == runtimeRevisions[projectId, default: 0] else { return }
            update(projectId) {
                $0.agentRuntimes = choices
                $0.runtimeMetadataUnavailable = false
            }
        } catch {
            guard revision == runtimeRevisions[projectId, default: 0] else { return }
            update(projectId) {
                var choices =
                    $0.agentRuntimes
                    ?? .init(
                        required: true, items: [],
                        readiness: .init(status: .unchecked, checkedAt: nil, detail: ""))
                // Transport/provider errors may contain paths or credentials.
                choices.readiness = .init(
                    status: .engine_hyphen_error, checkedAt: nil,
                    detail:
                        "Le moteur ne peut pas vérifier le runtime. Development ne peut pas démarrer. Rétablissez la connexion au moteur, puis réessayez."
                )
                $0.agentRuntimes = choices
            }
        }
    }

    private func invalidateRuntime(projectId: String) {
        runtimeRevisions[projectId, default: 0] += 1
        update(projectId) {
            $0.isRuntimeBusy = false
            $0.agentRuntimes?.readiness = .init(
                status: .unchecked, checkedAt: nil,
                detail: "Le projet a changé ou a été rechargé. Vérifiez à nouveau le runtime.")
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

    /// Binds one discovered GitHub account only to the compatible slots of this Project.
    @discardableResult
    public func bindGitHubConnection(
        projectId: String,
        connectionID: String
    ) async -> LocalProjectBindings? {
        guard !state(for: projectId).isSaving else { return nil }
        if state(for: projectId).draft != nil && !state(for: projectId).isDraftSaved {
            guard await saveDraft(projectId: projectId, writeToRepository: false) != nil else {
                return nil
            }
        }
        let current = state(for: projectId)
        guard var payload = current.localBindings?.wirePayload else {
            update(projectId) {
                $0.errorMessage =
                    "Local Bindings are not loaded. Reload this Project before binding a GitHub account."
            }
            return nil
        }
        guard
            let candidate = current.candidates.first(where: {
                $0.kind == .connection && $0.ref == connectionID
            })
        else {
            update(projectId) {
                $0.errorMessage =
                    "This GitHub account is not available to the current Project. Refresh the accounts and try again."
            }
            return nil
        }
        let slots = current.resourceChoices.filter { choice in
            choice.candidates.contains(candidate)
        }
        guard !slots.isEmpty else {
            update(projectId) {
                $0.errorMessage =
                    "This GitHub account does not satisfy a Project binding requirement. Choose a compatible account."
            }
            return nil
        }
        for slot in slots {
            payload.slots.additionalProperties[slot.slotId] = .init(
                kind: candidate.kind.payload, ref: candidate.ref)
        }
        return await saveBindings(projectId: projectId, bindings: payload)
    }

    public func hasLocalBinding(projectId: String, connectionID: String) -> Bool {
        let current = state(for: projectId)
        guard let bindings = current.localBindings?.wirePayload.slots.additionalProperties else {
            return false
        }
        return current.resourceChoices.contains { choice in
            guard bindings[choice.slotId]?.kind == .connection,
                bindings[choice.slotId]?.ref == connectionID
            else { return false }
            return true
        }
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
            markValidationStale(projectId: projectId)
            update(projectId) {
                $0.localBindings = saved
                $0.errorMessage = nil
            }
            do {
                let current = state(for: projectId)
                let portableConfig = current.draft.flatMap { try? $0.payload() }
                let review = try await client.reviewProjectComposition(
                    projectId: projectId,
                    portableConfig: current.isDraftSaved ? nil : portableConfig)
                update(projectId) {
                    $0.candidates = review.resourceChoices.candidates
                    $0.resourceChoices = review.resourceChoices.slots
                    $0.agentRuntimes = review.resourceChoices.agentRuntimes
                    $0.runtimeMetadataUnavailable = $0.agentRuntimes == nil
                    $0.compositionGuide = review.compositionGuide
                    $0.compositionReview = review
                }
            } catch {
                update(projectId) {
                    $0.errorMessage =
                        "The Local Binding was saved, but resource and Event choices could not be refreshed. Your Draft was preserved; reload this Project."
                }
            }
            return saved
        } catch {
            update(projectId) { $0.errorMessage = ProjectsModel.describe(error) }
            return nil
        }
    }

    private func markValidationStale(projectId: String) {
        update(projectId) { $0.preflight = .stale($0.preflight.report) }

        invalidateRuntime(projectId: projectId)
        validationRevisions[projectId, default: 0] += 1
        let current = state(for: projectId).validation
        let report: ProjectValidationReport?
        switch current {
        case .valid(let value), .invalid(let value), .stale(let value):
            report = value
        case .validating:
            report = lastValidationReports[projectId]
        case .unvalidated, .failed:
            report = nil
        }
        if let report {
            lastValidationReports[projectId] = report
            update(projectId) {
                $0.validation = .stale(report)
                $0.activation = .idle
            }
        } else {
            update(projectId) {
                $0.validation = .unvalidated
                $0.activation = .idle
            }
        }
    }

    private func editModule(
        projectId: String,
        moduleId: UUID,
        _ edit: (inout ProjectModuleDraft) -> Void
    ) {
        editDraft(projectId: projectId) { draft in
            guard let index = draft.modules.firstIndex(where: { $0.id == moduleId }) else { return }
            edit(&draft.modules[index])
        }
    }

    private static let engineUnavailable =
        "The engine is not running. Project Configuration cannot be loaded or saved. Restart Jarvis."

    private func update(
        _ projectId: String,
        _ change: (inout ProjectConfigurationState) -> Void
    ) {
        var value = state(for: projectId)
        change(&value)
        states[projectId] = value
    }
}
