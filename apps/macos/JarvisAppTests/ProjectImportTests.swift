import Foundation
import XCTest

@testable import JarvisCore

/// TESTING.md macOS seam: the observable import model drives the real bundled
/// engine through the generated client. The only boundary not exercised here
/// is NSOpenPanel itself; its selected URL enters at `ProjectsModel.inspect`.
final class ProjectImportTests: XCTestCase {
    private var roots: [URL] = []

    override func tearDown() {
        for root in roots {
            try? FileManager.default.removeItem(at: root)
        }
        roots.removeAll()
        super.tearDown()
    }

    @MainActor
    func testFolderSelectionImportsADraftAndRefreshesTheSidebar() async throws {
        let repository = try makeRepository()

        try await withModels { session, projects in
            await projects.inspect(at: repository)

            guard case .confirm(let inspection) = projects.importState else {
                return XCTFail("the selected repository was not offered for confirmation")
            }
            XCTAssertTrue(inspection.isGitRepository)
            XCTAssertEqual(inspection.provider, "github")
            XCTAssertEqual(inspection.defaultBranch, "main")
            XCTAssertEqual(inspection.packageManager, "pnpm")

            let result = await projects.confirmImport()
            let imported = try XCTUnwrap(result)

            XCTAssertEqual(imported.status, .draft)
            XCTAssertEqual(projects.projects.map(\.id), [imported.id])
            XCTAssertEqual(projects.projects.map(\.status), [.draft])

            let detail = try await projects.detail(for: imported.id)
            XCTAssertEqual(detail.project.id, imported.id)
            let binding = try XCTUnwrap(detail.bindings.first)
            XCTAssertTrue(binding.path.hasPrefix("/"))
            XCTAssertTrue(binding.path.hasSuffix(repository.lastPathComponent))
            XCTAssertTrue(binding.accessible)
            XCTAssertNotNil(binding.bookmarkRef)
            if let config = detail.portableConfigJSON {
                XCTAssertFalse(String(decoding: config, as: UTF8.self).contains(repository.path()))
            }
        }
    }

    @MainActor
    func testConfirmedDeletionClearsProjectConfigurationSidebarAndRepositoryGrant() async throws {
        let repository = try makeRepository()
        let packageFile = repository.appendingPathComponent("package.json")
        let packageBefore = try Data(contentsOf: packageFile)
        let dataRoot = temporaryDirectory(prefix: "jarvis-delete-data")
        let grantStorage = temporaryDirectory(prefix: "jarvis-delete-grants")
        let grantStore = RepositoryGrantStore(storageDirectory: grantStorage)
        let session = EngineSessionModel(
            supervisor: EngineSupervisor(resources: .developmentBuild(), dataRoot: dataRoot))
        let projects = ProjectsModel(session: session, repositoryGrants: grantStore)
        let configuration = ProjectConfigurationModel(session: session, projects: projects)

        await session.start()
        await projects.inspect(at: repository)
        let importResult = await projects.confirmImport()
        let imported = try XCTUnwrap(importResult)
        await configuration.refresh(projectId: imported.id)
        let bookmarkRef = try XCTUnwrap(
            configuration.state(for: imported.id).detail?.bindings.first?.bookmarkRef)
        XCTAssertNotNil(try grantStore.resolve(bookmarkRef: bookmarkRef))
        XCTAssertTrue(
            projects.isRepositoryAccessRetained(projectId: imported.id, repositoryId: "main"))

        let deleted = await configuration.deleteProject(projectId: imported.id)
        XCTAssertTrue(deleted)
        XCTAssertTrue(projects.projects.isEmpty)
        XCTAssertNil(configuration.states[imported.id])
        XCTAssertNil(try grantStore.resolve(bookmarkRef: bookmarkRef))
        XCTAssertFalse(
            projects.isRepositoryAccessRetained(projectId: imported.id, repositoryId: "main"))
        XCTAssertEqual(try Data(contentsOf: packageFile), packageBefore)
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: repository.appendingPathComponent(".jarvis/project.yaml").path()))

        projects.releaseRepositoryAccess()
        await session.shutdown()
    }

    @MainActor
    func testDeleteAPIFailurePreservesSidebarConfigurationAndRepositoryGrant() async throws {
        let repository = try makeRepository()
        let grantStore = RepositoryGrantStore(
            storageDirectory: temporaryDirectory(prefix: "jarvis-failed-delete-grants"))
        let session = EngineSessionModel(
            supervisor: EngineSupervisor(
                resources: .developmentBuild(),
                dataRoot: temporaryDirectory(prefix: "jarvis-failed-delete-data")))
        let projects = ProjectsModel(session: session, repositoryGrants: grantStore)
        let configuration = ProjectConfigurationModel(session: session, projects: projects)

        await session.start()
        await projects.inspect(at: repository)
        let importResult = await projects.confirmImport()
        let imported = try XCTUnwrap(importResult)
        await configuration.refresh(projectId: imported.id)
        let bookmarkRef = try XCTUnwrap(
            configuration.state(for: imported.id).detail?.bindings.first?.bookmarkRef)
        try await session.client?.deleteProject(id: imported.id)

        let deleted = await configuration.deleteProject(projectId: imported.id)
        XCTAssertFalse(deleted)
        XCTAssertEqual(projects.projects.map(\.id), [imported.id])
        XCTAssertNotNil(configuration.states[imported.id])
        XCTAssertNotNil(try grantStore.resolve(bookmarkRef: bookmarkRef))
        XCTAssertTrue(projects.errorMessage?.contains("project.not-found") == true)

        projects.releaseRepositoryAccess()
        await session.shutdown()
    }

    @MainActor
    func testSuccessfulEngineDeletionReportsRepositoryGrantCleanupFailure() async throws {
        let repository = try makeRepository()
        let dataRoot = temporaryDirectory(prefix: "jarvis-partial-delete-data")
        let backingStore = RepositoryGrantStore(
            storageDirectory: temporaryDirectory(prefix: "jarvis-partial-delete-grants"))
        let grantStore = FailingRemovalGrantStore(backing: backingStore)
        let session = EngineSessionModel(
            supervisor: EngineSupervisor(resources: .developmentBuild(), dataRoot: dataRoot))
        let projects = ProjectsModel(session: session, repositoryGrants: grantStore)
        let configuration = ProjectConfigurationModel(session: session, projects: projects)

        await session.start()
        await projects.inspect(at: repository)
        let importResult = await projects.confirmImport()
        let imported = try XCTUnwrap(importResult)
        await configuration.refresh(projectId: imported.id)
        let bookmarkRef = try XCTUnwrap(
            configuration.state(for: imported.id).detail?.bindings.first?.bookmarkRef)

        let deleted = await configuration.deleteProject(projectId: imported.id)
        XCTAssertTrue(deleted)
        XCTAssertTrue(projects.projects.isEmpty)
        XCTAssertTrue(projects.errorMessage?.contains("Project was deleted") == true)
        XCTAssertTrue(projects.errorMessage?.contains("Repository Grant") == true)
        XCTAssertNotNil(try backingStore.resolve(bookmarkRef: bookmarkRef))

        projects.releaseRepositoryAccess()
        await session.shutdown()
    }

    @MainActor
    func testRelaunchRestoresTheDraftThroughItsRepositoryGrant() async throws {
        let repository = try makeRepository()
        let originalPath = repository.resolvingSymlinksInPath().path()
        let movedRepository = repository.deletingLastPathComponent()
            .appendingPathComponent("\(repository.lastPathComponent)-moved", isDirectory: true)
        roots.append(movedRepository)
        let dataRoot = temporaryDirectory(prefix: "jarvis-relaunch-data")
        let grantStorage = temporaryDirectory(prefix: "jarvis-relaunch-grants")

        let firstSession = EngineSessionModel(
            supervisor: EngineSupervisor(resources: .developmentBuild(), dataRoot: dataRoot))
        let firstProjects = ProjectsModel(
            session: firstSession,
            repositoryGrants: RepositoryGrantStore(storageDirectory: grantStorage))
        await firstSession.start()
        guard case .ready = firstSession.state else {
            return XCTFail("the first engine did not become ready")
        }
        await firstProjects.inspect(at: repository)
        let importResult = await firstProjects.confirmImport()
        let imported = try XCTUnwrap(importResult)
        firstProjects.releaseRepositoryAccess()
        await firstSession.shutdown()

        try FileManager.default.moveItem(at: repository, to: movedRepository)

        let secondSession = EngineSessionModel(
            supervisor: EngineSupervisor(resources: .developmentBuild(), dataRoot: dataRoot))
        let relaunched = ProjectsModel(
            session: secondSession,
            repositoryGrants: RepositoryGrantStore(storageDirectory: grantStorage))
        await secondSession.start()
        guard case .ready = secondSession.state else {
            return XCTFail("the relaunched engine did not become ready")
        }
        await relaunched.refresh()

        XCTAssertEqual(relaunched.projects.map(\.id), [imported.id])
        XCTAssertEqual(relaunched.projects.map(\.status), [.draft])
        let detail = try await relaunched.detail(for: imported.id)
        let binding = try XCTUnwrap(detail.bindings.first)
        XCTAssertTrue(binding.accessible)
        XCTAssertNotEqual(binding.path, originalPath)
        XCTAssertEqual(
            URL(fileURLWithPath: binding.path).resolvingSymlinksInPath().path(),
            URL(fileURLWithPath: movedRepository.path(percentEncoded: false))
                .resolvingSymlinksInPath().path()
        )
        relaunched.releaseRepositoryAccess()
        await secondSession.shutdown()
    }

    @MainActor
    func testRelaunchKeepsAProjectActionableWhenItsGrantIsMissing() async throws {
        let repository = try makeRepository()
        let dataRoot = temporaryDirectory(prefix: "jarvis-missing-data")
        let grantStorage = temporaryDirectory(prefix: "jarvis-missing-grants")
        let firstGrantStore = RepositoryGrantStore(storageDirectory: grantStorage)

        let firstSession = EngineSessionModel(
            supervisor: EngineSupervisor(resources: .developmentBuild(), dataRoot: dataRoot))
        let firstProjects = ProjectsModel(session: firstSession, repositoryGrants: firstGrantStore)
        await firstSession.start()
        await firstProjects.inspect(at: repository)
        let importResult = await firstProjects.confirmImport()
        let imported = try XCTUnwrap(importResult)
        let firstDetail = try await firstProjects.detail(for: imported.id)
        let oldBookmarkRef = try XCTUnwrap(firstDetail.bindings.first?.bookmarkRef)
        firstProjects.releaseRepositoryAccess()
        await firstSession.shutdown()
        try firstGrantStore.remove(bookmarkRef: oldBookmarkRef)

        let secondSession = EngineSessionModel(
            supervisor: EngineSupervisor(resources: .developmentBuild(), dataRoot: dataRoot))
        let relaunched = ProjectsModel(
            session: secondSession,
            repositoryGrants: RepositoryGrantStore(storageDirectory: grantStorage))
        await secondSession.start()
        await relaunched.refresh()

        XCTAssertEqual(relaunched.projects.map(\.id), [imported.id])
        let detail = try await relaunched.detail(for: imported.id)
        XCTAssertTrue(try XCTUnwrap(detail.bindings.first).accessible)
        XCTAssertTrue(relaunched.repositoryGrantMessages[imported.id]?.contains("Choose") == true)

        let repairedGrant = await relaunched.reauthorize(
            projectId: imported.id,
            repositoryId: "main",
            replacing: oldBookmarkRef,
            with: repository
        )
        XCTAssertTrue(repairedGrant)
        XCTAssertNil(relaunched.repositoryGrantMessages[imported.id])
        let repaired = try await relaunched.detail(for: imported.id)
        XCTAssertNotEqual(repaired.bindings.first?.bookmarkRef, oldBookmarkRef)
        relaunched.releaseRepositoryAccess()
        await secondSession.shutdown()
    }

    @MainActor
    func testDuplicateImportLeavesAnActionableFailureInTheImportFlow() async throws {
        let repository = try makeRepository()

        try await withModels { _, projects in
            await projects.inspect(at: repository)
            _ = await projects.confirmImport()

            await projects.inspect(at: repository)
            let duplicate = await projects.confirmImport()
            XCTAssertNil(duplicate)

            guard case .failed(let message) = projects.importState else {
                return XCTFail("the duplicate import did not leave a visible failure")
            }
            XCTAssertTrue(message.contains("project.already-imported"))
            XCTAssertTrue(message.contains("Select the existing project"))
        }
    }

    @MainActor
    private func withModels(
        _ body: (EngineSessionModel, ProjectsModel) async throws -> Void
    ) async throws {
        let dataRoot = temporaryDirectory(prefix: "jarvis-swift-project-data")
        let supervisor = EngineSupervisor(resources: .developmentBuild(), dataRoot: dataRoot)
        let session = EngineSessionModel(supervisor: supervisor)
        let grantStorage = temporaryDirectory(prefix: "jarvis-swift-project-grants")
        let projects = ProjectsModel(
            session: session,
            repositoryGrants: RepositoryGrantStore(storageDirectory: grantStorage))

        await session.start()
        guard case .ready = session.state else {
            await session.shutdown()
            return XCTFail("the real engine did not become ready")
        }

        do {
            try await body(session, projects)
        } catch {
            await session.shutdown()
            throw error
        }
        projects.releaseRepositoryAccess()
        await session.shutdown()
    }

    private func makeRepository() throws -> URL {
        let root = temporaryDirectory(prefix: "jarvis-swift-project-repository")
        let git = root.appendingPathComponent(".git", isDirectory: true)
        try FileManager.default.createDirectory(at: git, withIntermediateDirectories: true)
        try """
            [remote "origin"]
            \turl = git@github.com:QServices/token-warehouse.git
            """.write(to: git.appendingPathComponent("config"), atomically: true, encoding: .utf8)
        try "ref: refs/heads/main\n".write(
            to: git.appendingPathComponent("HEAD"), atomically: true, encoding: .utf8)
        try #"{"name":"swift-import","scripts":{"test":"vitest run"}}"#.write(
            to: root.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        try "".write(
            to: root.appendingPathComponent("pnpm-lock.yaml"), atomically: true, encoding: .utf8)
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

private final class FailingRemovalGrantStore: RepositoryGrantStoring {
    private let backing: RepositoryGrantStore

    init(backing: RepositoryGrantStore) {
        self.backing = backing
    }

    func save(repositoryURL: URL, projectId: String, repositoryId: String) throws -> String {
        try backing.save(
            repositoryURL: repositoryURL, projectId: projectId, repositoryId: repositoryId)
    }

    func refresh(_ grant: RepositoryGrantStore.ResolvedGrant) throws {
        try backing.refresh(grant)
    }

    func remove(bookmarkRef _: String) throws {
        throw CocoaError(.fileWriteNoPermission)
    }

    func resolve(bookmarkRef: String) throws -> RepositoryGrantStore.ResolvedGrant? {
        try backing.resolve(bookmarkRef: bookmarkRef)
    }
}
