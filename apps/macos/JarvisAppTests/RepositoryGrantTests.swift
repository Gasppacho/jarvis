import Foundation
import XCTest

@testable import JarvisCore

final class RepositoryGrantTests: XCTestCase {
    private var roots: [URL] = []

    override func tearDown() {
        for root in roots {
            try? FileManager.default.removeItem(at: root)
        }
        roots.removeAll()
        super.tearDown()
    }

    func testRepositoryGrantSurvivesCreatingANewStore() throws {
        let storage = temporaryDirectory(prefix: "jarvis-grants")
        let repository = temporaryDirectory(prefix: "jarvis-repository")
        let first = RepositoryGrantStore(storageDirectory: storage, isSandboxed: false)

        let reference = try first.save(
            repositoryURL: repository,
            projectId: "token-warehouse",
            repositoryId: "main"
        )
        XCTAssertTrue(reference.hasPrefix("bookmark/token-warehouse/main/"))

        let relaunched = RepositoryGrantStore(storageDirectory: storage, isSandboxed: false)
        let resolved = try XCTUnwrap(relaunched.resolve(bookmarkRef: reference))
        XCTAssertEqual(
            resolved.url.resolvingSymlinksInPath().path(),
            repository.resolvingSymlinksInPath().path()
        )
        XCTAssertEqual(resolved.bookmarkRef, reference)
        XCTAssertFalse(resolved.isSecurityScoped)
    }

    func testDirectBuildBookmarkResolvesInANewProcess() throws {
        let storage = temporaryDirectory(prefix: "jarvis-process-grants")
        let repository = temporaryDirectory(prefix: "jarvis-process-repository")
        let store = RepositoryGrantStore(storageDirectory: storage, isSandboxed: false)
        _ = try store.save(
            repositoryURL: repository,
            projectId: "process-project",
            repositoryId: "main"
        )
        let storedFile = try XCTUnwrap(
            FileManager.default.contentsOfDirectory(
                at: storage,
                includingPropertiesForKeys: nil
            ).first
        )
        let script = storage.appendingPathComponent("probe.swift")
        try """
            import Foundation
            struct StoredBookmark: Decodable {
                let version: Int
                let isSecurityScoped: Bool
                let data: Data
            }
            let persisted = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
            let stored = try PropertyListDecoder().decode(StoredBookmark.self, from: persisted)
            guard stored.version == 1, !stored.isSecurityScoped else { exit(2) }
            var stale = false
            let url = try URL(
                resolvingBookmarkData: stored.data,
                options: [.withoutUI],
                relativeTo: nil,
                bookmarkDataIsStale: &stale
            )
            print(url.resolvingSymlinksInPath().path())
            """.write(to: script, atomically: true, encoding: .utf8)

        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = ["swift", script.path(), storedFile.path()]
        process.standardOutput = output
        process.standardError = output
        try process.run()
        process.waitUntilExit()

        let text = String(
            decoding: output.fileHandleForReading.readDataToEndOfFile(),
            as: UTF8.self
        ).trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertEqual(process.terminationStatus, 0, text)
        XCTAssertEqual(text, repository.resolvingSymlinksInPath().path())
    }

    func testUnknownStoredBookmarkVersionIsRejected() throws {
        struct StoredBookmark: Encodable {
            let version: Int
            let isSecurityScoped: Bool
            let data: Data
        }

        let storage = temporaryDirectory(prefix: "jarvis-version-grants")
        let repository = temporaryDirectory(prefix: "jarvis-version-repository")
        let store = RepositoryGrantStore(storageDirectory: storage, isSandboxed: false)
        let reference = try store.save(
            repositoryURL: repository,
            projectId: "version-project",
            repositoryId: "main"
        )
        let file = try XCTUnwrap(
            FileManager.default.contentsOfDirectory(
                at: storage,
                includingPropertiesForKeys: nil
            ).first
        )
        let bookmark = try repository.bookmarkData()
        let encoder = PropertyListEncoder()
        encoder.outputFormat = .binary
        try encoder.encode(StoredBookmark(
            version: 2,
            isSecurityScoped: false,
            data: bookmark
        )).write(to: file, options: .atomic)

        XCTAssertThrowsError(try store.resolve(bookmarkRef: reference))
    }

    func testSandboxedBuildKeepsASecurityScopedBookmark() throws {
        let storage = temporaryDirectory(prefix: "jarvis-sandbox-grants")
        let repository = temporaryDirectory(prefix: "jarvis-sandbox-repository")
        let store = RepositoryGrantStore(storageDirectory: storage, isSandboxed: true)
        let reference = try store.save(
            repositoryURL: repository,
            projectId: "sandbox-project",
            repositoryId: "main"
        )

        let resolved = try XCTUnwrap(store.resolve(bookmarkRef: reference))
        XCTAssertTrue(resolved.isSecurityScoped)
    }

    private func temporaryDirectory(prefix: String) -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        roots.append(root)
        return root
    }
}
