import XCTest

@testable import JarvisCore

/// TESTING.md macOS seam: the real engine bundle, driven through the generated
/// client. No HTTP fake — this test exists to prove the Swift → process → HTTP
/// → TypeScript traversal actually works.
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
        defer { Task { await second.terminate() } }
        let other = try await second.start()

        // A shared token would let one session drive the other's engine.
        XCTAssertNotEqual(first.token, other.token)
        XCTAssertGreaterThanOrEqual(first.token.count, 43)
    }

    func testShutdownFollowsTheProtocolAndLeavesNoProcess() async throws {
        let session = try await supervisor.start()

        try await session.client.shutdown()
        let exitCode = try await supervisor.waitForExit()

        XCTAssertEqual(exitCode, 0)
        let running = await supervisor.isRunning
        XCTAssertFalse(running)
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
