import Observation

public struct ProjectOverviewState: Sendable, Equatable {
    public var overview: ProjectOverview?
    public var isLoading = false
    public var errorMessage: String?

    public init(overview: ProjectOverview? = nil, isLoading: Bool = false, errorMessage: String? = nil) {
        self.overview = overview
        self.isLoading = isLoading
        self.errorMessage = errorMessage
    }
}

public enum ProjectOverviewAction: Sendable, Equatable {
    case pause
    case resume
}

/// Project-scoped Overview state. The Engine owns the snapshot and polling;
/// this model only keeps the last complete response visible while a refresh or
/// a retry is in flight.
@MainActor
@Observable
public final class ProjectOverviewModel {
    public typealias OverviewProvider = @Sendable (String) async throws -> ProjectOverview
    public typealias ActionProvider = @Sendable (String, ProjectOverviewAction) async throws -> Project

    public private(set) var states: [String: ProjectOverviewState] = [:]

    private let session: EngineSessionModel
    private let provider: OverviewProvider?
    private let retryProvider: OverviewProvider?
    private let actionProvider: ActionProvider?
    private var revisions: [String: Int] = [:]

    public init(session: EngineSessionModel) {
        self.session = session
        provider = nil
        retryProvider = nil
        actionProvider = nil
    }

    init(
        session: EngineSessionModel,
        provider: OverviewProvider? = nil,
        retryProvider: OverviewProvider? = nil,
        actionProvider: ActionProvider? = nil
    ) {
        self.session = session
        self.provider = provider
        self.retryProvider = retryProvider
        self.actionProvider = actionProvider
    }

    public func state(for projectId: String) -> ProjectOverviewState {
        states[projectId] ?? ProjectOverviewState()
    }

    public func refresh(projectId: String) async {
        if let provider {
            await load(projectId: projectId, using: provider)
        } else if let client = session.client {
            await load(projectId: projectId) { id in
                try await client.getProjectOverview(projectId: id)
            }
        } else {
            setError(Self.engineUnavailable, projectId: projectId)
        }
    }

    /// A retry asks the Engine to poll GitHub immediately, then displays the
    /// resulting durable snapshot. It is separate from the read-only refresh.
    public func retryPolling(projectId: String) async {
        if let retryProvider {
            await load(projectId: projectId, using: retryProvider)
        } else if let client = session.client {
            await load(projectId: projectId) { id in
                try await client.refreshProjectOverview(projectId: id)
            }
        } else {
            setError(Self.engineUnavailable, projectId: projectId)
        }
    }

    public func pause(projectId: String) async {
        await perform(.pause, projectId: projectId)
    }

    public func resume(projectId: String) async {
        await perform(.resume, projectId: projectId)
    }

    private func perform(_ action: ProjectOverviewAction, projectId: String) async {
        let actionProvider: ActionProvider
        if let injectedProvider = self.actionProvider {
            actionProvider = injectedProvider
        } else if let client = session.client {
            actionProvider = { id, action in
                switch action {
                case .pause: try await client.pauseProject(projectId: id)
                case .resume: try await client.resumeProject(projectId: id)
                }
            }
        } else {
            setError(Self.engineUnavailable, projectId: projectId)
            return
        }

        do {
            _ = try await actionProvider(projectId, action)
            await refresh(projectId: projectId)
        } catch is CancellationError {
            return
        } catch {
            setError(Self.describe(error), projectId: projectId)
        }
    }

    private func load(
        projectId: String,
        using provider: @escaping @Sendable (String) async throws -> ProjectOverview
    ) async {
        let revision = (revisions[projectId] ?? 0) + 1
        revisions[projectId] = revision
        var state = states[projectId] ?? ProjectOverviewState()
        state.isLoading = true
        state.errorMessage = nil
        states[projectId] = state

        do {
            let overview = try await provider(projectId)
            guard revisions[projectId] == revision else { return }
            states[projectId] = ProjectOverviewState(overview: overview)
        } catch is CancellationError {
            guard revisions[projectId] == revision else { return }
            states[projectId]?.isLoading = false
        } catch {
            guard revisions[projectId] == revision else { return }
            var failed = states[projectId] ?? ProjectOverviewState()
            failed.isLoading = false
            failed.errorMessage = Self.describe(error)
            states[projectId] = failed
        }
    }

    private func setError(_ message: String, projectId: String) {
        var state = states[projectId] ?? ProjectOverviewState()
        state.isLoading = false
        state.errorMessage = message
        states[projectId] = state
    }

    private static let engineUnavailable =
        "The engine is not running, so this Project Overview is unavailable."

    private static func describe(_ error: Error) -> String {
        let message = error.localizedDescription
        return message.isEmpty ? String(describing: error) : message
    }
}
