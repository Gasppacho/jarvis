import Foundation

/// Durable, shell-owned repository access (MACOS_APP.md "Repository access").
/// The engine stores only the opaque bookmark reference in Local Bindings; the
/// security-scoped bookmark bytes never cross the Local API boundary.
public final class RepositoryGrantStore {
    public struct ResolvedGrant: Sendable, Equatable {
        public let url: URL
        public let bookmarkRef: String
        public let isStale: Bool
        public let isSecurityScoped: Bool
    }

    private struct StoredBookmark: Codable {
        let version: Int
        let isSecurityScoped: Bool
        let data: Data
    }

    private let storageDirectory: URL
    private let fileManager: FileManager
    private let isSandboxed: Bool

    public convenience init() {
        self.init(
            storageDirectory: Self.defaultStorageDirectory(),
            isSandboxed: Self.detectSandbox()
        )
    }

    public convenience init(
        storageDirectory: URL,
        fileManager: FileManager = .default
    ) {
        self.init(
            storageDirectory: storageDirectory,
            fileManager: fileManager,
            isSandboxed: Self.detectSandbox()
        )
    }

    public init(
        storageDirectory: URL,
        fileManager: FileManager = .default,
        isSandboxed: Bool
    ) {
        self.storageDirectory = storageDirectory
        self.fileManager = fileManager
        self.isSandboxed = isSandboxed
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
        if fileManager.fileExists(atPath: file.path(percentEncoded: false)) {
            try fileManager.removeItem(at: file)
        }
    }

    private func writeBookmark(repositoryURL: URL, bookmarkRef: String) throws {
        let options: URL.BookmarkCreationOptions = isSandboxed ? [.withSecurityScope] : []
        let bookmark = try repositoryURL.bookmarkData(
            options: options,
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )
        let stored = StoredBookmark(
            version: 1,
            isSecurityScoped: isSandboxed,
            data: bookmark
        )
        let encoder = PropertyListEncoder()
        encoder.outputFormat = .binary
        let encoded = try encoder.encode(stored)
        try fileManager.createDirectory(
            at: storageDirectory,
            withIntermediateDirectories: true
        )
        try encoded.write(to: fileURL(for: bookmarkRef), options: .atomic)
    }

    public func resolve(bookmarkRef: String) throws -> ResolvedGrant? {
        let file = fileURL(for: bookmarkRef)
        guard fileManager.fileExists(atPath: file.path(percentEncoded: false)) else { return nil }

        let persisted = try Data(contentsOf: file)
        let stored: StoredBookmark?
        if persisted.starts(with: Data("bplist00".utf8)) || persisted.starts(with: Data("<?xml".utf8)) {
            let decoded = try PropertyListDecoder().decode(StoredBookmark.self, from: persisted)
            guard decoded.version == 1 else {
                throw RepositoryGrantStoreError.unsupportedVersion(decoded.version)
            }
            stored = decoded
        } else {
            // Before v1, bookmarks were written as raw security-scoped bytes.
            stored = nil
        }

        let bookmark = stored?.data ?? persisted
        let securityScoped = stored?.isSecurityScoped ?? true
        let options: URL.BookmarkResolutionOptions = securityScoped
            ? [.withSecurityScope, .withoutUI]
            : [.withoutUI]
        var stale = false
        let url = try URL(
            resolvingBookmarkData: bookmark,
            options: options,
            relativeTo: nil,
            bookmarkDataIsStale: &stale
        )

        // Convert a readable legacy bookmark to the mode appropriate for this
        // distribution. An unreadable legacy grant requires explicit re-consent.
        if stored == nil && !isSandboxed {
            try writeBookmark(repositoryURL: url, bookmarkRef: bookmarkRef)
            return try resolve(bookmarkRef: bookmarkRef)
        }
        return ResolvedGrant(
            url: url,
            bookmarkRef: bookmarkRef,
            isStale: stale,
            isSecurityScoped: securityScoped
        )
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

    private static func detectSandbox() -> Bool {
        ProcessInfo.processInfo.environment["APP_SANDBOX_CONTAINER_ID"] != nil
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

private enum RepositoryGrantStoreError: Error {
    case unsupportedVersion(Int)
}
