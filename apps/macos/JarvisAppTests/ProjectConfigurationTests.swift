import Foundation
import JarvisAPI
import SwiftUI
import XCTest

@testable import JarvisCore

final class ProjectConfigurationTests: XCTestCase {
    private var roots: [URL] = []

    override func tearDown() {
        for root in roots { try? FileManager.default.removeItem(at: root) }
        roots.removeAll()
        super.tearDown()
    }

    func testActionDescriptorsCarryTheirOperationAndLabelTogether() {
        let edit = ProjectDetailPresentation.Action.Edit.addSlot(
            name: "sourceControl", requirement: "scm.change-request.manage")
        XCTAssertEqual(edit.operation, .addSlot("sourceControl", "scm.change-request.manage"))
        XCTAssertEqual(edit.label, "Add slot")

        let asynchronous = ProjectDetailPresentation.Action.Asynchronous.saveLocal
        XCTAssertEqual(asynchronous.operation, .saveLocal)
        XCTAssertEqual(asynchronous.label, "Save locally")

        let repositoryPicker =
            ProjectDetailPresentation.Action.RepositoryPicker.chooseRepository("main")
        XCTAssertEqual(repositoryPicker.operation, .chooseRepository("main"))
        XCTAssertEqual(repositoryPicker.label, "Choose repository…")

        let confirmation = ProjectDetailPresentation.Action.Confirmation.deleteProject
        XCTAssertEqual(confirmation.operation, .deleteProject)
        XCTAssertEqual(confirmation.label, "Delete Project…")

        let noOp = ProjectDetailPresentation.Action.NoOp.cancelProjectDeletion
        XCTAssertEqual(noOp.operation, .cancelProjectDeletion)
        XCTAssertEqual(noOp.label, "Cancel")
    }

    func testDevelopmentReadyLabelUsesEffectiveDefaultWithoutWritingToDraft() throws {
        let package = try schemaFixturePackage(moduleId: "jarvis.module.development")
        let module = ProjectModuleDraft(package: package, instanceId: "development")

        XCTAssertNil(module.configurationValues["readyLabel"])
        XCTAssertEqual(module.configurationValue(for: "readyLabel"), "ready-to-dev")

        let draft = ProjectConfigurationDraft(
            configuration: try projectConfiguration(projectId: "round-trip"),
            packages: [package])
        let reopened = ProjectConfigurationDraft(
            configuration: try draft.payload(),
            packages: [package])
        XCTAssertEqual(reopened.repositories.first?.id, "main")
        XCTAssertNil(reopened.modules.first?.configurationValues["readyLabel"])
    }

    @MainActor
    func testRuntimeCheckRefusesAnUnsavedDraftInsteadOfCertifyingTheOlderProfile() async throws {
        let repository = try makeRepository()
        let session = EngineSessionModel(
            supervisor: EngineSupervisor(
                resources: .developmentBuild(),
                dataRoot: temporaryDirectory(prefix: "runtime-draft")))
        let projects = ProjectsModel(
            session: session,
            repositoryGrants: RepositoryGrantStore(
                storageDirectory: temporaryDirectory(prefix: "runtime-grants")))
        let api = RuntimeAPIStub(
            choices: .init(
                required: true, items: [],
                readiness: .init(status: .unchecked, checkedAt: nil, detail: "")),
            result: .init(
                required: true, items: [],
                readiness: .init(status: .ready, checkedAt: nil, detail: "Saved profile ready")))
        let model = ProjectConfigurationModel(session: session, projects: projects, runtimeAPI: api)
        await session.start()
        await projects.inspect(at: repository)
        let importedResult = await projects.confirmImport()
        let imported = try XCTUnwrap(importedResult)
        await model.refresh(projectId: imported.id)
        await model.refreshRuntimeCandidates(projectId: imported.id)
        model.editDraft(projectId: imported.id) { draft in draft.name = "New unsaved profile" }
        await model.checkRuntime(projectId: imported.id)
        XCTAssertEqual(model.state(for: imported.id).runtimePresentation.status, "Non vérifié")
        XCTAssertTrue(
            model.state(for: imported.id).runtimePresentation.detail.contains(
                "Enregistrez le brouillon"))
        XCTAssertFalse(model.state(for: imported.id).runtimeAllowsActivation)
        await session.shutdown()
    }

    @MainActor
    func testSavesLoadsAndPresentsConfiguredInstancesAcrossEngineRestart() async throws {
        let repository = try makeRepository()
        let dataRoot = temporaryDirectory(prefix: "jarvis-config-data")
        let grants = temporaryDirectory(prefix: "jarvis-config-grants")

        let firstSession = EngineSessionModel(
            supervisor: EngineSupervisor(resources: .developmentBuild(), dataRoot: dataRoot))
        let first = ProjectsModel(
            session: firstSession,
            repositoryGrants: RepositoryGrantStore(storageDirectory: grants))
        let firstConfiguration = ProjectConfigurationModel(
            session: firstSession, projects: first)
        await firstSession.start()
        await first.inspect(at: repository)
        let importResult = await first.confirmImport()
        let imported = try XCTUnwrap(importResult)

        let configuration = try projectConfiguration(
            projectId: imported.id, mapsSourceControlRequirement: false)
        let saved = await firstConfiguration.saveConfiguration(
            projectId: imported.id,
            portableConfig: configuration,
            writeToRepository: false)
        XCTAssertNotNil(saved)
        XCTAssertEqual(saved?.modules.map(\.instanceId), ["github-primary", "github-observer"])
        XCTAssertEqual(saved?.modules.map(\.enabled), [true, false])
        XCTAssertEqual(
            saved?.modules.first?.presentationFields.map(\.label),
            ["Enabled", "Package ID", "Instance ID", "Runtime slot", "Bindings", "Configuration"])

        await firstConfiguration.refresh(projectId: imported.id)
        let loaded = firstConfiguration.state(for: imported.id)
        let candidate = try XCTUnwrap(
            loaded.candidates.first { candidate in
                candidate.capabilities.contains("scm.change-request.manage")
            })
        let eventChoiceIDs = loaded.compositionGuide?.eventChoices.map(\.id)
        firstConfiguration.editDraft(projectId: imported.id) { $0.name = "Unsaved input" }
        let portableConfigurationBeforeBinding = try configurationSnapshot(
            try XCTUnwrap(firstConfiguration.state(for: imported.id).draft))
        let savedBindings = await firstConfiguration.setLocalBinding(
            projectId: imported.id, slotId: "sourceControl", candidate: candidate)
        XCTAssertNotNil(savedBindings)
        let bindings = try XCTUnwrap(
            firstConfiguration.state(for: imported.id).localBindings)
        XCTAssertEqual(bindings.projectId, imported.id)
        XCTAssertEqual(bindings.slots.map(\.slotId), ["sourceControl"])
        XCTAssertEqual(firstConfiguration.state(for: imported.id).draft?.name, "Unsaved input")
        XCTAssertEqual(
            try configurationSnapshot(
                try XCTUnwrap(firstConfiguration.state(for: imported.id).draft)),
            portableConfigurationBeforeBinding,
            "a Local Binding write must leave the Portable Configuration unchanged")
        XCTAssertEqual(
            firstConfiguration.state(for: imported.id).resourceChoices.first(where: {
                $0.slotId == "sourceControl"
            })?.status,
            .bound)
        XCTAssertEqual(
            firstConfiguration.state(for: imported.id).compositionGuide?.eventChoices.map(\.id),
            eventChoiceIDs)
        XCTAssertEqual(
            firstConfiguration.state(for: imported.id).detail?.projectSlots,
            ["sourceControl"])
        await firstConfiguration.refresh(projectId: imported.id)
        XCTAssertEqual(firstConfiguration.state(for: imported.id).draft?.name, "Unsaved input")
        XCTAssertFalse(firstConfiguration.state(for: imported.id).isDraftSaved)
        first.releaseRepositoryAccess()
        await firstSession.shutdown()

        let secondSession = EngineSessionModel(
            supervisor: EngineSupervisor(resources: .developmentBuild(), dataRoot: dataRoot))
        let relaunched = ProjectsModel(
            session: secondSession,
            repositoryGrants: RepositoryGrantStore(storageDirectory: grants))
        let relaunchedConfiguration = ProjectConfigurationModel(
            session: secondSession, projects: relaunched)
        await secondSession.start()
        await relaunched.refresh()
        await relaunchedConfiguration.refresh(projectId: imported.id)

        let restored = relaunchedConfiguration.state(for: imported.id)
        XCTAssertEqual(
            restored.detail?.modules.map(\.instanceId),
            ["github-primary", "github-observer"])
        XCTAssertEqual(restored.detail?.modules.map(\.enabled), [true, false])
        XCTAssertEqual(restored.localBindings?.slots.map(\.slotId), ["sourceControl"])
        XCTAssertNotNil(restored.localBindings?.repositories.first?.bookmarkRef)
        relaunched.releaseRepositoryAccess()
        await secondSession.shutdown()
    }

    @MainActor
    func testInvalidProjectSaveReopenAndRevalidationPreserveDurableComposition() async throws {
        let repository = try makeRepository()
        let dataRoot = temporaryDirectory(prefix: "jarvis-invalid-reopen-data")
        let session = EngineSessionModel(
            supervisor: EngineSupervisor(resources: .developmentBuild(), dataRoot: dataRoot))
        let projects = ProjectsModel(
            session: session,
            repositoryGrants: RepositoryGrantStore(
                storageDirectory: temporaryDirectory(prefix: "jarvis-invalid-reopen-grants")))
        let report = try validationReportFixture()
        let reports = ReopenedValidationSequence(report: report)
        let configuration = ProjectConfigurationModel(
            session: session,
            projects: projects,
            validationReportProvider: { _ in try await reports.load() })

        await session.start()
        await projects.inspect(at: repository)
        let importResult = await projects.confirmImport()
        let imported = try XCTUnwrap(importResult)
        let portableConfiguration = try projectConfiguration(
            projectId: imported.id, mapsSourceControlRequirement: false)
        let initialSave = await configuration.saveConfiguration(
            projectId: imported.id,
            portableConfig: portableConfiguration,
            writeToRepository: false)
        XCTAssertNotNil(initialSave)
        await configuration.refresh(projectId: imported.id)
        let candidate = try XCTUnwrap(
            configuration.state(for: imported.id).candidates.first {
                $0.capabilities.contains("scm.change-request.manage")
            })
        let savedBinding = await configuration.setLocalBinding(
            projectId: imported.id,
            slotId: "sourceControl",
            candidate: candidate)
        XCTAssertNotNil(savedBinding)

        await configuration.validate(projectId: imported.id)
        let firstInvalidPresentation = ProjectDetailPresentation(
            project: imported,
            detail: configuration.state(for: imported.id).detail,
            state: configuration.state(for: imported.id),
            packages: [])
        XCTAssertEqual(firstInvalidPresentation.validation.status, .invalid)
        let invalidProjectSave = await configuration.saveDraft(
            projectId: imported.id, writeToRepository: false)
        XCTAssertNotNil(
            invalidProjectSave,
            "semantic validation findings must not prevent saving a schema-valid Draft")
        let attemptsAfterSave = await reports.attemptCount()
        XCTAssertEqual(attemptsAfterSave, 1, "saving must not validate implicitly")

        let durableState = configuration.state(for: imported.id)
        let durableConfiguration = try configurationSnapshot(
            try XCTUnwrap(durableState.draft))
        let durableBindings = try XCTUnwrap(durableState.localBindings)

        await configuration.refresh(projectId: imported.id)
        let reopened = configuration.state(for: imported.id)
        XCTAssertEqual(reopened.validation, .unvalidated)
        XCTAssertEqual(
            try configurationSnapshot(try XCTUnwrap(reopened.draft)),
            durableConfiguration)
        XCTAssertEqual(reopened.localBindings, durableBindings)

        await configuration.validate(projectId: imported.id)
        guard case .failed(let message) = configuration.state(for: imported.id).validation else {
            return XCTFail("a failed revalidation must remain distinct from an invalid report")
        }
        XCTAssertTrue(message.contains("Validation report is unavailable"))
        XCTAssertEqual(
            try configurationSnapshot(
                try XCTUnwrap(configuration.state(for: imported.id).draft)),
            durableConfiguration)
        XCTAssertEqual(configuration.state(for: imported.id).localBindings, durableBindings)

        await configuration.validate(projectId: imported.id)
        let revalidatedPresentation = ProjectDetailPresentation(
            project: imported,
            detail: configuration.state(for: imported.id).detail,
            state: configuration.state(for: imported.id),
            packages: [])
        XCTAssertEqual(revalidatedPresentation.validation.status, .invalid)
        XCTAssertEqual(
            revalidatedPresentation.validation.findings.map(\.reference),
            firstInvalidPresentation.validation.findings.map(\.reference))
        let totalAttempts = await reports.attemptCount()
        XCTAssertEqual(totalAttempts, 3)

        projects.releaseRepositoryAccess()
        await session.shutdown()
    }

    @MainActor
    func testCompositionAndBindingEditsMakeValidationStaleAndRejectLateReports() async throws {
        let repository = try makeRepository()
        let session = EngineSessionModel(
            supervisor: EngineSupervisor(
                resources: .developmentBuild(),
                dataRoot: temporaryDirectory(prefix: "jarvis-stale-validation-data")))
        let projects = ProjectsModel(
            session: session,
            repositoryGrants: RepositoryGrantStore(
                storageDirectory: temporaryDirectory(prefix: "jarvis-stale-validation-grants")))
        let report = try validationReportFixture(valid: true)
        let reports = DelayedValidationSequence(report: report)
        let configuration = ProjectConfigurationModel(
            session: session,
            projects: projects,
            validationReportProvider: { _ in try await reports.load() })

        await session.start()
        await projects.inspect(at: repository)
        let importResult = await projects.confirmImport()
        let imported = try XCTUnwrap(importResult)
        let saved = await configuration.saveConfiguration(
            projectId: imported.id,
            portableConfig: try projectConfiguration(
                projectId: imported.id, mapsSourceControlRequirement: false),
            writeToRepository: false)
        XCTAssertNotNil(saved)
        await configuration.refresh(projectId: imported.id)
        let candidate = try XCTUnwrap(
            configuration.state(for: imported.id).candidates.first {
                $0.capabilities.contains("scm.change-request.manage")
            })
        let initialBinding = await configuration.setLocalBinding(
            projectId: imported.id,
            slotId: "sourceControl",
            candidate: candidate)
        XCTAssertNotNil(initialBinding)

        await configuration.validate(projectId: imported.id)
        let currentValidation = configuration.state(for: imported.id).validation
        guard case .valid = currentValidation else {
            return XCTFail("the controlled report must be current before editing")
        }
        XCTAssertTrue(
            ProjectDetailPresentation(
                project: imported,
                detail: configuration.state(for: imported.id).detail,
                state: configuration.state(for: imported.id),
                packages: []
            ).validation.isReadyToActivate)

        configuration.renameSlot(
            projectId: imported.id, from: "sourceControl", to: "renamed")
        XCTAssertEqual(
            configuration.state(for: imported.id).validation,
            currentValidation,
            "a rejected edit must preserve the report for the unchanged durable composition")
        var rejectedBindings = try XCTUnwrap(
            configuration.state(for: imported.id).localBindings?.wirePayload)
        rejectedBindings.projectId = "different-project"
        let rejectedBindingSave = await configuration.saveBindings(
            projectId: imported.id, bindings: rejectedBindings)
        XCTAssertNil(rejectedBindingSave)
        XCTAssertEqual(
            configuration.state(for: imported.id).validation,
            currentValidation,
            "a failed binding write must not stale the report for unchanged durable bindings")
        XCTAssertTrue(
            ProjectDetailPresentation(
                project: imported,
                detail: configuration.state(for: imported.id).detail,
                state: configuration.state(for: imported.id),
                packages: []
            ).validation.isReadyToActivate)

        configuration.editDraft(projectId: imported.id) { $0.name = "Edited composition" }
        guard
            case .stale(let historicalReport) =
                configuration.state(for: imported.id).validation
        else { return XCTFail("a Portable Configuration edit must make the report stale") }
        XCTAssertEqual(historicalReport, report)
        let stalePresentation = ProjectDetailPresentation(
            project: imported,
            detail: configuration.state(for: imported.id).detail,
            state: configuration.state(for: imported.id),
            packages: [])
        XCTAssertEqual(stalePresentation.validation.status, .stale)
        XCTAssertEqual(stalePresentation.validation.title, "Validation report is stale")
        XCTAssertTrue(stalePresentation.validation.errorMessage?.contains("revalidate") == true)
        XCTAssertTrue(stalePresentation.validation.requestRoutes.isEmpty)
        XCTAssertTrue(stalePresentation.validation.satisfiedCapabilities.isEmpty)
        XCTAssertTrue(stalePresentation.validation.findings.isEmpty)
        XCTAssertFalse(stalePresentation.validation.isReadyToActivate)

        let lateValidation = Task { await configuration.validate(projectId: imported.id) }
        await reports.waitUntilSecondRequestStarts()
        configuration.editDraft(projectId: imported.id) { $0.name = "Newer composition" }
        await reports.resumeSecondRequest()
        await lateValidation.value
        guard case .stale = configuration.state(for: imported.id).validation else {
            return XCTFail("a superseded validation response must not become current")
        }
        XCTAssertFalse(
            ProjectDetailPresentation(
                project: imported,
                detail: configuration.state(for: imported.id).detail,
                state: configuration.state(for: imported.id),
                packages: []
            ).validation.isReadyToActivate)

        await configuration.validate(projectId: imported.id)
        guard case .valid = configuration.state(for: imported.id).validation else {
            return XCTFail("fresh validation must replace stale state")
        }
        XCTAssertTrue(
            ProjectDetailPresentation(
                project: imported,
                detail: configuration.state(for: imported.id).detail,
                state: configuration.state(for: imported.id),
                packages: []
            ).validation.isReadyToActivate)
        let removedBinding = await configuration.setLocalBinding(
            projectId: imported.id,
            slotId: "sourceControl",
            candidate: nil)
        XCTAssertNotNil(removedBinding)
        guard case .stale = configuration.state(for: imported.id).validation else {
            return XCTFail("a successful Local Binding edit must make the report stale")
        }
        XCTAssertFalse(
            ProjectDetailPresentation(
                project: imported,
                detail: configuration.state(for: imported.id).detail,
                state: configuration.state(for: imported.id),
                packages: []
            ).validation.isReadyToActivate)

        await configuration.validate(projectId: imported.id)
        let repositoryBinding = try XCTUnwrap(
            configuration.state(for: imported.id).detail?.bindings.first)
        let repositoryBindingSaved = await projects.reauthorize(
            projectId: imported.id,
            repositoryId: repositoryBinding.repositoryId,
            replacing: repositoryBinding.bookmarkRef,
            with: repository)
        XCTAssertTrue(repositoryBindingSaved)
        await configuration.refreshAfterRepositoryBindingChange(projectId: imported.id)
        guard case .stale = configuration.state(for: imported.id).validation else {
            return XCTFail(
                "a successful repository Local Binding edit must remain stale after reload")
        }

        projects.releaseRepositoryAccess()
        await session.shutdown()
    }

    func testSchemaDescriptorsDistinguishControlsAndApplyDefaults() throws {
        let package = try schemaFixturePackage()
        let fields = Dictionary(
            uniqueKeysWithValues: package.configurationFields.map { ($0.key, $0) })

        XCTAssertEqual(fields["enabled"]?.kind, .boolean)
        XCTAssertEqual(fields["enabled"]?.defaultValue, "true")
        XCTAssertEqual(fields["mode"]?.kind, .choice(["safe", "fast"]))
        XCTAssertEqual(fields["mode"]?.defaultValue, "safe")
        XCTAssertEqual(fields["retries"]?.kind, .integer)
        XCTAssertEqual(fields["ratio"]?.kind, .number)
        guard case .array(let item)? = fields["items"]?.kind else {
            return XCTFail("items must expose a structured repeatable control")
        }
        XCTAssertEqual(item.kind, .choice(["main", "secondary"]))
        guard case .object(let children)? = fields["options"]?.kind else {
            return XCTFail("options must expose structured child controls")
        }
        XCTAssertEqual(children.map(\.key), ["note"])
        XCTAssertEqual(fields["name"]?.description, "Human-readable rule name")
        XCTAssertEqual(fields["name"]?.examples, ["release"])
        XCTAssertEqual(fields["name"]?.accessibilityLabel, "name, required, text")
        XCTAssertTrue(
            fields["name"]?.accessibilityHint.contains("Human-readable rule name") == true)
        XCTAssertEqual(fields["name"]?.pattern, "^[a-z]+$")
        XCTAssertTrue(fields["name"]?.required == true)

        let module = ProjectModuleDraft(package: package, instanceId: "fixture")
        XCTAssertEqual(module.configurationValues["enabled"], "true")
        XCTAssertEqual(module.configurationValues["mode"], "safe")
        XCTAssertEqual(module.configurationValues["items"], #"["main"]"#)
    }

    func testSchemaDescriptorsProvideLocalRequiredBoundsPatternAndJSONFeedback() throws {
        let package = try schemaFixturePackage()
        var module = ProjectModuleDraft(package: package, instanceId: "fixture")

        XCTAssertTrue(module.validationIssues.contains { $0.contains("name is required") })
        module.configurationValues["name"] = "NOT-LOWERCASE"
        module.configurationValues["retries"] = "6"
        module.configurationValues["ratio"] = "not-a-number"
        module.configurationValues["items"] = #"["main","main"]"#
        module.configurationValues["options"] = "[]"

        let issues = module.validationIssues.joined(separator: " ")
        XCTAssertTrue(issues.contains("required pattern"))
        XCTAssertTrue(issues.contains("at most 5"))
        XCTAssertTrue(issues.contains("ratio has an invalid value"))
        XCTAssertTrue(issues.contains("items does not satisfy its schema"))
        XCTAssertTrue(issues.contains("options has an invalid value"))
    }

    func testChangingModulePackagePreservesInvalidInputForRepairWhenSwitchingBack() throws {
        let github = try schemaFixturePackage(moduleId: "jarvis.module.github")
        let development = try schemaFixturePackage(moduleId: "jarvis.module.development")
        var draft = ProjectConfigurationDraft(
            configuration: try projectConfiguration(projectId: "schema-switch"),
            packages: [github])
        let moduleID = try XCTUnwrap(draft.modules.first?.id)
        draft.modules[0].configurationValues["name"] = "INVALID VALUE"

        draft.select(package: development, for: moduleID)

        XCTAssertTrue(
            draft.modules[0].configurationRepairExplanation?.contains("preserved") == true)
        draft.select(package: github, for: moduleID)
        XCTAssertEqual(draft.modules[0].configurationValues["name"], "INVALID VALUE")
    }

    func testGeneratedResourceKindsRoundTripThroughTheCentralDomainMapping() throws {
        let kinds = ["connection", "runtime", "mcp", "module-instance", "engine"]

        for wireValue in kinds {
            let data = try JSONSerialization.data(withJSONObject: [
                "ref": "resource-ref",
                "kind": wireValue,
                "displayName": "Resource",
                "capabilities": ["capability.test"],
            ])
            let payload = try JSONDecoder().decode(
                Components.Schemas.ProjectResourceCandidate.self, from: data)
            let candidate = ProjectResourceCandidate(payload: payload)

            XCTAssertEqual(candidate.kind.rawValue, wireValue)
            XCTAssertEqual(candidate.kind.payload.rawValue, wireValue)
        }
    }

    func testEditorPreservesConfigurationWhenCatalogSchemasAreUnavailable() throws {
        let configuration = try projectConfiguration(projectId: "schema-unavailable")
        let draft = ProjectConfigurationDraft(configuration: configuration, packages: [])
        let payload = try draft.payload()

        XCTAssertEqual(payload.modules, configuration.modules)
        XCTAssertEqual(payload.slots, configuration.slots)
    }

    @MainActor
    func testFreshImportOffersGuidedStartingPointsAndRefreshesHumanModuleCards() async throws {
        let repository = try makeRepository()
        try "[remote \"origin\"]\n\turl = git@github.com:QServices/swift-config.git\n".write(
            to: repository.appendingPathComponent(".git/config"), atomically: true, encoding: .utf8)

        let session = EngineSessionModel(
            supervisor: EngineSupervisor(
                resources: .developmentBuild(),
                dataRoot: temporaryDirectory(prefix: "jarvis-guided-start-data")))
        let projects = ProjectsModel(
            session: session,
            repositoryGrants: RepositoryGrantStore(
                storageDirectory: temporaryDirectory(prefix: "jarvis-guided-start-grants")))
        let configuration = ProjectConfigurationModel(session: session, projects: projects)
        let catalog = ModuleCatalogModel(session: session)
        await session.start()
        await catalog.refresh()
        await projects.inspect(at: repository)
        let importResult = await projects.confirmImport()
        let imported = try XCTUnwrap(importResult)

        await configuration.refresh(projectId: imported.id, packages: catalog.packages)
        var state = configuration.state(for: imported.id)
        XCTAssertNil(state.errorMessage, state.errorMessage ?? "")
        XCTAssertEqual(
            state.compositionGuide?.startingPoints.map(\.displayName),
            ["GitHub Development", "Custom composition"])
        XCTAssertEqual(state.compositionGuide?.modulePackages.count, 3)
        XCTAssertEqual(state.agentRuntimes?.required, false)
        XCTAssertEqual(state.runtimePresentation.status, "Choisissez d’abord un workflow")

        let githubPackage = try XCTUnwrap(
            catalog.packages.first { $0.moduleId == "jarvis.module.github" })
        configuration.addModule(projectId: imported.id, package: githubPackage)
        await configuration.refreshCompositionChoices(projectId: imported.id)
        let githubOnly = try XCTUnwrap(configuration.state(for: imported.id).draft)
        XCTAssertEqual(githubOnly.modules.map(\.moduleId), ["jarvis.module.github"])
        XCTAssertEqual(githubOnly.modules[0].configurationValues["repositories"], "[\"main\"]")
        XCTAssertEqual(githubOnly.modules[0].bindings["sourceControl"], "sourceControl")
        XCTAssertNil(githubOnly.slotRequirements["agentRuntime"])
        XCTAssertEqual(
            ProjectOnboardingPresentation(
                project: imported,
                configuration: configuration.state(for: imported.id)
            ).steps.first(where: { $0.id == .workflow })?.status,
            .complete,
            "GitHub seul reste un workflow autorisé")
        configuration.editDraft(projectId: imported.id) { $0.modules[0].enabled = false }
        configuration.addModule(projectId: imported.id, package: githubPackage)
        XCTAssertEqual(configuration.state(for: imported.id).draft?.modules.count, 1)
        configuration.editDraft(projectId: imported.id) {
            $0.modules = []
            $0.slotRequirements = [:]
        }
        await configuration.refreshCompositionChoices(projectId: imported.id)

        configuration.apply(
            .addSlot(name: "custom-slot", requirement: "agent.execute"), projectId: imported.id,
            packages: catalog.packages)
        let slotsOnly = configuration.state(for: imported.id).draft
        configuration.chooseStartingPoint(
            projectId: imported.id, startingPointId: "github-development")
        XCTAssertEqual(configuration.state(for: imported.id).draft, slotsOnly)
        XCTAssertEqual(
            configuration.state(for: imported.id).pendingStartingPointID, "github-development")
        configuration.cancelStartingPointReplacement(projectId: imported.id)
        configuration.apply(
            .removeSlot("custom-slot"), projectId: imported.id, packages: catalog.packages)
        configuration.chooseStartingPoint(
            projectId: imported.id, startingPointId: "github-development")
        await configuration.refreshCompositionChoices(projectId: imported.id)
        state = configuration.state(for: imported.id)
        XCTAssertEqual(
            state.draft?.modules.map(\.instanceId),
            ["github", "development"])
        XCTAssertEqual(state.localBindings?.slots, [])
        XCTAssertEqual(state.agentRuntimes?.required, true)
        await configuration.refreshRuntimeCandidates(
            projectId: imported.id, autoSelectUnique: false)
        XCTAssertEqual(
            configuration.state(for: imported.id).agentRuntimes?.required,
            true,
            "runtime discovery must keep evaluating the current unsaved workflow")
        let proposedDevelopment = try XCTUnwrap(
            state.draft?.modules.first { $0.instanceId == "development" })
        XCTAssertEqual(proposedDevelopment.configurationValues["readyLabel"], "ready-to-dev")
        XCTAssertEqual(
            ProjectOnboardingPresentation(
                project: imported,
                configuration: state
            ).steps.first(where: { $0.id == .workflow })?.status,
            .complete)
        XCTAssertEqual(state.compositionReview?.githubDevelopmentFlow, true)
        let canvas = WorkflowCanvasPresentation(graph: try XCTUnwrap(state.compositionGraph))
        XCTAssertEqual(
            Set(canvas.connections.map(\.contractType)),
            ["scm.work-item.observed", "scm.change-request.creation-requested"])
        XCTAssertTrue(
            canvas.edges.contains {
                $0.contractType == "development.implementation.requested" && $0.from == $0.to
            })
        XCTAssertFalse(canvas.connections.contains { $0.from == $0.to })
        let firstInstanceID = try XCTUnwrap(state.draft?.modules.first?.instanceId)
        configuration.editDraft(projectId: imported.id) { $0.modules[0].instanceId = "" }
        XCTAssertNil(
            configuration.state(for: imported.id).compositionGraph,
            "editing the Draft must remove the stale canvas before its refresh finishes")
        await configuration.refreshCompositionChoices(projectId: imported.id)
        XCTAssertNil(
            configuration.state(for: imported.id).compositionGraph,
            "a rejected refresh must not restore the previous canvas")
        configuration.editDraft(projectId: imported.id) {
            $0.modules[0].instanceId = firstInstanceID
        }
        await configuration.refreshCompositionChoices(projectId: imported.id)
        state = configuration.state(for: imported.id)

        XCTAssertEqual(
            state.resourceChoices.map(\.slotId),
            [
                "agentRuntime", "sourceControl",
            ])
        XCTAssertEqual(
            state.resourceChoices.first { $0.slotId == "sourceControl" }?.status,
            .incompatible)
        XCTAssertEqual(
            state.compositionGuide?.moduleInstances.map(\.displayName),
            ["Development", "GitHub"])
        XCTAssertEqual(
            state.compositionGuide?.moduleInstances.first(where: {
                $0.instanceId == "development"
            })?.missingResources,
            ["agent.execute"])
        let presentation = ProjectDetailPresentation(
            project: imported,
            detail: state.detail,
            state: state,
            packages: catalog.packages)
        XCTAssertEqual(
            presentation.startingPoints.map(\.displayName),
            [
                "GitHub Development", "Custom composition",
            ])
        XCTAssertTrue(
            presentation.actions.contains(
                .edit(.chooseStartingPoint("github-development", displayName: "GitHub Development"))
            ))
        let developmentCard = try XCTUnwrap(
            presentation.moduleCards.first { $0.displayName == "Development" })
        XCTAssertTrue(developmentCard.description.contains("isolated Git workspace"))
        XCTAssertTrue(developmentCard.eventSummary.contains("Implementation requested"))
        XCTAssertTrue(developmentCard.requiredCapabilities.contains("agent.execute"))
        XCTAssertEqual(developmentCard.compatibility, "compatible")
        XCTAssertEqual(
            developmentCard.missingResources,
            "agent.execute")
        XCTAssertTrue(developmentCard.technicalDetails.contains("jarvis.module.development"))
        XCTAssertTrue(developmentCard.technicalDetails.contains("1.0.0"))
        XCTAssertTrue(
            developmentCard.technicalDetails.contains("development.implementation.requested.v1"))

        let savedIncomplete = await configuration.saveDraft(
            projectId: imported.id, writeToRepository: false)
        XCTAssertNotNil(savedIncomplete, configuration.state(for: imported.id).errorMessage ?? "")
        await configuration.refresh(projectId: imported.id, packages: catalog.packages)
        XCTAssertFalse(
            configuration.state(for: imported.id).compositionReview?.readyToValidate ?? true)
        let confirmedSave = await configuration.saveDraft(
            projectId: imported.id, writeToRepository: false)
        XCTAssertNotNil(confirmedSave)
        await configuration.refresh(projectId: imported.id, packages: catalog.packages)
        let reopenedDevelopment = try XCTUnwrap(
            configuration.state(for: imported.id).draft?.modules.first {
                $0.instanceId == "development"
            })
        XCTAssertEqual(reopenedDevelopment.configurationValues["readyLabel"], "ready-to-dev")
        XCTAssertEqual(
            ProjectOnboardingPresentation(
                project: imported,
                configuration: configuration.state(for: imported.id)
            ).steps.first(where: { $0.id == .workflow })?.status,
            .complete)
        configuration.editDraft(projectId: imported.id) { draft in
            guard let index = draft.modules.firstIndex(where: { $0.id == reopenedDevelopment.id })
            else {
                return
            }
            draft.modules[index].enabled = false
        }
        XCTAssertEqual(
            ProjectOnboardingPresentation(
                project: imported,
                configuration: configuration.state(for: imported.id)
            ).steps.first(where: { $0.id == .workflow })?.status,
            .complete,
            "un module désactivé ne bloque pas une composition libre")
        configuration.editDraft(projectId: imported.id) { draft in
            guard let index = draft.modules.firstIndex(where: { $0.id == reopenedDevelopment.id })
            else {
                return
            }
            draft.modules[index].enabled = true
        }
        configuration.setReadyLabel(projectId: imported.id, label: "approved-work")
        XCTAssertEqual(
            configuration.state(for: imported.id).draft?.modules.first {
                $0.instanceId == "development"
            }?
            .configurationValues["readyLabel"],
            "approved-work")
        XCTAssertNil(
            configuration.state(for: imported.id).draft?.modules.first {
                $0.instanceId == "github"
            }?
            .configurationValues["readyLabel"])
        configuration.setGuidedReadyLabel(projectId: imported.id, label: "ready-for-review")
        XCTAssertEqual(
            configuration.state(for: imported.id).draft?.modules.first {
                $0.instanceId == "development"
            }?
            .configurationValues["readyLabel"],
            "ready-for-review")
        XCTAssertNil(
            configuration.state(for: imported.id).draft?.modules.first {
                $0.instanceId == "github"
            }?
            .configurationValues["readyLabel"])
        let labelModule = try XCTUnwrap(
            configuration.state(for: imported.id).draft?.modules.first {
                $0.instanceId == "development"
            })
        configuration.apply(
            .setModuleConfiguration(labelModule.id, "readyLabel", "reviewed-work"),
            projectId: imported.id, packages: catalog.packages)
        XCTAssertEqual(
            configuration.state(for: imported.id).draft?.modules.first {
                $0.instanceId == "development"
            }?
            .configurationValues["readyLabel"],
            "reviewed-work")
        XCTAssertTrue(ProjectDetailPresentation.activationNotice.contains("carrying"))
        XCTAssertTrue(
            ProjectDetailPresentation.activationNotice.contains("Historical compositions"))
        XCTAssertTrue(
            presentation.startingPoints.first?.description.contains("QServices/swift-config")
                == true)
        let custom = try XCTUnwrap(configuration.state(for: imported.id).draft)
        configuration.chooseStartingPoint(projectId: imported.id, startingPointId: "custom")
        XCTAssertEqual(configuration.state(for: imported.id).draft, custom)
        configuration.chooseStartingPoint(
            projectId: imported.id, startingPointId: "github-development")
        XCTAssertEqual(configuration.state(for: imported.id).draft, custom)
        XCTAssertEqual(
            configuration.state(for: imported.id).pendingStartingPointID, "github-development")
        configuration.cancelStartingPointReplacement(projectId: imported.id)
        XCTAssertNil(configuration.state(for: imported.id).pendingStartingPointID)
        XCTAssertEqual(configuration.state(for: imported.id).draft, custom)
        configuration.chooseStartingPoint(
            projectId: imported.id, startingPointId: "github-development",
            confirmedReplacement: true)
        XCTAssertEqual(
            configuration.state(for: imported.id).draft?.repositories.map(\.id), ["main"])
        await configuration.refreshCompositionChoices(projectId: imported.id)

        configuration.apply(
            .setProjectName("Preserved name"),
            projectId: imported.id, packages: catalog.packages)
        let development = try XCTUnwrap(
            configuration.state(for: imported.id).draft?.modules.first(where: {
                $0.instanceId == "development"
            }))
        configuration.apply(
            .setModuleEnabled(development.id, false),
            projectId: imported.id, packages: catalog.packages)
        await configuration.refreshCompositionChoices(projectId: imported.id)
        state = configuration.state(for: imported.id)
        XCTAssertEqual(state.draft?.name, "Preserved name")
        XCTAssertEqual(state.compositionReview?.githubDevelopmentFlow, false)
        XCTAssertEqual(
            state.compositionGuide?.moduleInstances.first(where: {
                $0.instanceId == "development"
            })?.enabled,
            false)
        XCTAssertEqual(
            state.compositionGuide?.eventChoices.first(where: {
                $0.type == "development.implementation.requested"
            }),
            nil)

        let runtimeCandidate = try XCTUnwrap(
            state.candidates.first { $0.kind.rawValue == "runtime" })
        let savedRuntimeBinding = await configuration.setLocalBinding(
            projectId: imported.id,
            slotId: "agentRuntime",
            candidate: runtimeCandidate)
        XCTAssertNotNil(savedRuntimeBinding)
        XCTAssertEqual(
            configuration.state(for: imported.id).localBindings?.slots.map(\.slotId),
            ["agentRuntime"])
        configuration.setReadyLabel(projectId: imported.id, label: "reviewed-work")
        XCTAssertEqual(
            configuration.state(for: imported.id).draft?.modules.first(where: {
                $0.instanceId == "development"
            })?.configurationValue(for: "readyLabel"),
            "reviewed-work")

        configuration.removeModule(projectId: imported.id, moduleId: development.id)
        XCTAssertNil(configuration.state(for: imported.id).draft?.slotRequirements["agentRuntime"])
        XCTAssertFalse(
            configuration.state(for: imported.id).localBindings?.slots.contains(where: {
                $0.slotId == "agentRuntime"
            }) ?? true)
        let developmentPackage = try XCTUnwrap(
            catalog.packages.first { $0.moduleId == "jarvis.module.development" })
        configuration.addModule(projectId: imported.id, package: developmentPackage)
        let readdedDevelopment = try XCTUnwrap(
            configuration.state(for: imported.id).draft?.modules.first {
                $0.moduleId == "jarvis.module.development"
            })
        XCTAssertEqual(readdedDevelopment.configurationValue(for: "readyLabel"), "ready-to-dev")
        XCTAssertNotEqual(
            readdedDevelopment.configurationValue(for: "readyLabel"), "reviewed-work")
        XCTAssertFalse(
            configuration.state(for: imported.id).localBindings?.slots.contains(where: {
                $0.slotId == "agentRuntime"
            }) ?? true,
            "re-adding before save must not restore the removed CLI binding")
        let removedSave = await configuration.saveDraft(
            projectId: imported.id, writeToRepository: false)
        XCTAssertNotNil(removedSave)
        await configuration.refresh(projectId: imported.id, packages: catalog.packages)
        XCTAssertFalse(
            configuration.state(for: imported.id).localBindings?.slots.contains(where: {
                $0.slotId == "agentRuntime"
            }) ?? true,
            "save then reload must not restore the removed CLI binding")

        state = configuration.state(for: imported.id)
        let github = try XCTUnwrap(state.draft?.modules.first { $0.instanceId == "github" })
        configuration.apply(
            .setModulePackage(github.id, "jarvis.module.change-request-review"),
            projectId: imported.id, packages: catalog.packages)
        await configuration.refreshCompositionChoices(projectId: imported.id)
        state = configuration.state(for: imported.id)
        XCTAssertEqual(state.draft?.name, "Preserved name")
        XCTAssertEqual(
            state.compositionGuide?.moduleInstances.first(where: {
                $0.instanceId == "github"
            })?.displayName,
            "Change Request Review")
        XCTAssertTrue(
            state.compositionGuide?.eventChoices.contains(where: {
                $0.type == "scm.change-request.created"
            }) == true)

        projects.releaseRepositoryAccess()
        await session.shutdown()
    }

    @MainActor
    func testSettingsRefreshStagesAndReloadsAccountRuntimeAndLabel() async throws {
        let fakeTools = temporaryDirectory(prefix: "jarvis-settings-tools")
        let fakeGitHub = fakeTools.appendingPathComponent("gh")
        try """
        #!/bin/sh
        printf '%s\\n' '{"hosts":{"github.com":[{"state":"success","login":"SwiftAccount"}]}}'
        """.write(to: fakeGitHub, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755], ofItemAtPath: fakeGitHub.path)
        let previousGitHubExecutable = ProcessInfo.processInfo.environment[
            "JARVIS_GH_EXECUTABLE"]
        setenv("JARVIS_GH_EXECUTABLE", fakeGitHub.path, 1)
        defer {
            if let previousGitHubExecutable {
                setenv("JARVIS_GH_EXECUTABLE", previousGitHubExecutable, 1)
            } else {
                unsetenv("JARVIS_GH_EXECUTABLE")
            }
        }

        let repository = try makeRepository()
        let developmentResources = EngineResources.developmentBuild()
        let resources = EngineResources(
            nodeExecutable: developmentResources.nodeExecutable,
            bundle: developmentResources.bundle.deletingLastPathComponent()
                .appendingPathComponent("engine.test-bundle.mjs"))
        let session = EngineSessionModel(
            supervisor: EngineSupervisor(
                resources: resources,
                dataRoot: temporaryDirectory(prefix: "jarvis-settings-data")))
        let projects = ProjectsModel(
            session: session,
            repositoryGrants: RepositoryGrantStore(
                storageDirectory: temporaryDirectory(prefix: "jarvis-settings-grants")))
        let configuration = ProjectConfigurationModel(session: session, projects: projects)
        let connections = ConnectionsModel(session: session)
        let catalog = ModuleCatalogModel(session: session)
        await session.start()
        await catalog.refresh()
        await projects.inspect(at: repository)
        let importResult = await projects.confirmImport()
        let imported = try XCTUnwrap(importResult)
        await configuration.refresh(projectId: imported.id, packages: catalog.packages)
        configuration.chooseStartingPoint(
            projectId: imported.id, startingPointId: "github-development")
        configuration.setReadyLabel(projectId: imported.id, label: "keep-after-account-refresh")

        await connections.refresh()
        await configuration.refreshAfterConnectionManagement(
            projectId: imported.id, packages: catalog.packages)
        XCTAssertEqual(
            configuration.state(for: imported.id).draft?.modules.first {
                $0.moduleId == "jarvis.module.development"
            }?.configurationValue(for: "readyLabel"),
            "keep-after-account-refresh")
        let account = try XCTUnwrap(
            configuration.state(for: imported.id).resourceChoices
                .flatMap(\.candidates)
                .first { $0.ref == "connection/github-SwiftAccount" })
        configuration.stageGitHubConnection(projectId: imported.id, connectionID: account.ref)

        await configuration.refreshRuntimeCandidates(
            projectId: imported.id, discover: true, autoSelectUnique: false)
        let runtime = try XCTUnwrap(
            configuration.state(for: imported.id).agentRuntimes?.items.first {
                $0.selectable
            })
        configuration.stageRuntime(projectId: imported.id, ref: runtime.ref)
        let saved = await configuration.saveDraft(
            projectId: imported.id, writeToRepository: false)
        XCTAssertNotNil(saved)
        let savedEnvironment = configuration.state(for: imported.id).localBindings?
            .wirePayload.slots.additionalProperties["agentRuntime"]?.environment?.additionalProperties
        XCTAssertFalse(savedEnvironment?["PATH"]?.isEmpty ?? true,
            "Saving a selected CLI must approve its local tool profile")

        configuration.stageRuntime(projectId: imported.id, ref: runtime.ref)
        XCTAssertEqual(
            configuration.state(for: imported.id).localBindings?.wirePayload
                .slots.additionalProperties["agentRuntime"]?.environment?.additionalProperties,
            savedEnvironment,
            "Reselecting the same CLI must preserve its approved profile")
        let resaved = await configuration.saveDraft(
            projectId: imported.id, writeToRepository: false)
        XCTAssertNotNil(resaved)

        let reloaded = ProjectConfigurationModel(session: session, projects: projects)
        await reloaded.refresh(projectId: imported.id, packages: catalog.packages)
        let reloadedState = reloaded.state(for: imported.id)
        XCTAssertEqual(
            reloadedState.localBindings?.wirePayload.slots.additionalProperties["agentRuntime"]?
                .environment?.additionalProperties, savedEnvironment)
        XCTAssertEqual(
            reloadedState.draft?.modules.first {
                $0.moduleId == "jarvis.module.development"
            }?.configurationValue(for: "readyLabel"),
            "keep-after-account-refresh")
        XCTAssertTrue(
            reloadedState.localBindings?.slots.contains {
                $0.kind == .connection && $0.ref == account.ref
            } == true)
        XCTAssertTrue(
            reloadedState.localBindings?.slots.contains {
                $0.kind == .runtime && $0.ref == runtime.ref
            } == true)

        projects.releaseRepositoryAccess()
        await session.shutdown()
    }

    @MainActor
    func testSchemaBackedEditorValidatesUniqueIdsAndSavesEditedControls() async throws {
        let repository = try makeRepository()
        let session = EngineSessionModel(
            supervisor: EngineSupervisor(
                resources: .developmentBuild(),
                dataRoot: temporaryDirectory(prefix: "jarvis-editor-data")))
        let projects = ProjectsModel(
            session: session,
            repositoryGrants: RepositoryGrantStore(
                storageDirectory: temporaryDirectory(prefix: "jarvis-editor-grants")))
        let configuration = ProjectConfigurationModel(session: session, projects: projects)
        let catalog = ModuleCatalogModel(session: session)
        await session.start()
        await catalog.refresh()
        await projects.inspect(at: repository)
        let importResult = await projects.confirmImport()
        let imported = try XCTUnwrap(importResult)
        let initialSave = await configuration.saveConfiguration(
            projectId: imported.id,
            portableConfig: try projectConfiguration(projectId: imported.id),
            writeToRepository: false)
        XCTAssertNotNil(initialSave)
        await configuration.refresh(projectId: imported.id, packages: catalog.packages)

        var editor = try XCTUnwrap(configuration.state(for: imported.id).draft)
        XCTAssertEqual(
            editor.modules.first?.configurationFields.map(\.key),
            ["bootstrapLabelPolicy", "pollIntervalSeconds", "repositories"])
        let bundledFields = Dictionary(
            uniqueKeysWithValues: try XCTUnwrap(editor.modules.first).configurationFields.map {
                ($0.key, $0)
            })
        XCTAssertEqual(bundledFields["bootstrapLabelPolicy"]?.defaultValue, "ignore-existing")
        XCTAssertEqual(
            bundledFields["bootstrapLabelPolicy"]?.kind,
            .choice(["ignore-existing", "emit-existing"]))
        XCTAssertEqual(bundledFields["pollIntervalSeconds"]?.kind, .integer)
        XCTAssertEqual(bundledFields["pollIntervalSeconds"]?.minimum, 15)
        XCTAssertEqual(bundledFields["pollIntervalSeconds"]?.maximum, 3600)
        guard case .array(let repositoryItem)? = bundledFields["repositories"]?.kind else {
            return XCTFail("repositories must be a structured repeatable control")
        }
        XCTAssertEqual(repositoryItem.kind, .string)
        XCTAssertNotNil(bundledFields["repositories"]?.validationIssue(for: "[]"))
        XCTAssertNotNil(
            bundledFields["repositories"]?.validationIssue(for: #"["main","main"]"#))
        let development = try XCTUnwrap(
            catalog.packages.first { $0.moduleId == "jarvis.module.development" })
        let developmentDraft = ProjectModuleDraft(
            package: development, instanceId: "development")
        XCTAssertEqual(developmentDraft.configurationValues["readyLabel"], "ready-to-dev")
        let developmentFields = Dictionary(
            uniqueKeysWithValues: development.configurationFields.map { ($0.key, $0) })
        XCTAssertEqual(Set(developmentFields.keys), ["readyLabel"])
        configuration.renameSlot(
            projectId: imported.id, from: "sourceControl", to: "provider")
        XCTAssertEqual(
            configuration.state(for: imported.id).draft?.modules.first?.bindings[
                "sourceControl"],
            "provider")
        configuration.renameSlot(
            projectId: imported.id, from: "provider", to: "sourceControl")
        configuration.editDraft(projectId: imported.id) { draft in
            draft.modules[1].instanceId = draft.modules[0].instanceId
        }
        let invalidSave = await configuration.saveDraft(
            projectId: imported.id, writeToRepository: false)
        XCTAssertNil(invalidSave)
        XCTAssertTrue(
            configuration.state(for: imported.id).errorMessage?.contains("unique") == true)

        configuration.editDraft(projectId: imported.id) { draft in
            draft.modules[1].instanceId = "github-observer"
            draft.modules[0].enabled = false
            draft.modules[0].runtimeSlot = "sourceControl"
            draft.modules[0].configurationValues["pollIntervalSeconds"] = "75"
        }
        let saved = await configuration.saveDraft(
            projectId: imported.id, writeToRepository: false)
        XCTAssertEqual(saved?.modules.first?.enabled, false)
        XCTAssertEqual(saved?.modules.first?.runtimeSlot, "sourceControl")
        XCTAssertTrue(saved?.modules.first?.configurationSummary.contains("75") == true)
        XCTAssertFalse(
            configuration.state(for: imported.id).candidates.contains {
                $0.ref == "github-primary"
            })
        editor = try XCTUnwrap(configuration.state(for: imported.id).draft)
        XCTAssertEqual(editor.modules.count, 2)
        projects.releaseRepositoryAccess()
        await session.shutdown()
    }

    @MainActor
    func testInvalidBundledPackageConfigurationIsActionableAndDoesNotReplaceTheDraft() async throws
    {
        let repository = try makeRepository()
        let dataRoot = temporaryDirectory(prefix: "jarvis-invalid-config-data")
        let session = EngineSessionModel(
            supervisor: EngineSupervisor(resources: .developmentBuild(), dataRoot: dataRoot))
        let projects = ProjectsModel(
            session: session,
            repositoryGrants: RepositoryGrantStore(
                storageDirectory: temporaryDirectory(prefix: "jarvis-invalid-config-grants")))
        let configuration = ProjectConfigurationModel(session: session, projects: projects)
        await session.start()
        await projects.inspect(at: repository)
        let importResult = await projects.confirmImport()
        let imported = try XCTUnwrap(importResult)

        let invalid = try projectConfiguration(projectId: imported.id, invalidPollInterval: true)
        let saveResult = await configuration.saveConfiguration(
            projectId: imported.id,
            portableConfig: invalid,
            writeToRepository: false)
        XCTAssertNil(saveResult)
        XCTAssertTrue(configuration.state(for: imported.id).saveFailed)
        let message = try XCTUnwrap(
            configuration.state(for: imported.id).errorMessage)
        XCTAssertTrue(message.contains("project.config-invalid"))
        XCTAssertTrue(message.contains("saved configuration was not changed"))
        let detail = try await projects.detail(for: imported.id)
        XCTAssertEqual(detail.modules, [])
        projects.releaseRepositoryAccess()
        await session.shutdown()
    }

    func testStaleProjectSelectionReconciliationClearsOnlyAfterTheProjectDisappears() {
        let policy = ProjectSelectionReconciliationPolicy()

        XCTAssertEqual(
            policy.reconciledProjectID(
                selectedProjectID: "project-1", availableProjectIDs: ["project-1"]),
            "project-1",
            "a failed deletion leaves the project in the list and must preserve selection")
        XCTAssertNil(
            policy.reconciledProjectID(
                selectedProjectID: "project-1", availableProjectIDs: ["project-2"]),
            "selection clears only after successful deletion removes the project")
        XCTAssertNil(
            policy.reconciledProjectID(selectedProjectID: nil, availableProjectIDs: []))
    }

    @MainActor
    func testReviewUsesEngineReadinessAndKeepsIncompleteDraftSaveable() async throws {
        let repository = try makeRepository()
        let dataRoot = temporaryDirectory(prefix: "jarvis-review-data")
        let session = EngineSessionModel(
            supervisor: EngineSupervisor(resources: .developmentBuild(), dataRoot: dataRoot))
        let projects = ProjectsModel(
            session: session,
            repositoryGrants: RepositoryGrantStore(
                storageDirectory: temporaryDirectory(prefix: "jarvis-review-grants")))
        let configuration = ProjectConfigurationModel(session: session, projects: projects)
        await session.start()
        await projects.inspect(at: repository)
        let importResult = await projects.confirmImport()
        let imported = try XCTUnwrap(importResult)

        await configuration.refresh(projectId: imported.id)
        let freshSave = await configuration.saveDraft(
            projectId: imported.id, writeToRepository: false)
        XCTAssertEqual(freshSave?.modules, [])
        let freshState = configuration.state(for: imported.id)
        XCTAssertNotNil(freshState.compositionReview, freshState.errorMessage ?? "missing review")
        XCTAssertFalse(freshState.compositionReview?.readyToValidate ?? true)
        XCTAssertEqual(freshState.saveStatus, "Enregistré")
        XCTAssertEqual(
            ProjectOnboardingPresentation(project: imported, configuration: freshState).steps.first?
                .status, .complete)
        XCTAssertEqual(
            ProjectOnboardingPresentation(project: imported, configuration: freshState).steps[1]
                .status,
            .complete)

        let incomplete = try projectConfiguration(projectId: imported.id)
        let saveResult = await configuration.saveConfiguration(
            projectId: imported.id,
            portableConfig: incomplete,
            writeToRepository: false)
        XCTAssertNotNil(saveResult)
        await configuration.refresh(projectId: imported.id)

        var state = configuration.state(for: imported.id)
        let review = try XCTUnwrap(state.compositionReview)
        XCTAssertFalse(review.readyToValidate)
        XCTAssertTrue(
            review.findings.contains {
                $0.code == "project.binding-missing"
                    || $0.code == "project.capability-unresolved"
            })
        var presentation = ProjectDetailPresentation(
            project: imported,
            detail: state.detail,
            state: state,
            packages: [])
        XCTAssertTrue(presentation.isSaveEnabled, "semantic findings must not block Draft save")
        XCTAssertFalse(presentation.isReadyForValidation)
        XCTAssertTrue(presentation.reviewRows.contains { $0.category == .module })
        XCTAssertTrue(presentation.reviewRows.contains { $0.category == .eventPath })
        XCTAssertTrue(presentation.reviewRows.contains { $0.category == .finding })
        XCTAssertTrue(presentation.reviewRows.contains { $0.category == .binding })
        XCTAssertTrue(presentation.reviewRows.allSatisfy { !$0.accessibilityLabel.isEmpty })
        XCTAssertTrue(
            presentation.reviewRows.filter { $0.status == .needsAttention }
                .allSatisfy { $0.repairAction != nil && $0.navigationTarget != nil })

        configuration.editDraft(projectId: imported.id) { $0.name = "Unsaved review edit" }
        state = configuration.state(for: imported.id)
        XCTAssertNil(state.compositionReview, "saved readiness must become stale after an edit")
        presentation = ProjectDetailPresentation(
            project: imported,
            detail: state.detail,
            state: state,
            packages: [])
        XCTAssertTrue(presentation.isSaveEnabled)
        XCTAssertFalse(presentation.isReadyForValidation)
        XCTAssertEqual(state.draft?.name, "Unsaved review edit")
        XCTAssertEqual(state.saveStatus, "Modifications à enregistrer")
        XCTAssertEqual(
            ProjectOnboardingPresentation(project: imported, configuration: state).steps.last?
                .status,
            .stale)

        let saving = Task {
            await configuration.saveDraft(projectId: imported.id, writeToRepository: false)
        }
        for _ in 0..<100 where !configuration.state(for: imported.id).isSaving {
            await Task.yield()
        }
        XCTAssertTrue(
            configuration.state(for: imported.id).isSaving,
            "the real save must be in flight before editing")
        configuration.editDraft(projectId: imported.id) { $0.name = "Edited while saving" }
        let saved = await saving.value
        XCTAssertEqual(saved?.project.name, "Unsaved review edit")
        state = configuration.state(for: imported.id)
        XCTAssertEqual(state.draft?.name, "Edited while saving")
        XCTAssertEqual(state.saveStatus, "Modifications à enregistrer")
        XCTAssertNotEqual(
            state.compositionReview?.compositionGuide.startingPoints.first?.template?.metadata.name,
            "Unsaved review edit", "the saved snapshot must not certify the newer edit")

        projects.releaseRepositoryAccess()
        await session.shutdown()
        await configuration.refresh(projectId: imported.id)
        state = configuration.state(for: imported.id)
        XCTAssertNotNil(state.detail, "a lost connection keeps the last repository snapshot")
        XCTAssertEqual(
            ProjectOnboardingPresentation(project: imported, configuration: state).steps.first?
                .status,
            .stale)
    }

    private func schemaFixturePackage(
        moduleId: String = "jarvis.module.fixture"
    ) throws -> ModulePackage {
        let document: [String: Any] = [
            "moduleId": moduleId,
            "version": "1.0.0",
            "displayName": "Fixture",
            "description": "Schema fixture",
            "categories": [],
            "consumes": [],
            "produces": [],
            "requires": [],
            "provides": [],
            "configurationSchemaRef": "fixture.schema.json",
            "configurationSchema": [
                "type": "object",
                "required": ["name", "items"],
                "properties": [
                    "enabled": ["type": "boolean", "default": true],
                    "mode": ["enum": ["safe", "fast"], "default": "safe"],
                    "retries": ["type": "integer", "minimum": 0, "maximum": 5],
                    "ratio": ["type": "number", "minimum": 0.25, "maximum": 2.5],
                    "items": [
                        "type": "array",
                        "default": ["main"],
                        "minItems": 1,
                        "uniqueItems": true,
                        "items": ["type": "string", "enum": ["main", "secondary"]],
                    ],
                    "options": [
                        "type": "object",
                        "properties": [
                            "note": ["type": "string", "title": "Note"]
                        ],
                    ],
                    "name": [
                        "type": "string",
                        "pattern": "^[a-z]+$",
                        "description": "Human-readable rule name",
                        "examples": ["release"],
                    ],
                ],
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: document)
        return ModulePackage(
            payload: try JSONDecoder().decode(Components.Schemas.ModulePackage.self, from: data))
    }

    private func projectConfiguration(
        projectId: String,
        invalidPollInterval: Bool = false,
        mapsSourceControlRequirement: Bool = true
    ) throws -> Components.Schemas.PortableProjectConfiguration {
        let poll: Any = invalidPollInterval ? "invalid" : 60
        var primaryBindings = ["repository": "main"]
        if mapsSourceControlRequirement {
            primaryBindings["sourceControl"] = "sourceControl"
        }
        let document: [String: Any] = [
            "apiVersion": "jarvis.dev/project/v1",
            "kind": "Project",
            "metadata": ["id": projectId, "name": "Swift Config"],
            "repositories": [
                ["id": "main", "root": "."]
            ],
            "slots": [
                "sourceControl": [
                    "requires": "scm.change-request.manage",
                    "optional": true,
                    "description": "Primary source control",
                ]
            ],
            "modules": [
                [
                    "instanceId": "github-primary",
                    "moduleId": "jarvis.module.github",
                    "enabled": true,
                    "bindings": primaryBindings,
                    "configuration": [
                        "pollIntervalSeconds": poll,
                        "repositories": ["main"],
                    ],
                ],
                [
                    "instanceId": "github-observer",
                    "moduleId": "jarvis.module.github",
                    "enabled": false,
                    "bindings": ["sourceControl": "sourceControl"],
                    "configuration": [
                        "pollIntervalSeconds": 120,
                        "repositories": ["main"],
                    ],
                ],
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: document)
        return try JSONDecoder().decode(
            Components.Schemas.PortableProjectConfiguration.self, from: data)
    }

    private func configurationSnapshot(_ draft: ProjectConfigurationDraft) throws -> String {
        let encoded = try JSONEncoder().encode(draft.payload())
        let object = try JSONSerialization.jsonObject(with: encoded)
        let canonical = try JSONSerialization.data(
            withJSONObject: object, options: [.sortedKeys])
        return try XCTUnwrap(String(data: canonical, encoding: .utf8))
    }

    private func validationReportFixture(valid: Bool = false) throws -> ProjectValidationReport {
        let findings =
            valid
            ? "[]"
            : """
            [{
              "code":"project.request-orphaned",
              "severity":"error",
              "message":"No consumer is available.",
              "target":{
                "kind":"request-edge",
                "contract":{"type":"deploy.requested","version":1,"kind":"request"},
                "producer":{"instanceId":"automation","moduleId":"jarvis.module.automation-rules"}
              }
            }]
            """
        let data = Data(
            """
            {
              "apiVersion": "jarvis.dev/project-validation/v1",
              "kind": "ProjectValidationReport",
              "projectId": "swift-config",
              "valid": \(valid),
              "requestRoutes": [{
                "contract": {"type":"development.implementation.requested","version":1,"kind":"request"},
                "producer": {"instanceId":"automation-rules","moduleId":"jarvis.module.automation-rules"},
                "consumer": {"instanceId":"development","moduleId":"jarvis.module.development"}
              }],
              "satisfiedCapabilities": [{
                "capability":"repository.write",
                "target":{"kind":"module-instance","instanceId":"development"},
                "source":{"kind":"repository","ref":"repository/main"}
              }],
              "findings": \(findings)
            }
            """.utf8)
        let payload = try JSONDecoder().decode(
            Components.Schemas.ProjectValidationReportV1.self,
            from: data)
        return try ProjectValidationReport(payload: payload)
    }

    private func makeRepository() throws -> URL {
        let root = temporaryDirectory(prefix: "jarvis-swift-config-repository")
        let git = root.appendingPathComponent(".git", isDirectory: true)
        try FileManager.default.createDirectory(at: git, withIntermediateDirectories: true)
        try "ref: refs/heads/main\n".write(
            to: git.appendingPathComponent("HEAD"), atomically: true, encoding: .utf8)
        try #"{"name":"swift-config"}"#.write(
            to: root.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        return root
    }

    private func temporaryDirectory(prefix: String) -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        roots.append(root)
        return root
    }
}

private actor DelayedValidationSequence {
    let report: ProjectValidationReport
    var attempts = 0
    var secondRequestStarted: CheckedContinuation<Void, Never>?
    var secondRequestRelease: CheckedContinuation<Void, Never>?

    init(report: ProjectValidationReport) {
        self.report = report
    }

    func load() async throws -> ProjectValidationReport {
        attempts += 1
        if attempts == 2 {
            secondRequestStarted?.resume()
            secondRequestStarted = nil
            await withCheckedContinuation { secondRequestRelease = $0 }
        }
        return report
    }

    func waitUntilSecondRequestStarts() async {
        guard attempts < 2 else { return }
        await withCheckedContinuation { secondRequestStarted = $0 }
    }

    func resumeSecondRequest() {
        secondRequestRelease?.resume()
        secondRequestRelease = nil
    }
}

private actor ReopenedValidationSequence {
    private let report: ProjectValidationReport
    private var attempts = 0

    init(report: ProjectValidationReport) {
        self.report = report
    }

    func load() throws -> ProjectValidationReport {
        attempts += 1
        if attempts == 2 {
            throw EngineClientError.unexpectedResponse(
                "POST /v1/projects/swift-config/validation-report returned 503")
        }
        return report
    }

    func attemptCount() -> Int { attempts }
}
