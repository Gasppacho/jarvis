import Foundation
import XCTest

@testable import JarvisCore

/// macOS Shell seam: the observable catalogue model drives the real bundled
/// engine through the generated Local API client.
final class ModuleCatalogTests: XCTestCase {
    @MainActor
    func testRefreshRecoversAfterTheEngineBecomesTemporarilyUnavailable() async throws {
        let dataRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("jarvis-module-catalog-retry-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dataRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dataRoot) }

        let session = EngineSessionModel(
            supervisor: EngineSupervisor(resources: .developmentBuild(), dataRoot: dataRoot))
        let moduleCatalog = ModuleCatalogModel(session: session)
        await session.start()
        await moduleCatalog.refresh()
        guard case .loaded = moduleCatalog.state else {
            await session.shutdown()
            return XCTFail("the catalogue did not load before the simulated outage")
        }
        await session.shutdown()

        await moduleCatalog.refresh()
        guard case .failed = moduleCatalog.state else {
            return XCTFail("an unavailable engine must make the catalogue unavailable")
        }
        XCTAssertTrue(moduleCatalog.packages.isEmpty, "stale packages must not remain usable after a failure")
        XCTAssertTrue(moduleCatalog.capabilityGuidance.isEmpty)

        await session.start()
        await moduleCatalog.refresh()
        guard case .loaded = moduleCatalog.state else {
            await session.shutdown()
            return XCTFail("retry did not reload the catalogue: \(moduleCatalog.state)")
        }
        XCTAssertFalse(moduleCatalog.packages.isEmpty)
        await session.shutdown()
    }

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
                "jarvis.module.change-request-review@1.0.0",
                "jarvis.module.development@1.0.0",
                "jarvis.module.github@1.0.0",
                "jarvis.module.pull-request@1.0.0",
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
        XCTAssertEqual(review.requires, [ModuleCapabilityRequirement(id: "agent.execute", binding: "agentRuntime")])
        XCTAssertEqual(review.requiredCapabilityIDs, ["agent.execute"])
        XCTAssertEqual(review.declaredBindingNames, ["agentRuntime"])
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
        XCTAssertEqual(
            development.consumes,
            ["scm.work-item.observed.v1", "development.implementation.requested.v1"])
        XCTAssertEqual(
            development.produces,
            [
                "development.implementation.requested.v1",
                "development.implementation.completed.v1",
                "development.implementation.failed.v1",
            ])
        XCTAssertEqual(
            development.requires,
            [
                ModuleCapabilityRequirement(id: "repository.write", binding: "repository"),
                ModuleCapabilityRequirement(id: "git.branch", binding: "repository"),
                ModuleCapabilityRequirement(id: "git.commit", binding: "repository"),
                ModuleCapabilityRequirement(id: "git.push", binding: "repository"),
                ModuleCapabilityRequirement(id: "shell.execute"),
                ModuleCapabilityRequirement(id: "work-items.read", binding: "tickets"),
                ModuleCapabilityRequirement(id: "agent.execute", binding: "agentRuntime"),
            ])
        XCTAssertEqual(
            development.requiredCapabilityIDs,
            [
                "repository.write", "git.branch", "git.commit", "git.push", "shell.execute",
                "work-items.read", "agent.execute",
            ])
        XCTAssertEqual(
            development.declaredBindingNames,
            ["agentRuntime", "repository", "tickets"].sorted())
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
        XCTAssertEqual(
            github.consumes,
            [
                "scm.change-request.creation-requested.v1",
                "scm.work-item.tags-change-requested.v1",
            ])
        XCTAssertEqual(
            github.produces,
            [
                "scm.work-item.ready.v1", "scm.work-item.observed.v1", "scm.work-item.tag-added.v1", "scm.change-request.created.v1",
                "scm.change-request.creation-failed.v1", "scm.work-item.tags-changed.v1",
                "scm.work-item.tags-change-failed.v1",
            ])
        XCTAssertEqual(github.requires, [ModuleCapabilityRequirement(id: "github.api", binding: "sourceControl")])
        XCTAssertEqual(github.requiredCapabilityIDs, ["github.api"])
        XCTAssertEqual(github.declaredBindingNames, ["sourceControl"])
        XCTAssertEqual(github.provides, ["scm.change-request.manage", "work-items.read"])
        XCTAssertEqual(
            github.configurationSchemaRef,
            "contracts/module-config/github.v1.schema.json")
        XCTAssertTrue(github.configurationSchema?.contains("GitHub Module Config v1") == true)
        XCTAssertFalse(github.configurationSchema?.contains("readyLabel") == true)
        XCTAssertTrue(development.configurationSchema?.contains("readyLabel") == true)

        let pullRequest = try XCTUnwrap(
            moduleCatalog.packages.first { $0.moduleId == "jarvis.module.pull-request" })
        XCTAssertEqual(pullRequest.displayName, "Pull Request")
        XCTAssertEqual(pullRequest.consumes, ["development.implementation.completed.v1"])
        XCTAssertEqual(pullRequest.produces, ["scm.change-request.creation-requested.v1"])
        XCTAssertEqual(
            pullRequest.requires,
            [
                ModuleCapabilityRequirement(id: "repository.write", binding: "repository"),
                ModuleCapabilityRequirement(id: "work-items.read", binding: "tickets"),
                ModuleCapabilityRequirement(id: "agent.execute", binding: "agentRuntime"),
            ])

        // Ticket 48: the served, versioned capability meaning matches the
        // documented catalog (docs/contracts/CAPABILITY_CATALOG_V1.md).
        XCTAssertTrue(
            moduleCatalog.capabilityGuidance.contains {
                $0.capabilityId == "repository.write"
                    && $0.meaning == "Modify files inside the leased workspace"
                    && $0.owner == "Workspace"
            })
        XCTAssertTrue(
            moduleCatalog.capabilityGuidance.contains {
                $0.capabilityId == "agent.execute"
                    && $0.meaning == "Start a session on the bound Agent Runtime"
                    && $0.owner == nil
            })
        for requirement in development.requires {
            XCTAssertTrue(
                moduleCatalog.capabilityGuidance.contains { $0.capabilityId == requirement.id },
                "capability \(requirement.id) declared by a bundled Manifest must be served")
        }

        await session.shutdown()
    }
}
