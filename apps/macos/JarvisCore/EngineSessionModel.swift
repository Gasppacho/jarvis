import Foundation
import Observation

/// What the shell knows about the engine right now. MACOS_APP.md: an AppModel
/// owns engine-session state; the UI derives from it and holds none of its own.
@MainActor
@Observable
public final class EngineSessionModel {
    public enum State: Sendable {
        case starting
        case ready(EngineHealth)
        /// Never a blank screen: the failure carries cause, impact and action.
        case failed(EngineStartError)
    }

    public private(set) var state: State = .starting

    private let supervisor: EngineSupervisor
    private var session: EngineSession?

    public init(supervisor: EngineSupervisor) {
        self.supervisor = supervisor
    }

    /// Convenience for the app: the engine that ships inside this bundle.
    public static func bundled() -> EngineSessionModel {
        // Keyed on where the binary runs, not on how it was compiled. The repo
        // builds dist/Jarvis.app in debug by default, so `#if DEBUG` left the
        // #filePath-derived fallback live inside the only app artifact it
        // produces — which would silently run the build machine's dist/engine,
        // or name its home directory in the failure UI.
        let resources = EngineResources.bundled() ?? EngineResources.developmentFallback()
        return EngineSessionModel(supervisor: EngineSupervisor(resources: resources))
    }

    public func start() async {
        do {
            let session = try await supervisor.start()
            self.session = session
            state = .ready(try await session.client.health())
        } catch let error as EngineStartError {
            state = .failed(error)
        } catch {
            state = .failed(
                EngineStartError(
                    cause: "The engine started but did not answer: \(error.localizedDescription)",
                    impact: "Jarvis cannot show the engine's state.",
                    nextAction: "Restart Jarvis."
                ))
        }
    }

    public func refresh() async {
        guard let session else { return }
        do {
            state = .ready(try await session.client.health())
        } catch {
            // Swallowing this would leave "Engine ready" and stale version
            // numbers on screen for an engine that has crashed.
            state = .failed(
                EngineStartError(
                    cause: "The engine stopped answering: \(error.localizedDescription)",
                    impact: "Jarvis cannot show its state, and running work may be lost.",
                    nextAction: "Restart Jarvis."
                ))
        }
    }

    /// SYSTEM.md shutdown protocol: ask, then terminate after a bounded delay.
    public func shutdown() async {
        // No session means the handshake never completed: there is nobody to
        // ask, and waiting out the full timeout would leave the app
        // unresponsive for fifteen seconds after the user pressed Quit.
        guard let session else {
            await supervisor.terminate()
            return
        }
        try? await session.client.shutdown()
        _ = try? await supervisor.waitForExit()
        await supervisor.terminate()
    }
}
