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

    public init(session: EngineSessionModel) {
        self.session = session
    }

    private var client: EngineClient? { session.client }

    public func refresh() async {
        guard let client else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            projects = try await client.listProjects()
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
        do {
            let inspection = try await client.discoverRepository(path: path)
            importState = .confirm(inspection)
        } catch {
            importState = .failed(Self.describe(error))
        }
    }

    public func cancelImport() {
        importState = .idle
        inspectedPath = nil
    }

    /// UX step 2: save what the user confirmed as a `draft` project.
    @discardableResult
    public func confirmImport() async -> Project? {
        guard let client, let path = inspectedPath else { return nil }
        importState = .saving
        do {
            let detail = try await client.importProject(repositoryPath: path)
            importState = .idle
            inspectedPath = nil
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
