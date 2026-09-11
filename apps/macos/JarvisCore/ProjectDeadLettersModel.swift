import Observation

public struct ProjectDeadLettersState: Sendable, Equatable {
    public var deadLetters: [DeadLetter] = []
    public var isLoading = false
    public var replayingDeliveryIDs: Set<String> = []
    public var errorMessage: String?
    public var replayErrorMessages: [String: String] = [:]
}

/// Project-scoped diagnosis state. All data and actions come from the Local
/// API; the shell never reads the Engine database or replays business logic.
@MainActor
@Observable
public final class ProjectDeadLettersModel {
    public private(set) var states: [String: ProjectDeadLettersState] = [:]

    private let session: EngineSessionModel?
    private let injectedAPI: (any DeadLettersAPI)?
    private var revisions: [String: Int] = [:]

    public init(session: EngineSessionModel) {
        self.session = session
        injectedAPI = nil
    }

    init(api: any DeadLettersAPI) {
        session = nil
        injectedAPI = api
    }

    public func state(for projectId: String) -> ProjectDeadLettersState {
        states[projectId] ?? ProjectDeadLettersState()
    }

    public func refresh(projectId: String) async {
        let revision = (revisions[projectId] ?? 0) + 1
        revisions[projectId] = revision
        guard let api else {
            update(projectId) {
                $0.isLoading = false
                $0.errorMessage = Self.engineUnavailable
            }
            return
        }

        update(projectId) {
            $0.isLoading = true
            $0.errorMessage = nil
        }
        do {
            let deadLetters = try await api.listProjectDeadLetters(projectId: projectId)
            guard !Task.isCancelled, revisions[projectId] == revision else { return }
            let ids = Set(deadLetters.map(\.deliveryId))
            states[projectId] = ProjectDeadLettersState(
                deadLetters: deadLetters,
                isLoading: false,
                replayErrorMessages: states[projectId]?.replayErrorMessages.filter {
                    ids.contains($0.key)
                } ?? [:])
        } catch is CancellationError {
            guard revisions[projectId] == revision else { return }
            states[projectId]?.isLoading = false
        } catch {
            guard revisions[projectId] == revision else { return }
            update(projectId) {
                $0.isLoading = false
                $0.errorMessage = Self.describe(error)
            }
        }
    }

    @discardableResult
    public func replay(projectId: String, deliveryId: String) async -> Bool {
        guard states[projectId]?.deadLetters.contains(where: { $0.deliveryId == deliveryId }) == true,
            states[projectId]?.replayingDeliveryIDs.contains(deliveryId) != true
        else { return false }
        guard let api else {
            setReplayError(Self.engineUnavailable, projectId: projectId, deliveryId: deliveryId)
            return false
        }

        // A replay supersedes an in-flight list request for this Project, so a
        // stale response cannot put a successfully replayed row back on screen.
        revisions[projectId, default: 0] += 1
        states[projectId]?.isLoading = false
        states[projectId]?.replayingDeliveryIDs.insert(deliveryId)
        states[projectId]?.replayErrorMessages[deliveryId] = nil
        defer { states[projectId]?.replayingDeliveryIDs.remove(deliveryId) }
        do {
            let execution = try await api.replayDeadLetter(deliveryId: deliveryId)
            guard execution.status != .failed else {
                setReplayError(
                    "Replay execution \(execution.id) failed.",
                    projectId: projectId,
                    deliveryId: deliveryId)
                return false
            }
            states[projectId]?.deadLetters.removeAll { $0.deliveryId == deliveryId }
            states[projectId]?.replayErrorMessages[deliveryId] = nil
            return true
        } catch is CancellationError {
            return false
        } catch {
            setReplayError(Self.describe(error), projectId: projectId, deliveryId: deliveryId)
            return false
        }
    }

    private var api: (any DeadLettersAPI)? {
        injectedAPI ?? session?.client
    }

    private func update(
        _ projectId: String,
        _ change: (inout ProjectDeadLettersState) -> Void
    ) {
        var state = states[projectId] ?? ProjectDeadLettersState()
        change(&state)
        states[projectId] = state
    }

    private func setReplayError(_ message: String, projectId: String, deliveryId: String) {
        update(projectId) { $0.replayErrorMessages[deliveryId] = message }
    }

    public static func describe(_ error: Error) -> String {
        guard let error = error as? EngineClientError else {
            return error.localizedDescription
        }
        switch error {
        case .unauthorized(let operation):
            return "The engine rejected the session token (\(operation)). Restart Jarvis."
        case .hostNotAllowed(let operation):
            return "The engine refused a non-loopback request (\(operation)). Restart Jarvis."
        case .engineError(_, let code, let message):
            return "\(message) (\(code))"
        case .unexpectedResponse(let message):
            return message
        }
    }

    private static let engineUnavailable = "The engine is not running. Restart Jarvis."
}
