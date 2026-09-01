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
        let first = RepositoryGrantStore(storageDirectory: storage)

        let reference = try first.save(
            repositoryURL: repository,
            projectId: "token-warehouse",
            repositoryId: "main"
        )
        XCTAssertTrue(reference.hasPrefix("bookmark/token-warehouse/main/"))

        let relaunched = RepositoryGrantStore(storageDirectory: storage)
        let resolved = try XCTUnwrap(relaunched.resolve(bookmarkRef: reference))
        XCTAssertEqual(
            resolved.url.resolvingSymlinksInPath().path(),
            repository.resolvingSymlinksInPath().path()
        )
        XCTAssertEqual(resolved.bookmarkRef, reference)
    }

    private func temporaryDirectory(prefix: String) -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        roots.append(root)
        return root
    }
}
