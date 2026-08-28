import Foundation
import Security

/// One authenticated lifetime shared by a shell launch and one engine process.
public struct EngineSession: Sendable {
    public let baseURL: URL
    public let token: String
    public let sessionId: String
    public let apiVersion: String
}

/// Failures the user can act on, per docs/agents/coding-standards.md:
/// every message states cause, impact and next action.
public enum EngineSupervisorError: Error, LocalizedError, Equatable {
    case resourcesMissing(path: String)
    case tokenGenerationFailed(status: Int32)
    case launchFailed(reason: String)
    case handshakeTimedOut(seconds: Int)
    case handshakeInvalid(line: String)
    case incompatibleAPIVersion(engine: String, shell: String)
    case exitedBeforeReady(code: Int32, diagnostics: String)

    public var errorDescription: String? {
        switch self {
        case .resourcesMissing(let path):
            return "The embedded Jarvis engine is missing at \(path). Reinstall Jarvis."
        case .tokenGenerationFailed(let status):
            return
                "Jarvis could not generate a secure session token (Security error \(status)). Quit and reopen Jarvis."
        case .launchFailed(let reason):
            return "The Jarvis engine could not be launched: \(reason)."
        case .handshakeTimedOut(let seconds):
            return
                "The Jarvis engine did not report readiness within \(seconds) seconds. Quit and reopen Jarvis."
        case .handshakeInvalid(let line):
            return "The Jarvis engine reported an unreadable startup message: \(line)."
        case .incompatibleAPIVersion(let engine, let shell):
            return
                "This Jarvis interface speaks Local API \(shell) but the engine speaks \(engine). Reinstall Jarvis."
        case .exitedBeforeReady(let code, let diagnostics):
            let detail = diagnostics.isEmpty ? "" : " \(diagnostics)"
            return "The Jarvis engine stopped during startup (code \(code)).\(detail)"
        }
    }
}

private struct ReadyMessage: Decodable {
    let type: String
    let port: Int
    let apiVersion: String
    let sessionId: String
}

/// Accumulates the engine's stderr so it is never lost, and so a chatty engine
/// can never fill the pipe buffer and block on `write`.
private final class OutputCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = Data()

    func append(_ data: Data) {
        lock.lock()
        defer { lock.unlock() }
        // Startup diagnostics only; cap so a log loop cannot grow without bound.
        guard storage.count < 64 * 1024 else { return }
        storage.append(data)
    }

    var text: String {
        lock.lock()
        defer { lock.unlock() }
        return String(decoding: storage, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Launches, authenticates and stops the embedded engine.
///
/// The supervisor owns the process. It does not route events, run modules or
/// know any module's business rules.
public actor EngineSupervisor {
    /// The only Local API major this build of the shell understands.
    public static let supportedAPIVersion = "v1"

    private let resources: EngineResources
    private let handshakeTimeout: Duration
    private var process: Process?
    private var stdinPipe: Pipe?

    public init(resources: EngineResources, handshakeTimeout: Duration = .seconds(20)) {
        self.resources = resources
        self.handshakeTimeout = handshakeTimeout
    }

    public var isRunning: Bool { process?.isRunning ?? false }

    /// Starts the engine and returns the session once it announces readiness.
    public func start(dataRoot: URL? = nil) async throws -> EngineSession {
        // Never strand a previous engine: a retry must replace it, not race it.
        if process != nil { await stop() }

        guard resources.isPresent else {
            throw EngineSupervisorError.resourcesMissing(
                path: resources.engineBundle.path(percentEncoded: false))
        }

        let token = try Self.makeToken()
        let sessionId = UUID().uuidString

        let process = Process()
        process.executableURL = resources.nodeExecutable
        process.arguments = [resources.engineBundle.path(percentEncoded: false)]

        var environment = ["PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"]
        environment["JARVIS_TOKEN"] = token
        environment["JARVIS_SESSION_ID"] = sessionId
        if let dataRoot {
            environment["JARVIS_DATA_ROOT"] = dataRoot.path(percentEncoded: false)
        }
        process.environment = environment

        let stdout = Pipe()
        let stderr = Pipe()
        // Held open for the session: EOF tells the engine its supervisor died.
        let stdin = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        process.standardInput = stdin

        // Drain stderr continuously, or a full pipe buffer would block the engine.
        let diagnostics = OutputCollector()
        stderr.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            diagnostics.append(data)
        }

        do {
            try process.run()
        } catch {
            throw EngineSupervisorError.launchFailed(reason: error.localizedDescription)
        }

        self.process = process
        self.stdinPipe = stdin

        do {
            let line = try await Self.readReadyLine(
                fileDescriptor: stdout.fileHandleForReading.fileDescriptor,
                timeout: handshakeTimeout
            )
            let ready = try Self.decodeReady(line)

            guard ready.apiVersion == Self.supportedAPIVersion else {
                throw EngineSupervisorError.incompatibleAPIVersion(
                    engine: ready.apiVersion, shell: Self.supportedAPIVersion)
            }
            guard let baseURL = URL(string: "http://127.0.0.1:\(ready.port)") else {
                throw EngineSupervisorError.handshakeInvalid(line: line)
            }
            return EngineSession(
                baseURL: baseURL,
                token: token,
                sessionId: ready.sessionId,
                apiVersion: ready.apiVersion
            )
        } catch {
            let enriched = Self.enrich(error, process: process, diagnostics: diagnostics)
            await stop()
            throw enriched
        }
    }

    /// Closes stdin so the engine drains, then escalates if it lingers.
    public func stop() async {
        guard let process else {
            stdinPipe = nil
            return
        }
        defer {
            self.process = nil
            self.stdinPipe = nil
        }
        guard process.isRunning else { return }

        try? stdinPipe?.fileHandleForWriting.close()
        if await Self.waitWhileRunning(process, for: .seconds(5)) { return }

        process.terminate()
        if await Self.waitWhileRunning(process, for: .seconds(3)) { return }

        kill(process.processIdentifier, SIGKILL)
        await Self.waitForExit(process)
    }

    /// Replaces a generic stream failure with the engine's real exit status.
    private static func enrich(
        _ error: Error, process: Process, diagnostics: OutputCollector
    ) -> Error {
        guard case EngineSupervisorError.exitedBeforeReady = error else { return error }
        process.waitUntilExit()
        return EngineSupervisorError.exitedBeforeReady(
            code: process.terminationStatus, diagnostics: diagnostics.text)
    }

    private static func makeToken() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        // Without this check a failure would silently yield an all-zero token.
        guard status == errSecSuccess else {
            throw EngineSupervisorError.tokenGenerationFailed(status: status)
        }
        return Data(bytes).base64EncodedString()
    }

    private static func decodeReady(_ line: String) throws -> ReadyMessage {
        guard let data = line.data(using: .utf8),
            let ready = try? JSONDecoder().decode(ReadyMessage.self, from: data),
            ready.type == "ready"
        else {
            throw EngineSupervisorError.handshakeInvalid(line: line)
        }
        return ready
    }

    /// Returns true if the process exited within the budget.
    private static func waitWhileRunning(_ process: Process, for budget: Duration) async -> Bool {
        let deadline = ContinuousClock.now + budget
        while process.isRunning && ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(25))
        }
        return !process.isRunning
    }

    private static func waitForExit(_ process: Process) async {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                process.waitUntilExit()
                continuation.resume()
            }
        }
    }

    /// Reads the single JSON handshake line the engine writes to stdout.
    ///
    /// `poll` is used rather than a blocking `read` so the deadline is really
    /// enforced: a blocking read cannot be cancelled, and a task group waits for
    /// all of its children, so racing it against a sleep would hang forever.
    private static func readReadyLine(
        fileDescriptor: Int32, timeout: Duration
    ) async throws -> String {
        let budget =
            Double(timeout.components.seconds) + Double(timeout.components.attoseconds) / 1e18

        return try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<String, Error>) in
            DispatchQueue.global(qos: .userInitiated).async {
                let deadline = Date().addingTimeInterval(budget)
                var buffer = [UInt8]()

                while true {
                    let remaining = deadline.timeIntervalSinceNow
                    if remaining <= 0 {
                        continuation.resume(
                            throwing: EngineSupervisorError.handshakeTimedOut(seconds: Int(budget)))
                        return
                    }

                    var descriptor = pollfd(fd: fileDescriptor, events: Int16(POLLIN), revents: 0)
                    let polled = poll(&descriptor, 1, Int32(min(remaining * 1000, 250)))
                    if polled < 0 {
                        if errno == EINTR { continue }
                        continuation.resume(
                            throwing: EngineSupervisorError.launchFailed(
                                reason: "cannot read the engine's output"))
                        return
                    }
                    if polled == 0 { continue }

                    var byte: UInt8 = 0
                    let count = read(fileDescriptor, &byte, 1)
                    if count < 0 {
                        if errno == EINTR { continue }
                        continuation.resume(
                            throwing: EngineSupervisorError.launchFailed(
                                reason: "cannot read the engine's output"))
                        return
                    }
                    if count == 0 {
                        // Stream closed: start() replaces this with the real status.
                        continuation.resume(
                            throwing: EngineSupervisorError.exitedBeforeReady(
                                code: -1, diagnostics: ""))
                        return
                    }
                    if byte == UInt8(ascii: "\n") {
                        continuation.resume(returning: String(decoding: buffer, as: UTF8.self))
                        return
                    }
                    buffer.append(byte)
                }
            }
        }
    }
}
