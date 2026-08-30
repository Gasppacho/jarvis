import Foundation

/// The ready handshake the engine writes as its single stdout line
/// (docs/architecture/SYSTEM.md, startup protocol step 4).
struct ReadyHandshake: Decodable, Sendable {
    let type: String
    let port: Int
    let apiVersion: String
    let sessionId: String
}

/// A live engine: the port and token to reach it, and a client bound to both.
public struct EngineSession: Sendable {
    public let port: Int
    public let apiVersion: String
    public let sessionId: String
    public let token: String
    public let client: EngineClient
}

/// Starts, watches and stops the embedded engine.
///
/// An actor because the process handle and lifecycle flags are shared mutable
/// state that several SwiftUI tasks touch.
public actor EngineSupervisor {
    private let resources: EngineResources
    private let dataRoot: URL?
    private let readyTimeout: Duration

    private var process: Process?
    private var output: EngineOutput?
    private var session: EngineSession?
    private var startTask: Task<EngineSession, Error>?

    /// Called when a started engine exits on its own. Without it nothing
    /// notices a crash, and the window keeps reporting the dead engine's health.
    private var onUnexpectedExit: (@Sendable (Int32) -> Void)?
    /// Set when the stop was asked for, so a clean quit is not reported as a crash.
    private var stopExpected = false

    private static let terminationGrace: TimeInterval = 5
    /// Shared by both exit-wait loops below, so tuning one cannot silently
    /// diverge from the other.
    private static let pollIntervalMilliseconds: UInt64 = 20

    public init(
        resources: EngineResources,
        dataRoot: URL? = nil,
        readyTimeout: Duration = .seconds(20)
    ) {
        self.resources = resources
        self.dataRoot = dataRoot
        self.readyTimeout = readyTimeout
    }

    public func onEngineExit(_ handler: @escaping @Sendable (Int32) -> Void) {
        onUnexpectedExit = handler
    }

    /// Marks the coming exit as asked for. The shell calls this before sending
    /// `POST /v1/system/shutdown`, which exits the engine cleanly.
    public func expectStop() {
        stopExpected = true
    }

    /// The engine's pid while it runs, for diagnostics and for tests that need
    /// to simulate a crash rather than an orderly stop.
    public var processIdentifier: Int32? {
        guard let process, process.isRunning else { return nil }
        return process.processIdentifier
    }

    public var isRunning: Bool {
        process?.isRunning ?? false
    }

    public func start() async throws -> EngineSession {
        if let session, process?.isRunning == true { return session }
        // An actor suspends at every `await`, so checking a stored session is
        // not enough: a second caller arriving while the first is still
        // handshaking would re-enter and launch a second engine. Callers share
        // the in-flight task instead.
        if let startTask { return try await startTask.value }

        let task = Task { try await performStart() }
        startTask = task
        defer { startTask = nil }
        return try await task.value
    }

    private func performStart() async throws -> EngineSession {
        // The stale check above short-circuits before the in-flight dedup, so a
        // caller arriving mid-restart would otherwise get the dead engine's
        // port and token.
        session = nil
        // Latched by the previous stop. Left set, it disables crash reporting
        // for every engine started afterwards.
        stopExpected = false
        try assertResourcesExist()

        // SYSTEM.md startup protocol step 1: a fresh 256-bit token per session,
        // passed through the environment and never written anywhere.
        let token = Self.mintSessionToken()
        let output = EngineOutput()
        let process = makeProcess(token: token, output: output)

        self.output = output
        self.process = process

        // Before run(): a process that dies immediately can be reaped before a
        // handler assigned afterwards is ever installed, and then nothing would
        // ever unblock the wait below.
        process.terminationHandler = { [weak self] finished in
            output.finish()
            guard let self else { return }
            // Unstructured and unawaited: nothing serializes this against a
            // caller that stops this engine and immediately starts another.
            // The exit is attributed to whichever process object fired it, not
            // to "whatever the supervisor is running now".
            Task { await self.engineExited(process: finished, status: finished.terminationStatus) }
        }

        do {
            try process.run()
        } catch {
            self.process = nil
            self.output = nil
            throw EngineStartError(
                cause: "The engine could not be launched: \(error.localizedDescription)",
                impact: "Jarvis cannot start without it.",
                nextAction: "Run `pnpm build:app` for a development build, or reinstall Jarvis."
            )
        }

        let handshake = try await awaitHandshake(process: process, output: output)
        let session = EngineSession(
            port: handshake.port,
            apiVersion: handshake.apiVersion,
            sessionId: handshake.sessionId,
            token: token,
            client: EngineClient(port: handshake.port, token: token)
        )
        self.session = session
        return session
    }

    /// Terminates the engine. The graceful path is `POST /v1/system/shutdown`;
    /// this is the fallback for a shell that is going away regardless.
    /// Stops the engine, including one whose start is still in flight.
    public func terminate() async {
        stopExpected = true
        // A start still in flight has not assigned `process` yet, so stopping
        // only the known process would let it launch an engine after the app
        // reported a clean shutdown. Cancel it and let it finish first.
        if let startTask {
            startTask.cancel()
            _ = try? await startTask.value
            self.startTask = nil
        }
        await stopProcess()
    }

    /// Stops the process alone. Used from inside `performStart`, where awaiting
    /// the start task would be waiting on ourselves.
    private func stopProcess() async {
        guard let process, process.isRunning else { return }
        process.terminate()
        // SYSTEM.md: after a bounded delay the shell kills the process.
        // Task.sleep, not usleep: this runs on a cooperative-pool thread whose
        // count is the core count, and blocking one for five seconds starves it.
        // The grace period must survive cancellation. Quitting during startup
        // cancels the start task, and this runs inside it: a cancellation-aware
        // wait would collapse to an immediate SIGKILL, killing the engine
        // mid-migration with none of its ordered shutdown.
        await Self.waitUninterruptibly(for: process, upTo: Self.terminationGrace)
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    }

    public func waitForExit(timeout: Duration = .seconds(10)) async throws -> Int32 {
        guard let process else {
            // Not "exited cleanly": there was never a process to exit.
            throw EngineStartError(
                cause: "There is no engine to wait for.",
                impact: "Jarvis never started one, or the launch failed.",
                nextAction: "Restart Jarvis."
            )
        }
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while process.isRunning {
            guard ContinuousClock.now < deadline else {
                throw EngineStartError(
                    cause: "The engine did not exit within \(timeout).",
                    impact: "It may still be running in the background.",
                    nextAction: "Quit Jarvis again, or stop the process manually."
                )
            }
            try await Task.sleep(for: .milliseconds(Self.pollIntervalMilliseconds))
        }
        return process.terminationStatus
    }

    // MARK: - Internals

    /// Uncancellable termination-grace wait, distinct in name from the public
    /// `waitForExit(timeout:)`: the two exist for different callers with
    /// different contracts (cancellable/throwing vs. not), and sharing a name
    /// invites the wrong one to be reached for.
    ///
    /// Polls on a dispatch thread rather than the cooperative pool, and is not
    /// cancellable by design — see the caller.
    private static func waitUninterruptibly(for process: Process, upTo seconds: TimeInterval) async {
        let watched = process
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                let deadline = Date().addingTimeInterval(seconds)
                while watched.isRunning && Date() < deadline { usleep(UInt32(Self.pollIntervalMilliseconds * 1_000)) }
                continuation.resume()
            }
        }
    }

    /// Reported only for an engine that had actually started, and only when
    /// the exiting process is still the one the supervisor is tracking. A stop
    /// followed immediately by a restart can let this fire after `self.process`
    /// has already moved on to a new, healthy engine.
    private func engineExited(process exited: Process, status: Int32) {
        guard exited === process else { return }
        guard session != nil else { return }
        session = nil
        guard !stopExpected else { return }
        onUnexpectedExit?(status)
    }

    /// The readability handler drains stderr on another queue, so the buffer is
    /// usually still empty the instant the termination handler fires — and the
    /// failure UI promises "check the details below".
    ///
    /// ponytail: a short wait rather than reading the descriptor directly.
    /// `readToEnd()` would block the actor until EOF, which never comes if a
    /// grandchild inherited the write end, and would race the handler for the
    /// same fd. Raise the wait, or hand the pipe over wholesale, if diagnostics
    /// ever turn up truncated.
    private func drainStandardError(_ output: EngineOutput) async -> String {
        try? await Task.sleep(for: .milliseconds(100))
        return output.stderrText
    }

    private func assertResourcesExist() throws {
        for url in [resources.nodeExecutable, resources.bundle]
        where !FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) {
            throw EngineStartError.missingResource(url)
        }
    }

    private static func mintSessionToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        // SecRandomCopyBytes would pull in Security for no gain here; this is
        // the same CSPRNG.
        for index in bytes.indices { bytes[index] = UInt8.random(in: .min ... .max) }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func makeProcess(token: String, output: EngineOutput) -> Process {
        let process = Process()
        // MACOS_APP.md: the bundled Node, never the one on PATH.
        process.executableURL = resources.nodeExecutable
        process.arguments = [resources.bundle.path(percentEncoded: false)]

        var environment = ProcessInfo.processInfo.environment
        // The supervisor owns these. Inheriting a developer's exported
        // JARVIS_PORT would pin every engine to one port, so a second session
        // dies on EADDRINUSE before it can hand over its handshake.
        // Every key the supervisor might set is stripped from the inherited
        // environment first, whether or not this call sets it, so an omitted
        // one cannot leak a developer's exported value. JARVIS_LOG_LEVEL is
        // deliberately absent: it is the only verbosity knob, and stripping it
        // would pin the engine to `info` with no way to raise it while
        // diagnosing a start failure.
        let supervisorOwnedKeys = ["JARVIS_PORT", "JARVIS_SESSION_ID", "JARVIS_DATA_ROOT"]
        for key in supervisorOwnedKeys {
            environment.removeValue(forKey: key)
        }
        environment["JARVIS_API_TOKEN"] = token
        if let dataRoot {
            environment["JARVIS_DATA_ROOT"] = dataRoot.path(percentEncoded: false)
        }
        process.environment = environment

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        // Empty data means EOF. Without clearing the handler the dispatch
        // source re-fires it in a tight loop — one pegged core per pipe for the
        // rest of the app's life.
        stdout.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            output.appendStandardOutput(data)
        }
        stderr.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            output.appendStandardError(data)
        }
        return process
    }

    private func awaitHandshake(process: Process, output: EngineOutput) async throws
        -> ReadyHandshake
    {
        let line = await withTaskGroup(of: String?.self) { group in
            group.addTask { await output.firstStandardOutputLine() }
            group.addTask { [readyTimeout] in
                try? await Task.sleep(for: readyTimeout)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }

        guard let line else {
            // Either the engine died first, or nothing arrived in time.
            if !process.isRunning {
                throw EngineStartError.exitedBeforeReady(
                    code: process.terminationStatus,
                    killedBySignal: process.terminationReason == .uncaughtSignal,
                    stderr: await drainStandardError(output))
            }
            await stopProcess()
            throw EngineStartError.timedOut(
                readyTimeout, stderr: await drainStandardError(output))
        }

        guard let data = line.data(using: .utf8),
            let handshake = try? JSONDecoder().decode(ReadyHandshake.self, from: data),
            handshake.type == "ready"
        else {
            await stopProcess()
            throw EngineStartError.malformedHandshake(line)
        }
        return handshake
    }
}
