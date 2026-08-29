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
    private var stderrHandle: FileHandle?
    private var startTask: Task<EngineSession, Error>?

    public init(
        resources: EngineResources,
        dataRoot: URL? = nil,
        readyTimeout: Duration = .seconds(20)
    ) {
        self.resources = resources
        self.dataRoot = dataRoot
        self.readyTimeout = readyTimeout
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
        process.terminationHandler = { _ in output.finish() }

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
    public func terminate() async {
        guard let process, process.isRunning else { return }
        process.terminate()
        // SYSTEM.md: after a bounded delay the shell kills the process.
        // Task.sleep, not usleep: this runs on a cooperative-pool thread whose
        // count is the core count, and blocking one for five seconds starves it.
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while process.isRunning && ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(20))
        }
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
            try await Task.sleep(for: .milliseconds(20))
        }
        return process.terminationStatus
    }

    // MARK: - Internals

    /// Reads whatever the exited process left in the pipe. The readability
    /// handler runs on another queue, so the buffer is usually still empty at
    /// the moment the termination handler fires.
    private func drainStandardError(_ output: EngineOutput) -> String {
        if let stderrHandle, let remaining = try? stderrHandle.readToEnd(),
            let text = String(data: remaining, encoding: .utf8)
        {
            output.appendStandardError(text)
        }
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
            if let text = String(data: data, encoding: .utf8) { output.appendStandardOutput(text) }
        }
        stderr.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            if let text = String(data: data, encoding: .utf8) { output.appendStandardError(text) }
        }
        stderrHandle = stderr.fileHandleForReading
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
                    code: process.terminationStatus, stderr: drainStandardError(output))
            }
            await terminate()
            throw EngineStartError.timedOut(
                readyTimeout, stderr: drainStandardError(output))
        }

        guard let data = line.data(using: .utf8),
            let handshake = try? JSONDecoder().decode(ReadyHandshake.self, from: data),
            handshake.type == "ready"
        else {
            await terminate()
            throw EngineStartError.malformedHandshake(line)
        }
        return handshake
    }
}
