import XCTest

@testable import JarvisCore

final class EngineResourcesTests: XCTestCase {
    @MainActor
    func testExplicitDataRootAndMalformedOverridesNeverFallBackToUserData() async throws {
        XCTAssertNil(try EngineSessionModel.requestedDataRoot(arguments: ["Jarvis"]).get())
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("jarvis-launch-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        XCTAssertEqual(try EngineSessionModel.requestedDataRoot(arguments: ["Jarvis", "--data-root", root.path()]).get(), root)
        for arguments in [["Jarvis", "--data-root"], ["Jarvis", "--data-root", "relative"],
                          ["Jarvis", "--data-root", root.path(), "--data-root", root.path()],
                          ["Jarvis", "--data-root="]] {
            guard case .failure(let error) = EngineSessionModel.requestedDataRoot(arguments: arguments) else {
                return XCTFail("a malformed override must not select the real data root")
            }
            let session = EngineSessionModel.bundled(dataRoot: root, startupError: error)
            await session.start()
            guard case .failed = session.state else { return XCTFail("the Engine must not start") }
            XCTAssertNil(session.client)
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.path()))
        }
        let session = EngineSessionModel.bundled(dataRoot: root)
        await session.start()
        guard case .ready = session.state else { return XCTFail("the isolated Engine must start") }
        let projects = try await session.client?.listProjects()
        XCTAssertEqual(projects, [])
        await session.shutdown()
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.path()))
    }

    func testAnAppBundleNeverFallsBackToTheBuildMachinesTree() throws {
        // `pnpm build:app` builds debug, so `#if DEBUG` left the #filePath
        // fallback live inside the only app artifact the repo produces. A
        // bundle missing its engine would then run — or name — a directory on
        // whichever machine built it.
        let appPath = FileManager.default.temporaryDirectory
            .appendingPathComponent("Fixture-\(UUID().uuidString).app")
        try FileManager.default.createDirectory(
            at: appPath.appending(path: "Contents/Resources"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: appPath) }

        let bundle = try XCTUnwrap(Bundle(path: appPath.path(percentEncoded: false)))
        let resources = EngineResources.developmentFallback(bundle: bundle)

        let path = resources.bundle.path(percentEncoded: false)
        XCTAssertFalse(
            path.contains("/dist/engine"),
            "an app bundle must not fall back to the repository tree, got: \(path)")
        XCTAssertFalse(path.contains(NSHomeDirectory()), "the path leaks a home directory: \(path)")
    }

    func testOutsideABundleTheRepositoryBuildIsUsed() {
        // `swift run Jarvis` and the test seam: Bundle.main is a plain
        // directory, so the repository's dist/engine is the right answer.
        let resources = EngineResources.developmentFallback()

        XCTAssertTrue(
            resources.bundle.path(percentEncoded: false).hasSuffix("dist/engine/engine.bundle.mjs"),
            "expected the repository build, got: \(resources.bundle.path(percentEncoded: false))")
    }
}
