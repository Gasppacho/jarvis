import Foundation
import Observation

public enum ProjectGraphLoadState: Sendable, Equatable {
    case loading
    case loaded(ProjectGraph)
    case neverActivated
    case error(String)
}

/// Project-scoped emergent graph state. A missing key means this Project has
/// not been requested; no other Project's rows can be used as its fallback.
@MainActor
@Observable
public final class ProjectGraphModel {
    public private(set) var states: [String: ProjectGraphLoadState] = [:]

    typealias GraphProvider = @Sendable (String) async throws -> ProjectGraph

    private let session: EngineSessionModel
    private let provider: GraphProvider?
    private var revisions: [String: Int] = [:]

    public init(session: EngineSessionModel) {
        self.session = session
        provider = nil
    }

    init(session: EngineSessionModel, provider: GraphProvider?) {
        self.session = session
        self.provider = provider
    }

    public func state(for projectId: String) -> ProjectGraphLoadState? {
        states[projectId]
    }

    public func refresh(projectId: String) async {
        let revision = (revisions[projectId] ?? 0) + 1
        revisions[projectId] = revision
        states[projectId] = .loading

        let fetch: GraphProvider
        if let provider {
            fetch = provider
        } else if let client = session.client {
            fetch = { projectId in
                try await client.fetchProjectGraph(projectId: projectId)
            }
        } else {
            states[projectId] = .error(Self.engineUnavailable)
            return
        }

        do {
            let graph = try await fetch(projectId)
            guard revisions[projectId] == revision else { return }
            states[projectId] = graph.isNeverActivated ? .neverActivated : .loaded(graph)
        } catch is CancellationError {
            guard revisions[projectId] == revision else { return }
            states.removeValue(forKey: projectId)
        } catch {
            guard revisions[projectId] == revision else { return }
            states[projectId] = .error(Self.describe(error))
        }
    }

    private static let engineUnavailable =
        "The engine is not running, so this Project graph is unavailable."

    private static func describe(_ error: Error) -> String {
        let message = error.localizedDescription
        return message.isEmpty ? String(describing: error) : message
    }
}
