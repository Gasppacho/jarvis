import Foundation
import Testing

@testable import JarvisCore

/// Locates the repository checkout from the test bundle location.
private func repositoryRoot() -> URL {
    var url = URL(filePath: #filePath)
    while url.path != "/" {
        url.deleteLastPathComponent()
        if FileManager.default.fileExists(atPath: url.appending(path: "pnpm-workspace.yaml").path) {
            return url
        }
    }
    fatalError("could not locate the repository root from \(#filePath)")
}

private func developmentResources() -> EngineResources {
    EngineResources.inDevelopmentTree(repositoryRoot: repositoryRoot())
}

private func temporaryDataRoot() -> URL {
    let url = FileManager.default.temporaryDirectory
        .appending(path: "jarvis-swift-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

@Suite("Engine supervisor", .serialized)
struct EngineSupervisorTests {

    /// The walking skeleton: SwiftUI shell → child process → loopback HTTP →
    /// TypeScript engine → SQLite, using the generated OpenAPI client.
    @Test("launches the embedded engine and reads its health")
    func launchesEngineAndReadsHealth() async throws {
        let resources = developmentResources()
        try #require(
            resources.isPresent,
            "run `pnpm build:engine` before the Swift tests")

        let supervisor = EngineSupervisor(resources: resources)
        let dataRoot = temporaryDataRoot()
        defer { try? FileManager.default.removeItem(at: dataRoot) }

        let session = try await supervisor.start(dataRoot: dataRoot)

        #expect(session.baseURL.absoluteString.hasPrefix("http://127.0.0.1:"))
        #expect(session.apiVersion == "v1")
        #expect(!session.token.isEmpty)

        let health = try await EngineClient(session: session).health()
        #expect(health.status == "ready")
        #expect(health.database == "ready")
        #expect(health.apiVersion == "v1")
        #expect(!health.engineVersion.isEmpty)
        #expect(health.isReady)

        // The engine writes its database inside the data root it was given.
        let databasePath = dataRoot.appending(path: "jarvis.db").path(percentEncoded: false)
        #expect(FileManager.default.fileExists(atPath: databasePath))

        await supervisor.stop()
        #expect(await supervisor.isRunning == false)
    }

    @Test("issues a distinct session token per launch")
    func issuesDistinctTokens() async throws {
        let resources = developmentResources()
        try #require(resources.isPresent, "run `pnpm build:engine` before the Swift tests")

        var tokens = Set<String>()
        for _ in 0..<2 {
            let supervisor = EngineSupervisor(resources: resources)
            let dataRoot = temporaryDataRoot()
            defer { try? FileManager.default.removeItem(at: dataRoot) }

            let session = try await supervisor.start(dataRoot: dataRoot)
            tokens.insert(session.token)
            await supervisor.stop()
        }
        #expect(tokens.count == 2)
    }

    @Test("stops the engine when the supervisor stops")
    func stopsEngine() async throws {
        let resources = developmentResources()
        try #require(resources.isPresent, "run `pnpm build:engine` before the Swift tests")

        let supervisor = EngineSupervisor(resources: resources)
        let dataRoot = temporaryDataRoot()
        defer { try? FileManager.default.removeItem(at: dataRoot) }

        _ = try await supervisor.start(dataRoot: dataRoot)
        #expect(await supervisor.isRunning)

        await supervisor.stop()
        #expect(await supervisor.isRunning == false)
    }

    @Test("reports an actionable error when the engine is not installed")
    func reportsMissingEngine() async {
        let missing = EngineResources(
            nodeExecutable: URL(filePath: "/nonexistent/node"),
            engineBundle: URL(filePath: "/nonexistent/engine.bundle.mjs")
        )
        let supervisor = EngineSupervisor(resources: missing)

        await #expect(throws: EngineSupervisorError.self) {
            _ = try await supervisor.start()
        }
    }

    /// Regression: the handshake raced a blocking `read()` against a sleep inside
    /// a task group. A task group awaits all children and a blocking read cannot
    /// be cancelled, so the timeout could never actually fire.
    @Test("times out instead of hanging when the engine never reports ready")
    func timesOutOnSilentEngine() async throws {
        let silent = try makeFakeEngine(script: "while true; do sleep 1; done")
        defer { try? FileManager.default.removeItem(at: silent.directory) }

        let supervisor = EngineSupervisor(resources: silent.resources, handshakeTimeout: .seconds(2))
        let started = ContinuousClock.now

        await #expect(throws: EngineSupervisorError.handshakeTimedOut(seconds: 2)) {
            _ = try await supervisor.start()
        }
        #expect(ContinuousClock.now - started < .seconds(15))
        #expect(await supervisor.isRunning == false)
    }

    /// The engine's own startup diagnostics must survive to the user.
    @Test("surfaces the engine's stderr when it dies during startup")
    func surfacesStartupDiagnostics() async throws {
        let failing = try makeFakeEngine(
            script: "echo 'JARVIS_TOKEN is missing' >&2; exit 78")
        defer { try? FileManager.default.removeItem(at: failing.directory) }

        let supervisor = EngineSupervisor(resources: failing.resources)
        do {
            _ = try await supervisor.start()
            Issue.record("expected the supervisor to fail")
        } catch let error as EngineSupervisorError {
            guard case .exitedBeforeReady(let code, let diagnostics) = error else {
                Issue.record("unexpected error: \(error)")
                return
            }
            #expect(code == 78)
            #expect(diagnostics.contains("JARVIS_TOKEN is missing"))
        }
    }

    /// A second start must replace the first engine, never strand it.
    @Test("replaces a running engine instead of leaking it")
    func replacesRunningEngine() async throws {
        let resources = developmentResources()
        try #require(resources.isPresent, "run `pnpm build:engine` before the Swift tests")

        let supervisor = EngineSupervisor(resources: resources)
        let dataRoot = temporaryDataRoot()
        defer { try? FileManager.default.removeItem(at: dataRoot) }

        let first = try await supervisor.start(dataRoot: dataRoot)
        let second = try await supervisor.start(dataRoot: dataRoot)
        #expect(first.baseURL != second.baseURL)

        // The first engine must be gone, not merely forgotten.
        var request = URLRequest(url: first.baseURL.appending(path: "v1/health"))
        request.timeoutInterval = 3
        await #expect(throws: (any Error).self) {
            _ = try await URLSession.shared.data(for: request)
        }

        await supervisor.stop()
        #expect(await supervisor.isRunning == false)
    }

    @Test("rejects an engine speaking a different Local API major")
    func rejectsIncompatibleAPIVersion() async throws {
        let future = try makeFakeEngine(
            script: #"printf '{"type":"ready","port":1,"apiVersion":"v2","sessionId":"s"}\n'; sleep 1"#)
        defer { try? FileManager.default.removeItem(at: future.directory) }

        let supervisor = EngineSupervisor(resources: future.resources)
        await #expect(
            throws: EngineSupervisorError.incompatibleAPIVersion(engine: "v2", shell: "v1")
        ) {
            _ = try await supervisor.start()
        }
    }
}

/// A stand-in engine used to drive supervisor failure paths deterministically.
private struct FakeEngine {
    let directory: URL
    let resources: EngineResources
}

private func makeFakeEngine(script: String) throws -> FakeEngine {
    let directory = FileManager.default.temporaryDirectory
        .appending(path: "jarvis-fake-engine-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    // The supervisor runs `<node> <bundle>`, so a shell that ignores its
    // argument stands in for both.
    let executable = directory.appending(path: "node")
    try "#!/bin/sh\n\(script)\n".write(to: executable, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes(
        [.posixPermissions: 0o755], ofItemAtPath: executable.path(percentEncoded: false))

    let bundle = directory.appending(path: "engine.bundle.mjs")
    try "// stand-in\n".write(to: bundle, atomically: true, encoding: .utf8)

    return FakeEngine(
        directory: directory,
        resources: EngineResources(nodeExecutable: executable, engineBundle: bundle)
    )
}
