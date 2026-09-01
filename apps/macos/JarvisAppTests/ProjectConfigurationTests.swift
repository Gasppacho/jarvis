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
        await firstSession.start()
        await first.inspect(at: repository)
        let importResult = await first.confirmImport()
        let imported = try XCTUnwrap(importResult)

        let configuration = try projectConfiguration(projectId: imported.id)
        let saved = await first.saveConfiguration(
            projectId: imported.id,
            portableConfig: configuration,
            writeToRepository: false)
        XCTAssertNotNil(saved)
        XCTAssertEqual(saved?.modules.map(\.instanceId), ["github-primary", "github-observer"])
        XCTAssertEqual(saved?.modules.map(\.enabled), [true, false])
        XCTAssertEqual(
            saved?.modules.first?.presentationFields.map(\.label),
            ["Enabled", "Package ID", "Instance ID", "Runtime slot", "Bindings", "Configuration"])

        await first.refreshConfiguration(projectId: imported.id)
        let loaded = first.configurationState(for: imported.id)
        let candidate = try XCTUnwrap(
            loaded.candidates.first { candidate in
                candidate.capabilities.contains("scm.change-request.manage")
            })
        let savedBindings = await first.setLocalBinding(
            projectId: imported.id, slotId: "sourceControl", candidate: candidate)
        XCTAssertNotNil(savedBindings)
        let bindings = try XCTUnwrap(
            first.configurationState(for: imported.id).localBindings)
        XCTAssertEqual(bindings.projectId, imported.id)
        XCTAssertEqual(bindings.slots.map(\.slotId), ["sourceControl"])
        XCTAssertEqual(
            first.configurationState(for: imported.id).detail?.projectSlots,
            ["sourceControl"])
        first.releaseRepositoryAccess()
        await firstSession.shutdown()

        let secondSession = EngineSessionModel(
            supervisor: EngineSupervisor(resources: .developmentBuild(), dataRoot: dataRoot))
        let relaunched = ProjectsModel(
            session: secondSession,
            repositoryGrants: RepositoryGrantStore(storageDirectory: grants))
        await secondSession.start()
        await relaunched.refresh()
        await relaunched.refreshConfiguration(projectId: imported.id)

        let restored = relaunched.configurationState(for: imported.id)
        XCTAssertEqual(
            restored.detail?.modules.map(\.instanceId),
            ["github-primary", "github-observer"])
        XCTAssertEqual(restored.detail?.modules.map(\.enabled), [true, false])
        XCTAssertEqual(restored.localBindings?.slots.map(\.slotId), ["sourceControl"])
        XCTAssertNotNil(restored.localBindings?.repositories.first?.bookmarkRef)
        relaunched.releaseRepositoryAccess()
        await secondSession.shutdown()
    }

    func testEditorPreservesConfigurationWhenCatalogSchemasAreUnavailable() throws {
        let configuration = try projectConfiguration(projectId: "schema-unavailable")
        let draft = ProjectConfigurationDraft(configuration: configuration, packages: [])
        let payload = try draft.payload()

        XCTAssertEqual(payload.modules, configuration.modules)
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
        let catalog = ModuleCatalogModel(session: session)
        await session.start()
        await catalog.refresh()
        await projects.inspect(at: repository)
        let importResult = await projects.confirmImport()
        let imported = try XCTUnwrap(importResult)
        let initialSave = await projects.saveConfiguration(
            projectId: imported.id,
            portableConfig: try projectConfiguration(projectId: imported.id),
            writeToRepository: false)
        XCTAssertNotNil(initialSave)
        await projects.refreshConfiguration(projectId: imported.id, packages: catalog.packages)

        let surface = ProjectDetailView(
            projects: projects, moduleCatalog: catalog, project: imported
        )
        .frame(width: 900, height: 1_200)
        let rendered = ImageRenderer(content: surface).nsImage
        XCTAssertNotNil(rendered)
        XCTAssertGreaterThan(rendered?.size.width ?? 0, 0)

        var editor = try XCTUnwrap(projects.configurationState(for: imported.id).draft)
        XCTAssertEqual(
            editor.modules.first?.configurationFields.map(\.key),
            ["bootstrapLabelPolicy", "pollIntervalSeconds", "repositories"])
        projects.renameDraftSlot(
            projectId: imported.id, from: "sourceControl", to: "provider")
        XCTAssertEqual(
            projects.configurationState(for: imported.id).draft?.modules.first?.bindings[
                "sourceControl"],
            "provider")
        projects.renameDraftSlot(
            projectId: imported.id, from: "provider", to: "sourceControl")
        projects.editDraft(projectId: imported.id) { draft in
            draft.modules[1].instanceId = draft.modules[0].instanceId
        }
        let invalidSave = await projects.saveDraft(
            projectId: imported.id, writeToRepository: false)
        XCTAssertNil(invalidSave)
        XCTAssertTrue(
            projects.configurationState(for: imported.id).errorMessage?.contains("unique") == true)

        projects.editDraft(projectId: imported.id) { draft in
            draft.modules[1].instanceId = "github-observer"
            draft.modules[0].enabled = false
            draft.modules[0].runtimeSlot = "sourceControl"
            draft.modules[0].configurationValues["pollIntervalSeconds"] = "75"
        }
        let saved = await projects.saveDraft(projectId: imported.id, writeToRepository: false)
        XCTAssertEqual(saved?.modules.first?.enabled, false)
        XCTAssertEqual(saved?.modules.first?.runtimeSlot, "sourceControl")
        XCTAssertTrue(saved?.modules.first?.configurationSummary.contains("75") == true)
        XCTAssertFalse(
            projects.configurationState(for: imported.id).candidates.contains {
                $0.ref == "github-primary"
            })
        editor = try XCTUnwrap(projects.configurationState(for: imported.id).draft)
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
        await session.start()
        await projects.inspect(at: repository)
        let importResult = await projects.confirmImport()
        let imported = try XCTUnwrap(importResult)

        let invalid = try projectConfiguration(projectId: imported.id, invalidPollInterval: true)
        let saveResult = await projects.saveConfiguration(
            projectId: imported.id,
            portableConfig: invalid,
            writeToRepository: false)
        XCTAssertNil(saveResult)
        let message = try XCTUnwrap(
            projects.configurationState(for: imported.id).errorMessage)
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
            "slots": ["sourceControl": ["requires": "scm.change-request.manage"]],
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
