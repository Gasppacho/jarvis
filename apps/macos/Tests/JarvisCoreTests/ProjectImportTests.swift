import Foundation
import Testing

@testable import JarvisCore

/// Drives the real engine over the Local API, the way the shell does.
@Suite("Project import", .serialized)
struct ProjectImportTests {

    private func makeRepository() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "jarvis-swift-repo-\(UUID().uuidString)", directoryHint: .isDirectory)
        let git = root.appending(path: ".git", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: git, withIntermediateDirectories: true)
        try """
        [remote "origin"]
        \turl = git@github.com:QServices/token-warehouse.git
        """.write(to: git.appending(path: "config"), atomically: true, encoding: .utf8)
        try "ref: refs/heads/main\n"
            .write(to: git.appending(path: "HEAD"), atomically: true, encoding: .utf8)
        try #"{"name":"demo","scripts":{"test":"vitest run"}}"#
            .write(to: root.appending(path: "package.json"), atomically: true, encoding: .utf8)
        try "".write(to: root.appending(path: "pnpm-lock.yaml"), atomically: true, encoding: .utf8)
        return root
    }

    private func withEngine(
        _ body: (EngineClient) async throws -> Void
    ) async throws {
        let resources = EngineResources.inDevelopmentTree(repositoryRoot: repositoryRoot())
        try #require(resources.isPresent, "run `pnpm build:engine` before the Swift tests")

        let supervisor = EngineSupervisor(resources: resources)
        let dataRoot = FileManager.default.temporaryDirectory
            .appending(path: "jarvis-swift-data-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: dataRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dataRoot) }

        let session = try await supervisor.start(dataRoot: dataRoot)
        do {
            try await body(EngineClient(session: session))
        } catch {
            await supervisor.stop()
            throw error
        }
        await supervisor.stop()
    }

    @Test("inspects a chosen folder without changing it")
    func inspectsRepository() async throws {
        let repository = try makeRepository()
        defer { try? FileManager.default.removeItem(at: repository) }

        try await withEngine { client in
            let inspection = try await client.inspectRepository(
                at: repository.path(percentEncoded: false))
            #expect(inspection.isGitRepository)
            #expect(inspection.provider == "github")
            #expect(inspection.defaultBranch == "main")
            #expect(inspection.packageManager == "pnpm")
        }
    }

    @Test("imports a folder as a draft project and lists it")
    func importsDraftProject() async throws {
        let repository = try makeRepository()
        defer { try? FileManager.default.removeItem(at: repository) }

        try await withEngine { client in
            let imported = try await client.importProject(
                repositoryPath: repository.path(percentEncoded: false))
            #expect(imported.isDraft)
            #expect(!imported.id.isEmpty)

            let listed = try await client.listProjects()
            #expect(listed.map(\.id) == [imported.id])
        }
    }

    @Test("surfaces an actionable message when the same repository is imported twice")
    func reportsDuplicateImport() async throws {
        let repository = try makeRepository()
        defer { try? FileManager.default.removeItem(at: repository) }

        try await withEngine { client in
            let path = repository.path(percentEncoded: false)
            _ = try await client.importProject(repositoryPath: path)

            do {
                _ = try await client.importProject(repositoryPath: path)
                Issue.record("expected the second import to fail")
            } catch let error as EngineClientError {
                guard case .requestRejected(let code, _) = error else {
                    Issue.record("unexpected error: \(error)")
                    return
                }
                #expect(code == "project.already-imported")
                #expect(error.errorDescription?.isEmpty == false)
            }
        }
    }

    @Test("rejects a folder that is not a directory")
    func rejectsNonDirectory() async throws {
        try await withEngine { client in
            do {
                _ = try await client.inspectRepository(at: "/definitely/not/a/repository")
                Issue.record("expected inspection to fail")
            } catch let error as EngineClientError {
                guard case .requestRejected(let code, _) = error else {
                    Issue.record("unexpected error: \(error)")
                    return
                }
                #expect(code.hasPrefix("repository."))
            }
        }
    }
}
