import Foundation
import XCTest

@testable import JarvisCore

/// macOS Shell seam: the observable catalogue model drives the real bundled
/// engine through the generated Local API client.
final class ModuleCatalogTests: XCTestCase {
    @MainActor
    func testLoadsEveryOfficialPackageForPresentation() async throws {
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
        XCTAssertEqual(
            moduleCatalog.packages.map(\.id),
            [
                "jarvis.module.automation-rules@1.0.0",
                "jarvis.module.change-request-review@1.0.0",
                "jarvis.module.development@1.0.0",
                "jarvis.module.github@1.0.0",
            ])

        let expectedLabels = [
            "Module ID",
            "Categories",
            "Consumes",
            "Produces",
            "Requires",
            "Provides",
            "Configuration schema reference",
            "Configuration schema",
        ]
        for package in moduleCatalog.packages {
            XCTAssertEqual(package.presentationFields.map(\.label), expectedLabels)
        }

        let automation = try XCTUnwrap(
            moduleCatalog.packages.first { $0.moduleId == "jarvis.module.automation-rules" })
        XCTAssertEqual(automation.version, "1.0.0")
        XCTAssertEqual(automation.displayName, "Automation Rules")
        XCTAssertEqual(
            automation.description,
            "Translates matching project Facts into targeted Requests.")
        XCTAssertEqual(automation.categories, ["automation"])
        XCTAssertEqual(automation.consumes, ["scm.work-item.tag-added.v1"])
        XCTAssertEqual(automation.produces, ["development.implementation.requested.v1"])
        XCTAssertEqual(automation.requires, [])
        XCTAssertEqual(automation.provides, [])
        XCTAssertEqual(
            automation.configurationSchemaRef,
            "contracts/module-config/automation-rules.v1.schema.json")
        XCTAssertTrue(
            automation.configurationSchema?.contains("Automation Rules Module Config v1") == true)

        let review = try XCTUnwrap(
            moduleCatalog.packages.first { $0.moduleId == "jarvis.module.change-request-review" })
        XCTAssertEqual(review.version, "1.0.0")
        XCTAssertEqual(review.displayName, "Change Request Review")
        XCTAssertEqual(
            review.description,
            "Inspects a created Change Request revision and records a local verdict.")
        XCTAssertEqual(review.categories, ["agentic", "decision"])
        XCTAssertEqual(review.consumes, ["scm.change-request.created.v1"])
        XCTAssertEqual(review.produces, [])
        XCTAssertEqual(review.requires, ["agent.execute"])
        XCTAssertEqual(review.provides, [])
        XCTAssertNil(review.configurationSchemaRef)
        XCTAssertEqual(
            review.presentationFields.first { $0.label == "Configuration schema" }?.value,
            "None")

        let development = try XCTUnwrap(
            moduleCatalog.packages.first { $0.moduleId == "jarvis.module.development" })
        XCTAssertEqual(development.version, "1.0.0")
        XCTAssertEqual(development.displayName, "Development")
        XCTAssertEqual(
            development.description,
            "Implements a requested work item in an isolated Git workspace.")
        XCTAssertEqual(development.categories, ["agentic"])
        XCTAssertEqual(development.consumes, ["development.implementation.requested.v1"])
        XCTAssertEqual(
            development.produces,
            [
                "development.implementation.completed.v1",
                "development.implementation.failed.v1",
                "scm.change-request.creation-requested.v1",
            ])
        XCTAssertEqual(
            development.requires,
            [
                "repository.write", "git.branch", "git.commit", "git.push", "shell.execute",
                "work-items.read", "agent.execute",
            ])
        XCTAssertEqual(development.provides, [])
        XCTAssertEqual(
            development.configurationSchemaRef,
            "contracts/module-config/development.v1.schema.json")
        XCTAssertTrue(
            development.configurationSchema?.contains("Development Module Config v1") == true)

        let github = try XCTUnwrap(
            moduleCatalog.packages.first { $0.moduleId == "jarvis.module.github" })
        XCTAssertEqual(github.version, "1.0.0")
        XCTAssertEqual(github.displayName, "GitHub")
        XCTAssertEqual(
            github.description,
            "Translates GitHub observations and requested SCM actions.")
        XCTAssertEqual(github.categories, ["provider"])
        XCTAssertEqual(github.consumes, ["scm.change-request.creation-requested.v1"])
        XCTAssertEqual(
            github.produces,
            [
                "scm.work-item.tag-added.v1", "scm.change-request.created.v1",
                "scm.change-request.creation-failed.v1",
            ])
        XCTAssertEqual(github.requires, ["github.api"])
        XCTAssertEqual(github.provides, ["scm.change-request.manage", "work-items.read"])
        XCTAssertEqual(
            github.configurationSchemaRef,
            "contracts/module-config/github.v1.schema.json")
        XCTAssertTrue(github.configurationSchema?.contains("GitHub Module Config v1") == true)

        await session.shutdown()
    }
}
