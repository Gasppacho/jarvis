import Foundation

/// coding-standards.md: user-facing errors state cause, impact and next action.
/// The shell shows these verbatim, so a blank screen is never the outcome.
public struct EngineStartError: Error, Sendable, Equatable {
    public let cause: String
    public let impact: String
    public let nextAction: String
    /// Engine stderr, when there was any. Diagnostics, not the headline.
    public let detail: String?

    public init(cause: String, impact: String, nextAction: String, detail: String? = nil) {
        self.cause = cause
        self.impact = impact
        self.nextAction = nextAction
        self.detail = detail
    }

    static func missingResource(_ url: URL) -> EngineStartError {
        EngineStartError(
            cause: "The embedded engine is missing: \(url.path(percentEncoded: false))",
            impact: "Jarvis cannot start without it.",
            nextAction: "Run `pnpm build:app` for a development build, or reinstall Jarvis."
        )
    }

    static func exitedBeforeReady(code: Int32, killedBySignal: Bool, stderr: String)
        -> EngineStartError
    {
        EngineStartError(
            cause: killedBySignal
                ? "The engine was killed by signal \(code) before reporting that it was ready."
                : "The engine exited with code \(code) before reporting that it was ready.",
            impact: "No project can be opened until the engine starts.",
            nextAction: "Check the details below, then restart Jarvis.",
            detail: stderr.isEmpty ? nil : stderr
        )
    }

    static func timedOut(_ timeout: Duration, stderr: String) -> EngineStartError {
        EngineStartError(
            cause: "The engine did not report that it was ready within \(timeout).",
            impact: "Jarvis stopped waiting and shut it down.",
            nextAction: "Restart Jarvis. If this repeats, check the details below.",
            detail: stderr.isEmpty ? nil : stderr
        )
    }

    static func malformedHandshake(_ line: String) -> EngineStartError {
        EngineStartError(
            cause: "The engine's first output was not a valid ready handshake.",
            impact: "Jarvis cannot tell which port to talk to.",
            nextAction: "Restart Jarvis; if this repeats, the installation is damaged.",
            detail: line
        )
    }
}
