import Foundation
import Observation

/// What the shell shows about the engine, and nothing more. All durable truth
/// stays behind the Local API.
public enum EngineStatus: Sendable, Equatable {
    case starting
    case ready(EngineHealth)
    case degraded(EngineHealth)
    case failed(String)
}

/// Owns the Engine Session for the running app.
@MainActor
@Observable
public final class EngineSessionModel {
    public private(set) var status: EngineStatus = .starting

    /// True once the engine answered a healthy `/v1/health`.
    public var isReady: Bool {
        if case .ready = status { return true }
        return false
    }

    /// Projects are only reachable once the engine session exists.
    public let projects = ProjectsModel()

    private let supervisor: EngineSupervisor
    private var client: EngineClient?

    public init(resources: EngineResources) {
        self.supervisor = EngineSupervisor(resources: resources)
    }

    public func start() async {
        status = .starting
        do {
            let session = try await supervisor.start()
            let client = EngineClient(session: session)
            self.client = client
            projects.attach(client: client)
            await refresh()
            await projects.refresh()
        } catch {
            status = .failed(
                (error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
        }
    }

    public func refresh() async {
        guard let client else { return }
        do {
            let health = try await client.health()
            status = health.isReady ? .ready(health) : .degraded(health)
        } catch {
            status = .failed(
                (error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
        }
    }

    public func shutdown() async {
        await supervisor.stop()
    }
}
