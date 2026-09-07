import Observation

/// Ticket #61: per-Project Timeline snapshot from the Local API only (no SSE
/// yet — ticket #62). Keyed by projectId, like `ProjectConfigurationModel`,
/// so switching Projects can never show a previous Project's rows: a Project
/// not yet fetched simply has no entry, never another Project's entry.
public struct ProjectTimelineState: Sendable, Equatable {
    public var events: [TimelineEvent] = []
    public var executions: [TimelineExecution] = []
    public var isLoading = false
    public var errorMessage: String?
}

@MainActor
@Observable
public final class ProjectTimelineModel {
    public private(set) var states: [String: ProjectTimelineState] = [:]

    /// Test seam: a fake fetch, so cancellation and race behavior can be
    /// asserted without a running engine (mirrors
    /// `ProjectConfigurationModel.ValidationReportProvider`).
    typealias TimelineProvider = @Sendable (String) async throws -> (
        events: [TimelineEvent], executions: [TimelineExecution]
    )

    private let session: EngineSessionModel
    private let provider: TimelineProvider?
    /// Guards against a slow, stale request for a Project overwriting a
    /// newer one's result after the user has already moved on and back.
    private var revisions: [String: Int] = [:]

    public init(session: EngineSessionModel) {
        self.session = session
        provider = nil
    }

    init(session: EngineSessionModel, provider: TimelineProvider? = nil) {
        self.session = session
        self.provider = provider
    }

    public func state(for projectId: String) -> ProjectTimelineState {
        states[projectId] ?? ProjectTimelineState()
    }

    public func refresh(projectId: String) async {
        let revision = (revisions[projectId] ?? 0) + 1
        revisions[projectId] = revision
        let fetch: TimelineProvider
        if let provider {
            fetch = provider
        } else if let client = session.client {
            fetch = { projectId in
                async let events = client.listProjectEvents(projectId: projectId)
                async let executions = client.listProjectExecutions(projectId: projectId)
                return try await (events, executions)
            }
        } else {
            states[projectId] = ProjectTimelineState(errorMessage: Self.engineUnavailable)
            return
        }
        states[projectId, default: ProjectTimelineState()].isLoading = true
        states[projectId]?.errorMessage = nil
        do {
            let (fetchedEvents, fetchedExecutions) = try await fetch(projectId)
            guard revisions[projectId] == revision else { return }
            states[projectId] = ProjectTimelineState(
                events: fetchedEvents, executions: fetchedExecutions, isLoading: false)
        } catch is CancellationError {
            // The user moved to another Project (or tab) mid-fetch — never an
            // engine failure. Left unrecorded so #62's rehydration never
            // reads a failure that never happened (findings-review #61-6);
            // the previous complete snapshot, if any, stays exactly as it was.
            guard revisions[projectId] == revision else { return }
            states[projectId]?.isLoading = false
        } catch {
            guard revisions[projectId] == revision else { return }
            states[projectId] = ProjectTimelineState(
                isLoading: false, errorMessage: Self.describe(error))
        }
    }

    private static let engineUnavailable = "The engine is not running. Restart Jarvis."

    private static func describe(_ error: Error) -> String {
        guard let error = error as? EngineClientError else {
            return "The Timeline could not be loaded. Try again; if it repeats, restart Jarvis."
        }
        return switch error {
        case .unauthorized(let operation):
            "The engine rejected the session token (\(operation)). The Timeline cannot be loaded. Restart Jarvis."
        case .hostNotAllowed(let operation):
            "The engine refused a non-loopback request (\(operation)). The Timeline cannot be loaded. Restart Jarvis."
        case .engineError(_, let code, let message):
            "\(message) (\(code)) The Timeline cannot be loaded. Try again; if it repeats, restart Jarvis."
        case .unexpectedResponse(let message):
            "\(message). The Timeline cannot be loaded. Try again; if it repeats, restart Jarvis."
        }
    }
}
