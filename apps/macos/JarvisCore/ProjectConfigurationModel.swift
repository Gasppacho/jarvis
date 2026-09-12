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
    public var validation: ProjectValidationState = .unvalidated
    public var activation: ProjectActivationState = .idle
    public var draft: ProjectConfigurationDraft?
    public var isDraftSaved = false
    public var isLoading = false
    public var isSaving = false
    public var errorMessage: String?
    public var agentRuntimes: Components.Schemas.ProjectAgentRuntimeChoices?
    public var isRuntimeBusy = false
    public var runtimeMetadataUnavailable = false
    public var runtimePresentation: ProjectRuntimePresentation {
        ProjectRuntimePresentation(choices: agentRuntimes, isBusy: isRuntimeBusy)
    }
    public var runtimeAllowsActivation: Bool {
        !runtimeMetadataUnavailable && !isRuntimeBusy && (agentRuntimes?.required != true || agentRuntimes?.readiness.status == .ready)
    }
}

/// Project Wizard coordinator for composition edits and project-scoped grants.
/// Project import/list state remains owned by `ProjectsModel`.
@MainActor
@Observable
public final class ProjectConfigurationModel {
    public private(set) var states: [String: ProjectConfigurationState] = [:]

    typealias ValidationReportProvider = @Sendable (String) async throws
        -> ProjectValidationReport
    typealias ActivationProvider = @Sendable (String, String) async throws -> Project

    private let session: EngineSessionModel
    private let projects: ProjectsModel
    private let validationReportProvider: ValidationReportProvider?
    private let activationProvider: ActivationProvider?
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
    }

    init(
        session: EngineSessionModel,
        projects: ProjectsModel,
        validationReportProvider: ValidationReportProvider? = nil,
        activationProvider: ActivationProvider? = nil,
        runtimeAPI: (any ProjectRuntimeAPI)? = nil
    ) {
        self.session = session
        self.projects = projects
        self.validationReportProvider = validationReportProvider
        self.activationProvider = activationProvider
        injectedRuntimeAPI = runtimeAPI
    }

    private var client: EngineClient? { session.client }

    public func state(for projectId: String) -> ProjectConfigurationState {
        states[projectId] ?? ProjectConfigurationState()
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

    private func refresh(
        projectId: String,
        packages: [ModulePackage],
        preservingStaleValidation: Bool
    ) async {
        invalidateRuntime(projectId: projectId)
        guard let client else {
            update(projectId) { $0.errorMessage = Self.engineUnavailable }
            return
        }
        refreshRevisions[projectId, default: 0] += 1
        let refreshRevision = refreshRevisions[projectId, default: 0]
        let preservedDraft = state(for: projectId).isDraftSaved ? nil : state(for: projectId).draft
        validationRevisions[projectId, default: 0] += 1
        if !preservingStaleValidation {
            lastValidationReports[projectId] = nil
        }
        update(projectId) {
            $0.isLoading = true
            if !preservingStaleValidation {
                // A report evaluates the previously loaded snapshot. Reopening or
                // reloading requires a fresh engine evaluation before it is current.
                $0.validation = .unvalidated
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
            let compositionReview = try await client.reviewProjectComposition(
                projectId: projectId,
                portableConfig: previewConfiguration)
            let compositionGraph = try? await client.fetchProjectCompositionGraph(
                projectId: projectId,
                portableConfig: previewConfiguration)
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
                $0.localBindings = bindings
                $0.candidates = compositionReview.resourceChoices.candidates
                $0.resourceChoices = compositionReview.resourceChoices.slots
                $0.agentRuntimes = compositionReview.resourceChoices.agentRuntimes
                $0.runtimeMetadataUnavailable = $0.agentRuntimes == nil
                $0.compositionGuide = compositionReview.compositionGuide
                $0.compositionReview = compositionReview
                $0.compositionGraph = compositionGraph
                $0.draft = preservedDraft ?? draft
                $0.isDraftSaved = preservedDraft == nil
                $0.errorMessage = nil
            }
        } catch {
            guard refreshRevisions[projectId, default: 0] == refreshRevision else { return }
            update(projectId) {
                $0.errorMessage = ProjectsModel.describe(error)
            }
        }
    }

    public func editDraft(
        projectId: String,
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
            state.isDraftSaved = false
            state.errorMessage = nil
            didEdit = true
        }
        guard didEdit else { return }
        compositionRevisions[projectId, default: 0] += 1
        markValidationStale(projectId: projectId)
        Task { await refreshCompositionChoices(projectId: projectId) }
    }

    /// Applies an Engine-proposed repository reference replacement to the
    /// in-memory Draft only. Writing `.jarvis/project.yaml` remains the
    /// separate explicit `saveRepository` action.
    public func applyRepositoryReferenceReplacement(
        projectId: String,
        moduleInstanceID: String,
        replacement: ProjectRepositoryReferenceReplacement
    ) {
        guard replacement.field == "/configuration/repositories" else { return }
        editDraft(projectId: projectId) { draft in
            guard let index = draft.modules.firstIndex(where: {
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

    public func chooseStartingPoint(projectId: String, startingPointId: String) {
        guard let guide = state(for: projectId).compositionGuide,
            let startingPoint = guide.startingPoints.first(where: { $0.id == startingPointId })
        else { return }
        if let template = startingPoint.template {
            update(projectId) {
                $0.draft = ProjectConfigurationDraft(
                    configuration: template, packages: guide.modulePackages)
                $0.compositionReview = nil
                $0.isDraftSaved = false
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
                $0.errorMessage =
                    "Composition choices could not be refreshed. Your Draft was preserved. Try the edit again or reload this Project."
            }
        }
    }

    public func addModule(projectId: String, package: ModulePackage) {
        editDraft(projectId: projectId) { $0.add(package: package) }
    }

    public func removeModule(projectId: String, moduleId: UUID) {
        editDraft(projectId: projectId) { $0.modules.removeAll { $0.id == moduleId } }
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
            editModule(projectId: projectId, moduleId: moduleId) {
                $0.configurationValues[key] = value
            }
        case .addAutomationRule(let moduleID):
            guard
                let module = state(for: projectId).draft?.modules.first(where: {
                $0.id == moduleID
            }),
                let choices = state(for: projectId).compositionGuide?.eventChoices,
                let input = choices.first(where: {
                    $0.kind == "fact"
                        && $0.compatibleConsumerInstanceIDs.contains(module.instanceId)
                }),
                let emission = choices.first(where: {
                    $0.kind == "request"
                        && $0.producerInstanceIDs.contains(module.instanceId)
                })
            else { return }
            editDraft(projectId: projectId) {
                $0.addAutomationRule(
                    moduleID: moduleID,
                    inputEventType: input.type,
                    emissionEventType: emission.type,
                    resolvedConsumerID: emission.selectedConsumerID
                        ?? emission.compatibleConsumerInstanceIDs.first)
            }
        case .removeAutomationRule(let moduleID, let ruleID):
            editDraft(projectId: projectId) {
                $0.removeAutomationRule(moduleID: moduleID, ruleID: ruleID)
            }
        case .setAutomationRuleID(let moduleID, let ruleID, let value):
            editDraft(projectId: projectId) {
                $0.setAutomationRuleID(moduleID: moduleID, ruleID: ruleID, value: value)
            }
        case .setAutomationRuleInput(let moduleID, let ruleID, let eventType):
            editDraft(projectId: projectId) {
                $0.setAutomationRuleInput(
                    moduleID: moduleID, ruleID: ruleID, eventType: eventType)
            }
        case .setAutomationRuleMatch(let moduleID, let ruleID, let json):
            editDraft(projectId: projectId) {
                $0.setAutomationRuleMatch(moduleID: moduleID, ruleID: ruleID, json: json)
            }
        case .setAutomationRuleEmission(
            let moduleID, let ruleID, let eventType, let resolvedConsumerID):
            editDraft(projectId: projectId) {
                $0.setAutomationRuleEmission(
                    moduleID: moduleID,
                    ruleID: ruleID,
                    eventType: eventType,
                    resolvedConsumerID: resolvedConsumerID)
            }
        case .setAutomationRulePayload(let moduleID, let ruleID, let json):
            editDraft(projectId: projectId) {
                $0.setAutomationRulePayload(moduleID: moduleID, ruleID: ruleID, json: json)
            }
        case .setAutomationRuleTarget(let moduleID, let ruleID, let target):
            editDraft(projectId: projectId) {
                $0.setAutomationRuleTarget(
                    moduleID: moduleID,
                    ruleID: ruleID,
                    target: .moduleInstance(target))
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
        case .saveRepository:
            _ = await saveDraft(projectId: projectId, writeToRepository: true)
        case .validate:
            await validate(projectId: projectId)
        case .activate:
            await activate(projectId: projectId)
        case .confirmProjectDeletion:
            _ = await deleteProject(projectId: projectId)
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
                        "The validation response belongs to a different Project. Reload this Project and validate again.")
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
                    "Validation report is unavailable, so Project readiness cannot be determined. \(cause) Retry validation after correcting the problem.")
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
            update(projectId) { $0.activation = .rejected(code: nil, message: "Development ne peut pas démarrer. Vérifiez le runtime du projet avant d’activer le workflow.") }
            return
        }
        guard case .valid(let report) = state(for: projectId).validation,
            report.projectId == projectId
        else {
            update(projectId) {
                $0.activation = .rejected(
                    code: nil,
                    message:
                        "No current successful validation report is displayed for this Project. Validate again before activating.")
            }
            return
        }
        guard let fingerprint = report.compositionFingerprint else {
            update(projectId) {
                $0.activation = .rejected(
                    code: nil,
                    message:
                        "The displayed validation report carries no composition fingerprint, so activation was refused rather than guessed. Validate again.")
            }
            return
        }
        let provider: ActivationProvider
        if let activationProvider {
            provider = activationProvider
        } else if let client {
            provider = { try await client.activateProject(projectId: $0, compositionFingerprint: $1) }
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
            markValidationStale(projectId: projectId)
            let review: ProjectCompositionReview?
            let reviewError: String?
            do {
                review = try await client.reviewProjectComposition(projectId: projectId)
                reviewError = nil
            } catch {
                review = nil
                reviewError =
                    "The Draft was saved, but its Engine review could not be refreshed. Reload this Project before validation."
            }
            update(projectId) {
                $0.detail = detail
                $0.compositionGuide = review?.compositionGuide ?? $0.compositionGuide
                $0.compositionReview = review
                $0.candidates = review?.resourceChoices.candidates ?? []
                $0.resourceChoices = review?.resourceChoices.slots ?? []
                $0.runtimeMetadataUnavailable = review?.resourceChoices.agentRuntimes == nil
                $0.agentRuntimes = review?.resourceChoices.agentRuntimes ?? $0.agentRuntimes
                $0.isDraftSaved = true
                $0.errorMessage = reviewError
            }
            await projects.refresh()
            return detail
        } catch {
            update(projectId) { $0.errorMessage = ProjectsModel.describe(error) }
            return nil
        }
    }

    public func refreshRuntimeCandidates(projectId: String, discover: Bool = false) async {
        await runtimeOperation(projectId: projectId) { api in
            if discover { try await api.discoverProjectRuntimes() }
            guard let choices = try await api.listProjectBindingCandidates(projectId: projectId).agentRuntimes else {
                throw EngineClientError.unexpectedResponse("Runtime resources are unavailable")
            }
            return choices
        }
    }

    public func chooseRuntime(projectId: String, ref: String) async {
        guard !state(for: projectId).isRuntimeBusy && !state(for: projectId).isSaving else { return }
        // Choosing also confirms the displayed local tool/login profile. The
        // server resolves slots and values; Swift never invents execution policy.
        if state(for: projectId).draft != nil && !state(for: projectId).isDraftSaved {
            guard await saveDraft(projectId: projectId, writeToRepository: false) != nil else { return }
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
                    $0.errorMessage = "Le choix local n’a pas pu être rechargé. Rechargez le projet avant de continuer."
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
                $0.agentRuntimes?.readiness.detail = "Enregistrez le brouillon avant de vérifier son profil d’exécution."
            }
            return
        }
        await runtimeOperation(projectId: projectId) { api in
            try await api.checkProjectRuntime(projectId: projectId)
        }
    }

    private func runtimeOperation(
        projectId: String,
        operation: (any ProjectRuntimeAPI) async throws -> Components.Schemas.ProjectAgentRuntimeChoices
    ) async {
        guard !state(for: projectId).isRuntimeBusy else { return }
        runtimeRevisions[projectId, default: 0] += 1
        let revision = runtimeRevisions[projectId, default: 0]
        update(projectId) {
            $0.isRuntimeBusy = true
            $0.agentRuntimes?.readiness = .init(status: .checking, checkedAt: nil, detail: "Vérification en cours. Development ne peut pas démarrer.")
        }
        defer {
            if revision == runtimeRevisions[projectId, default: 0] { update(projectId) { $0.isRuntimeBusy = false } }
        }
        do {
            guard let runtimeAPI else { throw EngineClientError.unexpectedResponse("Engine unavailable") }
            let choices = try await operation(runtimeAPI)
            guard revision == runtimeRevisions[projectId, default: 0] else { return }
            update(projectId) { $0.agentRuntimes = choices; $0.runtimeMetadataUnavailable = false }
        } catch {
            guard revision == runtimeRevisions[projectId, default: 0] else { return }
            update(projectId) {
                var choices = $0.agentRuntimes ?? .init(required: true, items: [], readiness: .init(status: .unchecked, checkedAt: nil, detail: ""))
                // Transport/provider errors may contain paths or credentials.
                choices.readiness = .init(status: .engine_hyphen_error, checkedAt: nil, detail: "Le moteur ne peut pas vérifier le runtime. Development ne peut pas démarrer. Rétablissez la connexion au moteur, puis réessayez.")
                $0.agentRuntimes = choices
            }
        }
    }

    private func invalidateRuntime(projectId: String) {
        runtimeRevisions[projectId, default: 0] += 1
        update(projectId) {
            $0.isRuntimeBusy = false
            $0.agentRuntimes?.readiness = .init(status: .unchecked, checkedAt: nil, detail: "Le projet a changé ou a été rechargé. Vérifiez à nouveau le runtime.")
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
        let current = state(for: projectId)
        guard var payload = current.localBindings?.wirePayload else {
            update(projectId) {
                $0.errorMessage =
                    "Local Bindings are not loaded. Reload this Project before binding a GitHub account."
            }
            return nil
        }
        guard let candidate = current.candidates.first(where: {
            $0.kind == .connection && $0.ref == connectionID
        }) else {
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
            return choice.candidates.contains {
                $0.kind == .connection && $0.ref == connectionID
            }
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
            update(projectId) { $0.validation = .stale(report); $0.activation = .idle }
        } else {
            update(projectId) { $0.validation = .unvalidated; $0.activation = .idle }
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
        var value = states[projectId] ?? ProjectConfigurationState()
        change(&value)
        states[projectId] = value
    }
}
