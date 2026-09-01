import Foundation

/// Durable, shell-owned repository access (MACOS_APP.md "Repository access").
/// The engine stores only the opaque bookmark reference in Local Bindings; the
/// security-scoped bookmark bytes never cross the Local API boundary.
public final class RepositoryGrantStore {
    public struct ResolvedGrant: Sendable, Equatable {
        public let url: URL
        public let bookmarkRef: String
        public let isStale: Bool
    }

    private let storageDirectory: URL
    private let fileManager: FileManager

    public convenience init() {
        self.init(storageDirectory: Self.defaultStorageDirectory())
    }

    public init(
        storageDirectory: URL,
        fileManager: FileManager = .default
    ) {
        self.storageDirectory = storageDirectory
        self.fileManager = fileManager
    }

    @discardableResult
    public func save(
        repositoryURL: URL,
        projectId: String,
        repositoryId: String
    ) throws -> String {
        let reference = Self.reference(projectId: projectId, repositoryId: repositoryId)
        try writeBookmark(repositoryURL: repositoryURL, bookmarkRef: reference)
        return reference
    }

    public func refresh(_ grant: ResolvedGrant) throws {
        try writeBookmark(repositoryURL: grant.url, bookmarkRef: grant.bookmarkRef)
    }

    public func remove(bookmarkRef: String) throws {
        let file = fileURL(for: bookmarkRef)
        if fileManager.fileExists(atPath: file.path()) {
            try fileManager.removeItem(at: file)
        }
    }

    private func writeBookmark(repositoryURL: URL, bookmarkRef: String) throws {
        let bookmark = try repositoryURL.bookmarkData(
            options: [.withSecurityScope],
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )
        try fileManager.createDirectory(
            at: storageDirectory,
            withIntermediateDirectories: true
        )
        try bookmark.write(to: fileURL(for: bookmarkRef), options: .atomic)
    }

    public func resolve(bookmarkRef: String) throws -> ResolvedGrant? {
        let file = fileURL(for: bookmarkRef)
        guard fileManager.fileExists(atPath: file.path()) else { return nil }

        let bookmark = try Data(contentsOf: file)
        var stale = false
        let url = try URL(
            resolvingBookmarkData: bookmark,
            options: [.withSecurityScope, .withoutUI],
            relativeTo: nil,
            bookmarkDataIsStale: &stale
        )
        return ResolvedGrant(url: url, bookmarkRef: bookmarkRef, isStale: stale)
    }

    public static func reference(projectId: String, repositoryId: String) -> String {
        "bookmark/\(projectId)/\(repositoryId)/\(UUID().uuidString.lowercased())"
    }

    private func fileURL(for reference: String) -> URL {
        let filename = Data(reference.utf8).base64EncodedString()
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "=", with: "")
        return storageDirectory.appendingPathComponent("\(filename).bookmark")
    }

    private static func defaultStorageDirectory() -> URL {
        let base = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.homeDirectoryForCurrentUser
        return base
            .appendingPathComponent("Jarvis", isDirectory: true)
            .appendingPathComponent("Repository Grants", isDirectory: true)
    }
}
