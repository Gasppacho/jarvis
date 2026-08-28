import Foundation
import Observation

/// Owns the project list shown by the shell. All durable truth stays in the
/// engine; this model only mirrors what the Local API reports.
@MainActor
@Observable
public final class ProjectsModel {
    public private(set) var projects: [Project] = []
    public private(set) var isImporting = false
    /// Actionable message for the user, never a raw transport error.
    public private(set) var errorMessage: String?

    private var client: EngineClient?

    public init() {}

    public func attach(client: EngineClient) {
        self.client = client
    }

    public func refresh() async {
        guard let client else { return }
        do {
            projects = try await client.listProjects()
            errorMessage = nil
        } catch {
            errorMessage = Self.describe(error)
        }
    }

    /// Imports the folder the user granted access to, then refreshes the list.
    public func importRepository(at path: String) async {
        guard let client, !isImporting else { return }
        isImporting = true
        defer { isImporting = false }

        do {
            let imported = try await client.importProject(repositoryPath: path)
            errorMessage = nil
            if !projects.contains(where: { $0.id == imported.id }) {
                projects.append(imported)
            }
            await refresh()
        } catch {
            errorMessage = Self.describe(error)
        }
    }

    private static func describe(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
