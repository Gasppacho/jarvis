import Observation

public struct ProjectExecutionDetailState: Sendable, Equatable {
    public var detail: ProjectExecutionDetail?
    public var isLoading = false
    public var isRetrying = false
    public var isCancelling = false
    public var errorMessage: String?

    public init(
        detail: ProjectExecutionDetail? = nil,
        isLoading: Bool = false,
        isRetrying: Bool = false,
        isCancelling: Bool = false,
        errorMessage: String? = nil
    ) {
        self.detail = detail
        self.isLoading = isLoading
        self.isRetrying = isRetrying
        self.isCancelling = isCancelling
        self.errorMessage = errorMessage
    }
}

/// Keeps the last complete detail snapshot visible while the Engine reconnects
/// or a live event causes a refresh.
@MainActor
@Observable
public final class ProjectExecutionDetailModel {
    public typealias DetailProvider = @Sendable (String, String) async throws -> ProjectExecutionDetail
    public typealias RetryProvider = @Sendable (String) async throws -> TimelineExecution
    public typealias CancellationProvider = @Sendable (String) async throws -> TimelineExecution

    public private(set) var states: [String: ProjectExecutionDetailState] = [:]

    private let session: EngineSessionModel
    private let provider: DetailProvider?
    private let retryProvider: RetryProvider?
    private let cancellationProvider: CancellationProvider?
    private var revisions: [String: Int] = [:]

    public init(session: EngineSessionModel) {
        self.session = session
        provider = nil
        retryProvider = nil
        cancellationProvider = nil
    }

    init(
        session: EngineSessionModel,
        provider: DetailProvider? = nil,
        retryProvider: RetryProvider? = nil,
        cancellationProvider: CancellationProvider? = nil
    ) {
        self.session = session
        self.provider = provider
        self.retryProvider = retryProvider
        self.cancellationProvider = cancellationProvider
    }

    public func state(for projectId: String, executionId: String) -> ProjectExecutionDetailState {
        states[key(projectId, executionId)] ?? ProjectExecutionDetailState()
    }

    public func refresh(projectId: String, executionId: String) async {
        let detailProvider: DetailProvider
        if let provider {
            detailProvider = provider
        } else if let client = session.client {
            detailProvider = { projectId, executionId in
                try await client.getExecutionDetail(projectId: projectId, executionId: executionId)
            }
        } else {
            setError(Self.engineUnavailable, projectId: projectId, executionId: executionId)
            return
        }
        await load(projectId: projectId, executionId: executionId, using: detailProvider)
    }

    public func watch(projectId: String, executionId: String) async {
        // ponytail: poll the local snapshot while visible; use checkpoint SSE if traffic warrants it.
        while !Task.isCancelled {
            await refresh(projectId: projectId, executionId: executionId)
            do { try await Task.sleep(for: .seconds(1)) }
            catch { return }
        }
    }

    @discardableResult
    public func retry(projectId: String, executionId: String) async -> Bool {
        let stateKey = key(projectId, executionId)
        guard let deliveryId = states[stateKey]?.detail?.retryDeliveryId,
              states[stateKey]?.isRetrying != true
        else { return false }
        let retryProvider: RetryProvider
        if let injectedRetryProvider = self.retryProvider {
            retryProvider = injectedRetryProvider
        } else if let client = session.client {
            retryProvider = { try await client.replayDeadLetter(deliveryId: $0) }
        } else {
            setError(Self.engineUnavailable, projectId: projectId, executionId: executionId)
            return false
        }
        revisions[stateKey, default: 0] += 1
        states[stateKey, default: ProjectExecutionDetailState()].isRetrying = true
        states[stateKey]?.errorMessage = nil
        defer { states[stateKey]?.isRetrying = false }
        do {
            _ = try await retryProvider(deliveryId)
            await refresh(projectId: projectId, executionId: executionId)
            return true
        } catch is CancellationError {
            return false
        } catch {
            setError(Self.describe(error), projectId: projectId, executionId: executionId)
            return false
        }
    }

    @discardableResult
    public func cancelExecution(
        projectId: String,
        executionId: String,
        targetExecutionId: String? = nil
    ) async -> Bool {
        let stateKey = key(projectId, executionId)
        let targetExecutionId = targetExecutionId ?? executionId
        guard let detail = states[stateKey]?.detail,
              detail.cancellableExecutionId == targetExecutionId,
              let execution = detail.executions.first(where: { $0.id == targetExecutionId }),
              execution.status == .running,
              states[stateKey]?.isCancelling != true
        else { return false }

        let cancellationProvider: CancellationProvider
        if let injectedCancellationProvider = self.cancellationProvider {
            cancellationProvider = injectedCancellationProvider
        } else if let client = session.client {
            cancellationProvider = { try await client.cancelExecution(executionId: $0) }
        } else {
            setError(Self.engineUnavailable, projectId: projectId, executionId: executionId)
            return false
        }

        revisions[stateKey, default: 0] += 1
        states[stateKey, default: ProjectExecutionDetailState()].isCancelling = true
        states[stateKey]?.errorMessage = nil
        var accepted = false
        defer {
            if !accepted {
                states[stateKey]?.isCancelling = false
            }
        }
        do {
            _ = try await cancellationProvider(targetExecutionId)
            accepted = true
            await refresh(projectId: projectId, executionId: executionId)
            if states[stateKey]?.detail?.cancellableExecutionId == targetExecutionId {
                states[stateKey]?.isCancelling = true
            }
            return true
        } catch is CancellationError {
            return false
        } catch {
            setError(Self.describe(error), projectId: projectId, executionId: executionId)
            return false
        }
    }

    private func load(
        projectId: String,
        executionId: String,
        using provider: @escaping DetailProvider
    ) async {
        let stateKey = key(projectId, executionId)
        let revision = (revisions[stateKey] ?? 0) + 1
        revisions[stateKey] = revision
        states[stateKey, default: ProjectExecutionDetailState()].isLoading = true
        states[stateKey]?.errorMessage = nil
        do {
            let detail = try await provider(projectId, executionId)
            guard revisions[stateKey] == revision else { return }
            states[stateKey] = ProjectExecutionDetailState(detail: detail)
        } catch is CancellationError {
            guard revisions[stateKey] == revision else { return }
            states[stateKey]?.isLoading = false
        } catch {
            guard revisions[stateKey] == revision else { return }
            states[stateKey]?.isLoading = false
            states[stateKey]?.errorMessage = Self.describe(error)
        }
    }

    private func setError(_ message: String, projectId: String, executionId: String) {
        let stateKey = key(projectId, executionId)
        states[stateKey, default: ProjectExecutionDetailState()].isLoading = false
        states[stateKey]?.errorMessage = message
    }

    private func key(_ projectId: String, _ executionId: String) -> String {
        "\(projectId)\u{1f}\(executionId)"
    }

    private static let engineUnavailable =
        "The engine is not running, so this execution detail is unavailable."

    private static func describe(_ error: Error) -> String {
        let message = error.localizedDescription
        return message.isEmpty ? String(describing: error) : message
    }
}
