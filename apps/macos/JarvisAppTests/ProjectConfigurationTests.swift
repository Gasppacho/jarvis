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
    func testFreshImportCanComposeBindSaveAndReopenThroughEditorActions() async throws {
        let repository = try makeRepository()
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
        configuration.addSlot(projectId: imported.id)
        configuration.addModule(projectId: imported.id, package: github)
        configuration.editDraft(projectId: imported.id) { draft in
            draft.slotRequirements["slot1"] = ProjectSlotDraft(
                requires: "scm.change-request.manage",
                optional: true,
                description: "Primary source-control provider")
            draft.modules[0].configurationValues["pollIntervalSeconds"] = "60"
            draft.modules[0].configurationValues["repositories"] = #"["main"]"#
        }

        let saved = await configuration.saveDraft(
            projectId: imported.id, writeToRepository: false)
        XCTAssertEqual(saved?.modules.map(\.moduleId), ["jarvis.module.github"])
        let candidate = try XCTUnwrap(
            configuration.state(for: imported.id).candidates.first {
                $0.capabilities.contains("scm.change-request.manage")
            })
        let bindings = await configuration.setLocalBinding(
            projectId: imported.id, slotId: "slot1", candidate: candidate)
        XCTAssertEqual(bindings?.slots.map(\.slotId), ["slot1"])

        let reopenedConfiguration = ProjectConfigurationModel(
            session: session, projects: projects)
        await reopenedConfiguration.refresh(
            projectId: imported.id, packages: catalog.packages)
        let reopened = try XCTUnwrap(reopenedConfiguration.state(for: imported.id).draft)
        XCTAssertEqual(reopened.modules.map(\.moduleId), ["jarvis.module.github"])
        XCTAssertEqual(reopened.slotRequirements["slot1"]?.optional, true)
        XCTAssertEqual(
            reopened.slotRequirements["slot1"]?.description,
            "Primary source-control provider")
        XCTAssertEqual(
            reopenedConfiguration.state(for: imported.id).localBindings?.slots.map(\.slotId),
            ["slot1"])
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
