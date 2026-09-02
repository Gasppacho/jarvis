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

        let configuration = try projectConfiguration(projectId: imported.id)
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
        let savedBindings = await firstConfiguration.setLocalBinding(
            projectId: imported.id, slotId: "sourceControl", candidate: candidate)
        XCTAssertNotNil(savedBindings)
        let bindings = try XCTUnwrap(
            firstConfiguration.state(for: imported.id).localBindings)
        XCTAssertEqual(bindings.projectId, imported.id)
        XCTAssertEqual(bindings.slots.map(\.slotId), ["sourceControl"])
        XCTAssertEqual(
            firstConfiguration.state(for: imported.id).detail?.projectSlots,
            ["sourceControl"])
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

    func testSchemaDescriptorsDistinguishControlsAndApplyDefaults() throws {
        let package = try schemaFixturePackage()
        let fields = Dictionary(uniqueKeysWithValues: package.configurationFields.map { ($0.key, $0) })

        XCTAssertEqual(fields["enabled"]?.kind, .boolean)
        XCTAssertEqual(fields["enabled"]?.defaultValue, "true")
        XCTAssertEqual(fields["mode"]?.kind, .choice(["safe", "fast"]))
        XCTAssertEqual(fields["mode"]?.defaultValue, "safe")
        XCTAssertEqual(fields["retries"]?.kind, .integer)
        XCTAssertEqual(fields["ratio"]?.kind, .number)
        XCTAssertEqual(fields["items"]?.kind, .json(.array))
        XCTAssertEqual(fields["options"]?.kind, .json(.object))
        XCTAssertEqual(fields["name"]?.description, "Human-readable rule name")
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
    func testFreshImportPreservesEngineDraftValuesWhileComposingSavingAndReopening() async throws {
        let repository = try makeRepository()
        try """
            [remote "upstream"]
            \turl = git@github.com:QServices/swift-config.git
            """.write(
                to: repository.appendingPathComponent(".git/config"),
                atomically: true,
                encoding: .utf8)
        try "ref: refs/heads/develop\n".write(
            to: repository.appendingPathComponent(".git/HEAD"), atomically: true, encoding: .utf8)
        let session = EngineSessionModel(
            supervisor: EngineSupervisor(
                resources: .developmentBuild(),
                dataRoot: temporaryDirectory(prefix: "jarvis-fresh-flow-data")))
        let projects = ProjectsModel(
            session: session,
            repositoryGrants: RepositoryGrantStore(
                storageDirectory: temporaryDirectory(prefix: "jarvis-fresh-flow-grants")))
        let configuration = ProjectConfigurationModel(session: session, projects: projects)
        let catalog = ModuleCatalogModel(session: session)
        await session.start()
        await catalog.refresh()
        await projects.inspect(at: repository)
        let importResult = await projects.confirmImport()
        let imported = try XCTUnwrap(importResult)

        await configuration.refresh(projectId: imported.id, packages: catalog.packages)
        XCTAssertEqual(configuration.state(for: imported.id).draft?.modules, [])
        XCTAssertEqual(configuration.state(for: imported.id).draft?.slotRequirements, [:])

        let github = try XCTUnwrap(
            catalog.packages.first { $0.moduleId == "jarvis.module.github" })
        let development = try XCTUnwrap(
            catalog.packages.first { $0.moduleId == "jarvis.module.development" })
        configuration.apply(
            .setProjectName("Action-edited Project"),
            projectId: imported.id, packages: catalog.packages)
        configuration.apply(.addSlot, projectId: imported.id, packages: catalog.packages)
        configuration.apply(
            .setSlotRequirement("slot1", "scm.change-request.manage"),
            projectId: imported.id, packages: catalog.packages)
        configuration.apply(
            .setSlotOptional("slot1", true),
            projectId: imported.id, packages: catalog.packages)
        configuration.apply(
            .setSlotDescription("slot1", "Primary source-control provider"),
            projectId: imported.id, packages: catalog.packages)
        configuration.apply(
            .renameSlot("slot1", "sourceControl"),
            projectId: imported.id, packages: catalog.packages)
        configuration.apply(.addSlot, projectId: imported.id, packages: catalog.packages)
        configuration.apply(
            .removeSlot("slot2"), projectId: imported.id, packages: catalog.packages)
        configuration.apply(
            .addModule(development.moduleId),
            projectId: imported.id, packages: catalog.packages)
        let moduleId = try XCTUnwrap(
            configuration.state(for: imported.id).draft?.modules.first?.id)
        configuration.apply(
            .addModule(development.moduleId),
            projectId: imported.id, packages: catalog.packages)
        let removedModuleId = try XCTUnwrap(
            configuration.state(for: imported.id).draft?.modules.last?.id)
        configuration.apply(
            .removeModule(removedModuleId),
            projectId: imported.id, packages: catalog.packages)
        configuration.apply(
            .setModulePackage(moduleId, github.moduleId),
            projectId: imported.id, packages: catalog.packages)
        configuration.apply(
            .setModuleInstanceID(moduleId, "github-primary"),
            projectId: imported.id, packages: catalog.packages)
        configuration.apply(
            .setModuleEnabled(moduleId, true),
            projectId: imported.id, packages: catalog.packages)
        configuration.apply(
            .setModuleRuntimeSlot(moduleId, "sourceControl"),
            projectId: imported.id, packages: catalog.packages)
        configuration.apply(
            .addModuleBinding(moduleId),
            projectId: imported.id, packages: catalog.packages, bindingOptions: ["main"])
        configuration.apply(
            .renameModuleBinding(moduleId, "binding1", "repository"),
            projectId: imported.id, packages: catalog.packages)
        configuration.apply(
            .setModuleBinding(moduleId, "repository", "main"),
            projectId: imported.id, packages: catalog.packages)
        configuration.apply(
            .addModuleBinding(moduleId),
            projectId: imported.id, packages: catalog.packages, bindingOptions: ["main"])
        configuration.apply(
            .removeModuleBinding(moduleId, "binding2"),
            projectId: imported.id, packages: catalog.packages)
        configuration.apply(
            .setModuleConfiguration(moduleId, "pollIntervalSeconds", "60"),
            projectId: imported.id, packages: catalog.packages)
        configuration.apply(
            .setModuleConfiguration(moduleId, "repositories", #"["main"]"#),
            projectId: imported.id, packages: catalog.packages)

        let editorState = configuration.state(for: imported.id)
        let presentation = ProjectDetailPresentation(
            project: imported,
            detail: editorState.detail,
            state: editorState,
            packages: catalog.packages)
        XCTAssertEqual(presentation.repositories.map(\.repositoryId), ["main"])
        XCTAssertEqual(presentation.slots.map(\.id), ["sourceControl"])
        XCTAssertEqual(presentation.modules.map(\.moduleId), ["jarvis.module.github"])
        XCTAssertTrue(presentation.actions.contains(.chooseRepository("main")))
        XCTAssertTrue(presentation.actions.contains(.addSlot))
        XCTAssertEqual(
            presentation.actions.compactMap { action -> String? in
                guard case .addModule(let packageId) = action else { return nil }
                return packageId
            }.sorted(),
            catalog.packages.map(\.moduleId).sorted())
        XCTAssertTrue(presentation.actions.contains(.setProjectName("Action-edited Project")))
        XCTAssertTrue(presentation.actions.contains(.removeSlot("sourceControl")))
        XCTAssertTrue(
            presentation.actions.contains(
                .setSlotRequirement("sourceControl", "scm.change-request.manage")))
        XCTAssertTrue(presentation.actions.contains(.setSlotOptional("sourceControl", true)))
        XCTAssertTrue(
            presentation.actions.contains(
                .setSlotDescription("sourceControl", "Primary source-control provider")))
        XCTAssertTrue(presentation.actions.contains(.setLocalBinding("sourceControl", nil)))
        XCTAssertTrue(presentation.actions.contains(.removeModule(moduleId)))
        XCTAssertTrue(
            presentation.actions.contains(.setModulePackage(moduleId, github.moduleId)))
        XCTAssertTrue(
            presentation.actions.contains(.setModuleInstanceID(moduleId, "github-primary")))
        XCTAssertTrue(presentation.actions.contains(.setModuleEnabled(moduleId, true)))
        XCTAssertTrue(
            presentation.actions.contains(.setModuleRuntimeSlot(moduleId, "sourceControl")))
        XCTAssertTrue(presentation.actions.contains(.addModuleBinding(moduleId)))
        XCTAssertTrue(
            presentation.actions.contains(.removeModuleBinding(moduleId, "repository")))
        XCTAssertTrue(
            presentation.actions.contains(
                .setModuleBinding(moduleId, "repository", "main")))
        XCTAssertTrue(
            presentation.actions.contains(
                .setModuleConfiguration(moduleId, "pollIntervalSeconds", "60")))
        XCTAssertTrue(presentation.actions.contains(.saveLocal))
        XCTAssertTrue(presentation.actions.contains(.saveRepository))
        XCTAssertTrue(presentation.actions.contains(.deleteProject))
        XCTAssertEqual(ProjectDetailPresentation.Action.deleteProject.label, "Delete Project…")
        XCTAssertEqual(presentation.deletionConfirmation.title, "Delete “\(imported.name)”?")
        XCTAssertTrue(presentation.deletionConfirmation.message.contains("Project Registry record"))
        XCTAssertTrue(
            presentation.deletionConfirmation.message.contains("project-scoped engine state"))
        XCTAssertTrue(presentation.deletionConfirmation.message.contains("Local Bindings"))
        XCTAssertTrue(presentation.deletionConfirmation.message.contains("Repository Grant"))
        XCTAssertTrue(presentation.deletionConfirmation.message.contains("remain untouched"))
        XCTAssertEqual(presentation.deletionConfirmation.cancelLabel, "Cancel")
        XCTAssertTrue(presentation.deletionConfirmation.isEnabled)
        let activeProject = Project(
            id: imported.id,
            name: imported.name,
            status: .active,
            moduleCount: imported.moduleCount,
            activeExecutions: imported.activeExecutions)
        XCTAssertFalse(
            ProjectDetailPresentation(
                project: activeProject,
                detail: editorState.detail,
                state: editorState,
                packages: catalog.packages
            ).deletionConfirmation.isEnabled)
        XCTAssertTrue(presentation.isSaveEnabled)

        await configuration.perform(
            .saveLocal, projectId: imported.id, packages: catalog.packages)
        let saved = configuration.state(for: imported.id).detail
        XCTAssertEqual(saved?.portableConfiguration?.metadata.name, "Action-edited Project")
        XCTAssertEqual(saved?.modules.map(\.moduleId), ["jarvis.module.github"])
        XCTAssertEqual(saved?.modules.map(\.instanceId), ["github-primary"])
        XCTAssertEqual(saved?.modules.map(\.enabled), [true])
        XCTAssertEqual(saved?.modules.map(\.runtimeSlot), ["sourceControl"])
        XCTAssertEqual(saved?.portableConfiguration?.repositories.first?.defaultBranch, "develop")
        XCTAssertEqual(saved?.portableConfiguration?.repositories.first?.remote, "upstream")
        XCTAssertEqual(saved?.portableConfiguration?.git.pushRemote, "upstream")
        XCTAssertEqual(saved?.portableConfiguration?.workspace.maxConcurrentExecutions, 1)
        let candidate = try XCTUnwrap(
            configuration.state(for: imported.id).candidates.first {
                $0.capabilities.contains("scm.change-request.manage")
            })
        await configuration.perform(
            .setLocalBinding("sourceControl", candidate.id),
            projectId: imported.id, packages: catalog.packages)
        XCTAssertEqual(
            configuration.state(for: imported.id).localBindings?.slots.map(\.slotId),
            ["sourceControl"])

        let reopenedConfiguration = ProjectConfigurationModel(
            session: session, projects: projects)
        await reopenedConfiguration.refresh(
            projectId: imported.id, packages: catalog.packages)
        let reopened = try XCTUnwrap(reopenedConfiguration.state(for: imported.id).draft)
        XCTAssertEqual(reopened.name, "Action-edited Project")
        XCTAssertEqual(reopened.modules.map(\.moduleId), ["jarvis.module.github"])
        XCTAssertEqual(reopened.modules.map(\.instanceId), ["github-primary"])
        XCTAssertEqual(reopened.modules.map(\.enabled), [true])
        XCTAssertEqual(reopened.modules.map(\.runtimeSlot), ["sourceControl"])
        XCTAssertEqual(reopened.modules.first?.bindings, ["repository": "main"])
        XCTAssertEqual(reopened.modules.first?.configurationValues["pollIntervalSeconds"], "60")
        XCTAssertEqual(reopened.modules.first?.configurationValues["repositories"], #"["main"]"#)
        let roundTripped = try reopened.payload()
        XCTAssertEqual(roundTripped.repositories.first?.defaultBranch, "develop")
        XCTAssertEqual(roundTripped.repositories.first?.remote, "upstream")
        XCTAssertEqual(roundTripped.git.pushRemote, "upstream")
        XCTAssertEqual(roundTripped.workspace.maxConcurrentExecutions, 1)
        XCTAssertEqual(Set(reopened.slotRequirements.keys), Set(["sourceControl"]))
        XCTAssertEqual(
            reopened.slotRequirements["sourceControl"]?.requires,
            "scm.change-request.manage")
        XCTAssertEqual(reopened.slotRequirements["sourceControl"]?.optional, true)
        XCTAssertEqual(
            reopened.slotRequirements["sourceControl"]?.description,
            "Primary source-control provider")
        XCTAssertEqual(
            reopenedConfiguration.state(for: imported.id).localBindings?.slots.map(\.slotId),
            ["sourceControl"])
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
        XCTAssertEqual(bundledFields["bootstrapLabelPolicy"]?.kind,
                       .choice(["ignore-existing", "emit-existing"]))
        XCTAssertEqual(bundledFields["pollIntervalSeconds"]?.kind, .integer)
        XCTAssertEqual(bundledFields["pollIntervalSeconds"]?.minimum, 15)
        XCTAssertEqual(bundledFields["pollIntervalSeconds"]?.maximum, 3600)
        XCTAssertEqual(bundledFields["repositories"]?.kind, .json(.array))
        XCTAssertNotNil(bundledFields["repositories"]?.validationIssue(for: "[]"))
        XCTAssertNotNil(
            bundledFields["repositories"]?.validationIssue(for: #"["main","main"]"#))
        let development = try XCTUnwrap(
            catalog.packages.first { $0.moduleId == "jarvis.module.development" })
        let developmentDraft = ProjectModuleDraft(
            package: development, instanceId: "development")
        XCTAssertEqual(
            developmentDraft.configurationValues["retainWorkspaceOnSuccess"],
            "false")
        let developmentFields = Dictionary(
            uniqueKeysWithValues: development.configurationFields.map { ($0.key, $0) })
        XCTAssertNotNil(
            developmentFields["validationOrder"]?.validationIssue(for: #"["unknown"]"#))
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
        let message = try XCTUnwrap(
            configuration.state(for: imported.id).errorMessage)
        XCTAssertTrue(message.contains("project.config-invalid"))
        XCTAssertTrue(message.contains("saved configuration was not changed"))
        let detail = try await projects.detail(for: imported.id)
        XCTAssertEqual(detail.modules, [])
        projects.releaseRepositoryAccess()
        await session.shutdown()
    }

    private func schemaFixturePackage() throws -> ModulePackage {
        let document: [String: Any] = [
            "moduleId": "jarvis.module.fixture",
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
                    "options": ["type": "object"],
                    "name": [
                        "type": "string",
                        "pattern": "^[a-z]+$",
                        "description": "Human-readable rule name",
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
        invalidPollInterval: Bool = false
    ) throws -> Components.Schemas.PortableProjectConfiguration {
        let poll: Any = invalidPollInterval ? "invalid" : 60
        let document: [String: Any] = [
            "apiVersion": "jarvis.dev/project/v1",
            "kind": "Project",
            "metadata": ["id": projectId, "name": "Swift Config"],
            "repositories": [
                [
                    "id": "main", "root": ".", "defaultBranch": "main", "remote": "origin",
                ]
            ],
            "slots": [
                "sourceControl": [
                    "requires": "scm.change-request.manage",
                    "optional": true,
                    "description": "Primary source control",
                ]
            ],
            "commands": [:],
            "git": [
                "branchPattern": "agent/{workItemId}-{slug}",
                "commitStrategy": "conventional",
                "pushRemote": "origin",
                "allowForcePush": false,
            ],
            "workspace": [
                "strategy": "git-worktree",
                "maxConcurrentExecutions": 1,
                "retainOnFailureDays": 7,
            ],
            "modules": [
                [
                    "instanceId": "github-primary",
                    "moduleId": "jarvis.module.github",
                    "enabled": true,
                    "bindings": ["sourceControl": "sourceControl", "repository": "main"],
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
