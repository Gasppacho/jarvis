import XCTest

@testable import JarvisCore

/// TESTING.md macOS seam: the real engine bundle, driven through the generated
/// client. No HTTP fake — this test exists to prove the Swift → process → HTTP
/// → TypeScript traversal actually works.
/// A lock-guarded slot: the polling loop and the task write and read it from
/// different isolation domains.
final class OutcomeBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: String?

    var value: String? { lock.withLock { stored } }
    func set(_ newValue: String) { lock.withLock { stored = newValue } }
}

final class EngineSupervisorTests: XCTestCase {
    private var supervisor: EngineSupervisor!
    private var dataRoot: URL!

    override func setUp() async throws {
        dataRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("jarvis-supervisor-\(UUID().uuidString)")
        supervisor = EngineSupervisor(resources: .developmentBuild(), dataRoot: dataRoot)
    }

    override func tearDown() async throws {
        await supervisor?.terminate()
        if let dataRoot { try? FileManager.default.removeItem(at: dataRoot) }
    }

    func testStartingTheEngineReportsItsHealth() async throws {
        let session = try await supervisor.start()

        XCTAssertGreaterThan(session.port, 0)
        XCTAssertEqual(session.apiVersion, "v1")
        XCTAssertFalse(session.sessionId.isEmpty)

        let health = try await session.client.health()

        XCTAssertEqual(health.status, .ready)
        XCTAssertEqual(health.apiVersion, "v1")
        XCTAssertEqual(health.database, .ready)
        XCTAssertFalse(health.engineVersion.isEmpty)
    }

    func testEachSessionMintsItsOwnToken() async throws {
        let first = try await supervisor.start()
        let second = EngineSupervisor(
            resources: .developmentBuild(),
            dataRoot: FileManager.default.temporaryDirectory
                .appendingPathComponent("jarvis-supervisor-\(UUID().uuidString)")
        )
        let other = try await second.start()

        // A shared token would let one session drive the other's engine.
        XCTAssertNotEqual(first.token, other.token)
        XCTAssertGreaterThanOrEqual(first.token.count, 43)

        await second.terminate()
    }

    func testShutdownFollowsTheProtocolAndLeavesNoProcess() async throws {
        let session = try await supervisor.start()

        try await session.client.shutdown()
        let exitCode = try await supervisor.waitForExit()

        XCTAssertEqual(exitCode, 0)
        let running = await supervisor.isRunning
        XCTAssertFalse(running)
    }

    func testASilentEngineTimesOutInsteadOfHangingForever() async throws {
        // The engine is alive but never writes its handshake — a hung migration,
        // a stuck listen. Racing the wait against a timeout is only useful if
        // the wait is cancellable; otherwise start() only returns when the
        // process eventually dies, and the UI sits on "Starting the engine…".
        //
        // The engine outlives the test on purpose: a shorter sleep would let a
        // broken implementation pass late instead of failing.
        let script = dataRoot.appendingPathComponent("silent-engine.sh")
        try FileManager.default.createDirectory(at: dataRoot, withIntermediateDirectories: true)
        // `exec`, so SIGTERM reaches the sleep instead of orphaning it as a
        // grandchild of /bin/sh.
        try "exec sleep 300\n".write(to: script, atomically: true, encoding: .utf8)

        let silent = EngineSupervisor(
            resources: EngineResources(
                nodeExecutable: URL(filePath: "/bin/sh"),
                bundle: script
            ),
            dataRoot: dataRoot,
            readyTimeout: .seconds(1)
        )

        // An unstructured Task, polled: a task group would wait for its child,
        // so a hanging start() would hang this test the same way instead of
        // reporting it. The task is abandoned on failure and dies with the
        // test process.
        let result = OutcomeBox()
        let started = ContinuousClock.now
        let attempt = Task {
            do {
                _ = try await silent.start()
                result.set("start() unexpectedly succeeded")
            } catch let error as EngineStartError {
                result.set(error.cause)
            } catch {
                result.set("unexpected error: \(error)")
            }
        }
        while result.value == nil, started.duration(to: .now) < .seconds(10) {
            try await Task.sleep(for: .milliseconds(50))
        }
        let elapsed = started.duration(to: .now)
        attempt.cancel()

        let cause = try XCTUnwrap(result.value, "start() hung instead of timing out")
        XCTAssertTrue(cause.contains("ready"), "expected a readiness timeout, got: \(cause)")
        // The point of the timeout is that it fires on its own schedule, not
        // whenever the process happens to die.
        XCTAssertLessThan(elapsed, .seconds(5), "the timeout did not fire on time")

        let running = await silent.isRunning
        XCTAssertFalse(running, "the timeout must also stop the process it gave up on")

        await silent.terminate()
    }

    func testASecondStartReturnsTheRunningEngine() async throws {
        // A WindowGroup gives Cmd-N for free and every window runs `.task`.
        let first = try await supervisor.start()
        let second = try await supervisor.start()

        XCTAssertEqual(first.port, second.port)
        XCTAssertEqual(first.token, second.token)
    }

    func testConcurrentStartsShareOneEngine() async throws {
        // An actor suspends at every `await`, so two callers arriving while the
        // first is still handshaking both passed the stored-session check and
        // each launched an engine — the first becoming untrackable.
        let engine = supervisor!
        let sessions = try await withThrowingTaskGroup(of: EngineSession.self) { group in
            for _ in 0..<3 {
                group.addTask { try await engine.start() }
            }
            var collected: [EngineSession] = []
            for try await session in group { collected.append(session) }
            return collected
        }

        XCTAssertEqual(Set(sessions.map(\.port)).count, 1, "each start launched its own engine")
        XCTAssertEqual(Set(sessions.map(\.token)).count, 1)

        // A second engine would still be running against the same data root.
        let health = try await sessions[0].client.health()
        XCTAssertEqual(health.status, .ready)
    }

    func testAnEngineThatRefusesToStartSurfacesItsOwnDiagnostic() async throws {
        // A real engine failure, not a fake one: the data root is a symlink,
        // which the engine refuses by design. The UI says "check the details
        // below", so the engine's stderr has to actually arrive — it is written
        // just before the process exits, and it is drained on another queue.
        let real = FileManager.default.temporaryDirectory
            .appendingPathComponent("jarvis-real-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
        let link = FileManager.default.temporaryDirectory
            .appendingPathComponent("jarvis-link-\(UUID().uuidString)")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        defer {
            try? FileManager.default.removeItem(at: link)
            try? FileManager.default.removeItem(at: real)
        }

        let refusing = EngineSupervisor(resources: .developmentBuild(), dataRoot: link)

        do {
            _ = try await refusing.start()
            XCTFail("the engine should refuse a symlinked data root")
        } catch let error as EngineStartError {
            let detail = try XCTUnwrap(error.detail, "the engine's stderr was lost")
            XCTAssertTrue(
                detail.contains("symbolic link"),
                "expected the engine's own diagnostic, got: \(detail)")
        }
    }

    func testAMissingEngineFailsWithAnActionableError() async throws {
        let broken = EngineSupervisor(
            resources: EngineResources(
                nodeExecutable: URL(filePath: "/nonexistent/node"),
                bundle: URL(filePath: "/nonexistent/engine.bundle.mjs")
            ),
            dataRoot: dataRoot
        )

        do {
            _ = try await broken.start()
            XCTFail("starting a missing engine should fail")
        } catch let error as EngineStartError {
            // MACOS_APP.md: cause, impact and next action — never a blank screen.
            // The cause must name the file, otherwise the message is no more
            // useful than the raw launch failure it is meant to improve on.
            XCTAssertTrue(
                error.cause.contains("/nonexistent/node"),
                "cause should name the missing file, got: \(error.cause)")
            XCTAssertFalse(error.impact.isEmpty)
            XCTAssertFalse(error.nextAction.isEmpty)
        }
    }
}
