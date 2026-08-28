import Foundation

/// A repository the user imported into Jarvis.
public struct Project: Sendable, Identifiable, Equatable {
    public let id: String
    public let name: String
    public let status: String
    public let moduleCount: Int

    public init(id: String, name: String, status: String, moduleCount: Int) {
        self.id = id
        self.name = name
        self.status = status
        self.moduleCount = moduleCount
    }

    /// A draft still needs the wizard before it can be validated or activated.
    public var isDraft: Bool { status == "draft" }
}

/// What read-only inspection of a folder found, used to pre-fill the wizard.
public struct RepositoryInspection: Sendable, Equatable {
    public let isGitRepository: Bool
    public let remoteUrl: String?
    public let provider: String?
    public let defaultBranch: String?
    public let packageManager: String?

    public init(
        isGitRepository: Bool,
        remoteUrl: String?,
        provider: String?,
        defaultBranch: String?,
        packageManager: String?
    ) {
        self.isGitRepository = isGitRepository
        self.remoteUrl = remoteUrl
        self.provider = provider
        self.defaultBranch = defaultBranch
        self.packageManager = packageManager
    }
}
