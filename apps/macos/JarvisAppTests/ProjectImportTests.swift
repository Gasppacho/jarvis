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
