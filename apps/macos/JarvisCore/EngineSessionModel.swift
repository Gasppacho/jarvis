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

    /// Reacts to an engine that dies on its own. `refresh()` alone was never
    /// called by anything, so a crash left "Engine ready" and the dead engine's
    /// version numbers on screen for the rest of the session.
    private func observeEngineExit() async {
        await supervisor.onEngineExit { [weak self] status in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.session = nil
                self.state = .failed(
                    EngineStartError(
                        headline: "The engine stopped",
                        cause: "The engine stopped unexpectedly (status \(status)).",
                        impact: "Jarvis cannot reach it, and running work may be lost.",
                        nextAction: "Restart Jarvis."
                    ))
            }
        }
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
        await observeEngineExit()
        do {
            let session = try await supervisor.start()
            self.session = session
            state = Self.state(for: try await session.client.health())
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

    /// A health response only means "ready" when the engine says so. `status`
    /// was decoded and then ignored, so a degraded engine — a failed migration,
    /// for instance — was shown as ready with the failure sitting in the grid
    /// underneath.
    ///
    /// ponytail: read once, at startup. Nothing polls, so an engine that
    /// degrades mid-session is noticed only if it exits. Add polling when a
    /// feature needs it.
    static func state(for health: EngineHealth) -> State {
        guard health.status == .ready else {
            return .failed(
                EngineStartError(
                    headline: "The engine is not healthy",
                    cause: "The engine reports \(health.status.rawValue), with its database \(health.database.rawValue).",
                    impact: "Projects cannot be opened until it recovers.",
                    nextAction: "Restart Jarvis. If this repeats, the local data may be damaged."
                ))
        }
        return .ready(health)
    }

    /// SYSTEM.md shutdown protocol: ask, then terminate after a bounded delay.
    public func shutdown() async {
        // Tell the supervisor the coming exit was asked for, so the clean quit
        // does not flash a crash screen while AppKit finishes terminating.
        await supervisor.expectStop()
        // No session means the handshake never completed: there is nobody to
        // ask, and waiting out the full budget would leave the app
        // unresponsive after the user pressed Quit.
        guard let session else {
            await supervisor.terminate()
            return
        }
        try? await session.client.shutdown()
        // The engine acknowledged and is on loopback: three seconds is generous.
        // The default ten, plus the request timeout and the termination grace,
        // adds up to twenty seconds of an unresponsive Quit.
        _ = try? await supervisor.waitForExit(timeout: .seconds(3))
        await supervisor.terminate()
    }
}
