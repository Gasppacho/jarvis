import Foundation
import XCTest

@testable import JarvisCore

/// macOS Shell seam: the observable catalogue model drives the real bundled
/// engine through the generated Local API client.
final class ModuleCatalogTests: XCTestCase {
    @MainActor
    func testLoadsTheBundledDevelopmentPackageForPresentation() async throws {
        let dataRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("jarvis-module-catalog-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: dataRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dataRoot) }

        let session = EngineSessionModel(
            supervisor: EngineSupervisor(resources: .developmentBuild(), dataRoot: dataRoot))
        let moduleCatalog = ModuleCatalogModel(session: session)
        await session.start()

        await moduleCatalog.refresh()

        guard case .loaded = moduleCatalog.state else {
            await session.shutdown()
            return XCTFail(
                "the module catalogue was not ready for presentation: \(moduleCatalog.state)")
        }
        let package = try XCTUnwrap(moduleCatalog.packages.first)
        XCTAssertEqual(moduleCatalog.packages.count, 1)
        XCTAssertEqual(package.id, "jarvis.module.development@1.0.0")
        XCTAssertEqual(package.moduleId, "jarvis.module.development")
        XCTAssertEqual(package.version, "1.0.0")
        XCTAssertEqual(package.displayName, "Development")
        XCTAssertEqual(package.categories, ["agentic"])
        XCTAssertEqual(package.consumes, ["development.implementation.requested.v1"])
        XCTAssertEqual(package.produces.count, 3)
        XCTAssertEqual(package.requires.count, 7)
        XCTAssertEqual(
            package.configurationSchemaRef,
            "contracts/module-config/development.v1.schema.json")
        XCTAssertTrue(
            package.configurationSchema?.contains("Development Module Config v1") == true)
        XCTAssertEqual(
            package.presentationFields.map(\.label),
            [
                "Module ID",
                "Categories",
                "Consumes",
                "Produces",
                "Requires",
                "Provides",
                "Configuration schema reference",
                "Configuration schema",
            ])
        XCTAssertTrue(
            package.presentationFields.first(where: { $0.label == "Produces" })?.value.contains(
                "scm.change-request.creation-requested.v1") == true)
        XCTAssertTrue(
            package.presentationFields.first(where: { $0.label == "Configuration schema" })?.value
                .contains("Development Module Config v1") == true)

        await session.shutdown()
    }
}
