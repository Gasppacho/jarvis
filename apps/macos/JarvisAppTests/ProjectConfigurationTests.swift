import Foundation
import JarvisAPI
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
        let bindings = try XCTUnwrap(first.localBindings[imported.id])
        XCTAssertEqual(bindings.projectId, imported.id)
        XCTAssertEqual(bindings.slots, [])
        XCTAssertEqual(first.configurationDetails[imported.id]?.projectSlots, ["sourceControl"])
        first.releaseRepositoryAccess()
        await firstSession.shutdown()

        let secondSession = EngineSessionModel(
            supervisor: EngineSupervisor(resources: .developmentBuild(), dataRoot: dataRoot))
        let relaunched = ProjectsModel(
            session: secondSession,
            repositoryGrants: RepositoryGrantStore(storageDirectory: grants))
        await secondSession.start()
        await relaunched.refreshConfiguration(projectId: imported.id)

        XCTAssertEqual(
            relaunched.configurationDetails[imported.id]?.modules.map(\.instanceId),
            ["github-primary", "github-observer"])
        XCTAssertEqual(
            relaunched.configurationDetails[imported.id]?.modules.map(\.enabled), [true, false])
        relaunched.releaseRepositoryAccess()
        await secondSession.shutdown()
    }

    @MainActor
    func testInvalidBundledPackageConfigurationIsActionableAndDoesNotReplaceTheDraft() async throws {
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
        let message = try XCTUnwrap(projects.configurationErrorMessages[imported.id])
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
            "repositories": [[
                "id": "main", "root": ".", "defaultBranch": "main", "remote": "origin",
            ]],
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
