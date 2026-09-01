import Foundation
import Observation

/// The Project Registry as the shell shows it (docs/architecture/PROJECTS.md):
/// the sidebar list and the import flow. MACOS_APP.md: an AppModel owns this
/// state; the views derive from it and hold none of their own.
@MainActor
@Observable
public final class ProjectsModel {
    public private(set) var projects: [Project] = []
    public private(set) var isRefreshing = false
    /// The failure of the last refresh, phrased for the user.
    public private(set) var errorMessage: String?
    /// Per-project Repository Grant failures do not erase the Project Registry.
    /// The detail remains queryable and can explain how to grant access again.
    public private(set) var repositoryGrantMessages: [String: String] = [:]

    /// Where the import flow stands. The shell never imports before the user
    /// confirms the detected configuration (UX wizard step 2), and the sheet
    /// stays open while it shows `.failed` so the reason is seen.
    public private(set) var importState: ImportState = .idle
    /// The folder the import flow inspected, until the flow ends.
    public private(set) var inspectedPath: String?

    public enum ImportState: Equatable, Sendable {
        case idle
        case inspecting
        case confirm(RepositoryInspection)
        case saving
        case failed(String)
    }

    private let session: EngineSessionModel
    private let repositoryGrants: RepositoryGrantStore
    private var inspectedURL: URL?
    /// Retaining these URLs retains security-scoped access for the Engine Session.
    private var activeRepositoryURLs: [String: URL] = [:]

    public init(
        session: EngineSessionModel,
        repositoryGrants: RepositoryGrantStore = RepositoryGrantStore()
    ) {
        self.session = session
        self.repositoryGrants = repositoryGrants
    }

    private var client: EngineClient? { session.client }

    public func refresh() async {
        guard let client else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let restoredProjects = try await client.listProjects()
            for project in restoredProjects {
                await restoreRepositoryGrant(for: project, client: client)
            }
            projects = restoredProjects
            errorMessage = nil
        } catch {
            errorMessage = Self.describe(error)
        }
    }

    /// UX step 1: inspect the picked folder read-only, then offer what was found.
    public func inspect(at url: URL) async {
        guard let client else { return }
        let path = url.path(percentEncoded: false)
        importState = .inspecting
        inspectedPath = path
        inspectedURL = url
        do {
            try retainAccess(to: url, key: "pending-import")
            let inspection = try await client.discoverRepository(path: path)
            importState = .confirm(inspection)
        } catch {
            importState = .failed(Self.describe(error))
        }
    }

    public func cancelImport() {
        importState = .idle
        inspectedPath = nil
        inspectedURL = nil
        releaseAccess(key: "pending-import")
    }

    /// UX step 2: save what the user confirmed as a `draft` project.
    @discardableResult
    public func confirmImport() async -> Project? {
        guard let client, let path = inspectedPath, let repositoryURL = inspectedURL else {
            return nil
        }
        importState = .saving
        do {
            let detail = try await client.importProject(repositoryPath: path)
            if let binding = detail.bindings.first {
                do {
                    let bookmarkRef = try repositoryGrants.save(
                        repositoryURL: repositoryURL,
                        projectId: detail.project.id,
                        repositoryId: binding.repositoryId
                    )
                    try await client.updateRepositoryBinding(
                        projectId: detail.project.id,
                        repositoryId: binding.repositoryId,
                        path: repositoryURL.path(percentEncoded: false),
                        bookmarkRef: bookmarkRef
                    )
                    try retainAccess(to: repositoryURL, key: grantKey(
                        projectId: detail.project.id,
                        repositoryId: binding.repositoryId))
                    repositoryGrantMessages[detail.project.id] = nil
                } catch {
                    repositoryGrantMessages[detail.project.id] =
                        "Repository access could not be saved. Choose the repository again."
                }
            }
            importState = .idle
            inspectedPath = nil
            inspectedURL = nil
            releaseAccess(key: "pending-import")
            await refresh()
            return detail.project
        } catch {
            importState = .failed(Self.describe(error))
            return nil
        }
    }

    public func detail(for id: String) async throws -> ProjectDetail {
        guard let client else {
            throw EngineClientError.unexpectedResponse("The engine is not running")
        }
        return try await client.getProject(id: id)
    }

    private func restoreRepositoryGrant(for project: Project, client: EngineClient) async {
        do {
            let detail = try await client.getProject(id: project.id)
            guard let binding = detail.bindings.first else { return }
            guard let bookmarkRef = binding.bookmarkRef,
                let grant = try repositoryGrants.resolve(bookmarkRef: bookmarkRef)
            else {
                repositoryGrantMessages[project.id] =
                    "Repository access is unavailable. Choose the repository again."
                return
            }

            try retainAccess(
                to: grant.url,
                key: grantKey(projectId: project.id, repositoryId: binding.repositoryId)
            )
            if grant.isStale {
                try repositoryGrants.refresh(grant)
            }
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(
                atPath: grant.url.path(percentEncoded: false),
                isDirectory: &isDirectory
            ), isDirectory.boolValue else {
                repositoryGrantMessages[project.id] =
                    "The repository cannot be reached. Choose the repository again."
                return
            }

            try await client.updateRepositoryBinding(
                projectId: project.id,
                repositoryId: binding.repositoryId,
                path: grant.url.path(percentEncoded: false),
                bookmarkRef: grant.bookmarkRef
            )
            repositoryGrantMessages[project.id] = nil
        } catch {
            repositoryGrantMessages[project.id] =
                "Repository access could not be restored. Choose the repository again."
        }
    }

    private func retainAccess(to url: URL, key: String) throws {
        if let current = activeRepositoryURLs[key],
            current.standardizedFileURL != url.standardizedFileURL
        {
            releaseAccess(key: key)
        }
        let alreadyActive = activeRepositoryURLs.values.contains {
            $0.standardizedFileURL == url.standardizedFileURL
        }
        if !alreadyActive {
            let started = url.startAccessingSecurityScopedResource()
            // Direct builds return false because no scope is required. In App
            // Sandbox, false means the path was not authorized for the Engine.
            if !started && ProcessInfo.processInfo.environment["APP_SANDBOX_CONTAINER_ID"] != nil {
                throw RepositoryGrantAccessError.denied
            }
        }
        activeRepositoryURLs[key] = url
    }

    private func releaseAccess(key: String) {
        guard let url = activeRepositoryURLs.removeValue(forKey: key) else { return }
        let remainsActive = activeRepositoryURLs.values.contains {
            $0.standardizedFileURL == url.standardizedFileURL
        }
        if !remainsActive {
            url.stopAccessingSecurityScopedResource()
        }
    }

    public func reauthorize(
        projectId: String,
        repositoryId: String,
        replacing previousBookmarkRef: String?,
        with url: URL
    ) async -> Bool {
        guard let client else { return false }
        var newBookmarkRef: String?
        do {
            try retainAccess(to: url, key: "pending-reauthorization")
            let bookmarkRef = try repositoryGrants.save(
                repositoryURL: url,
                projectId: projectId,
                repositoryId: repositoryId
            )
            newBookmarkRef = bookmarkRef
            try await client.updateRepositoryBinding(
                projectId: projectId,
                repositoryId: repositoryId,
                path: url.path(percentEncoded: false),
                bookmarkRef: bookmarkRef
            )
            try retainAccess(
                to: url,
                key: grantKey(projectId: projectId, repositoryId: repositoryId)
            )
            releaseAccess(key: "pending-reauthorization")
            if let previousBookmarkRef, previousBookmarkRef != bookmarkRef {
                try? repositoryGrants.remove(bookmarkRef: previousBookmarkRef)
            }
            repositoryGrantMessages[projectId] = nil
            return true
        } catch {
            if let newBookmarkRef {
                try? repositoryGrants.remove(bookmarkRef: newBookmarkRef)
            }
            releaseAccess(key: "pending-reauthorization")
            repositoryGrantMessages[projectId] =
                "Repository access could not be restored. Choose an accessible repository."
            return false
        }
    }

    public func releaseRepositoryAccess() {
        for key in Array(activeRepositoryURLs.keys) {
            releaseAccess(key: key)
        }
    }

    private func grantKey(projectId: String, repositoryId: String) -> String {
        "\(projectId)/\(repositoryId)"
    }

    /// coding-standards.md: user-facing errors state cause, impact and next
    /// action. A blank error is never the outcome. The app's views surface it.
    public static func describe(_ error: Error) -> String {
        if let error = error as? EngineClientError {
            switch error {
            case .unauthorized(let operation):
                return "The engine rejected the session token (\(operation)). Restart Jarvis."
            case .hostNotAllowed(let operation):
                return "The engine refused a request that does not address this machine (\(operation)). Restart Jarvis."
            case .engineError(_, let code, let message):
                return switch code {
                case "project.already-imported":
                    "\(message) (\(code)) Select the existing project in the sidebar instead."
                case "project.config-invalid":
                    "\(message) (\(code)) No project was created. Fix .jarvis/project.yaml and try again."
                case "repository.path-invalid":
                    "\(message) (\(code)) No project was created. Choose an accessible repository folder and try again."
                case "engine.database-unavailable":
                    "\(message) (\(code)) Projects cannot be loaded or saved. Restart Jarvis; if this repeats, inspect its local data."
                case "project.not-found":
                    "\(message) (\(code)) The selected project is no longer available. Refresh the project list."
                default:
                    "\(message) (\(code)) The operation did not complete. Try again; if it repeats, restart Jarvis."
                }
            case .unexpectedResponse(let message):
                return message
            }
        }
        return error.localizedDescription
    }
}

private enum RepositoryGrantAccessError: Error {
    case denied
}
