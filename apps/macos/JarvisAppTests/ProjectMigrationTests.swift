import Foundation
import HTTPTypes
import JarvisAPI
import OpenAPIRuntime
import XCTest

@testable import JarvisCore

final class ProjectMigrationTests: XCTestCase {
    @MainActor
    func testFixedSavedConfigurationDoesNotRequestMigrationPreview() throws {
        let fixed = try configuration(compositionMode: "fixed-modules")
        let legacy = try configuration(compositionMode: nil)

        XCTAssertFalse(ProjectConfigurationModel.shouldPreviewMigration(fixed))
        XCTAssertTrue(ProjectConfigurationModel.shouldPreviewMigration(legacy))
        XCTAssertFalse(ProjectConfigurationModel.shouldPreviewMigration(nil))
    }

    func testTypedEngineClientPreservesTheExplicitPlanAndReasons() async throws {
        let json = """
        {
          "apiVersion":"jarvis.dev/project-guided-migration/v1",
          "kind":"ProjectGuidedMigrationPreview",
          "projectId":"project",
          "classification":"engine-only",
          "canApply":true,
          "compositionFingerprint":"\(String(repeating: "a", count: 64))",
          "reasons":[],
          "plan":{
            "preserved":{"name":"Project","history":"kept"},
            "removedModule":"jarvis.module.automation-rules",
            "destination":{
              "modules":["jarvis.module.github","jarvis.module.development","jarvis.module.pull-request"],
              "compositionMode":"fixed-modules",
              "readyLabel":"ready-to-dev",
              "scope":{"kind":"issue","workItemRef":"github://owner/repo/issues/7"}
            }
          }
        }
        """
        let client = EngineClient(
            serverURL: URL(string: "http://127.0.0.1:1")!,
            transport: CannedTransport(body: HTTPBody(Array(json.utf8))))
        let preview = try await client.previewGuidedMigration(projectId: "project")

        XCTAssertTrue(preview.canApply)
        XCTAssertEqual(preview.plan?.readyLabel, "ready-to-dev")
        XCTAssertEqual(preview.plan?.scope, "Essai limité à #7")
        XCTAssertTrue(preview.destinationSummary.contains("automation-rules"))
        XCTAssertFalse(ProjectMigrationState.current(preview).requiresMigration)
    }

    func testMigrationPreviewIdentifiesPauseBlockers() throws {
        let json = """
        {
          "apiVersion":"jarvis.dev/project-guided-migration/v1",
          "kind":"ProjectGuidedMigrationPreview",
          "projectId":"project",
          "classification":"engine-only",
          "canApply":false,
          "compositionFingerprint":"fingerprint",
          "reasons":[
            {"code":"project-active","message":"Project is active"},
            {"code":"work-pending","message":"Work is pending"}
          ]
        }
        """
        let preview = ProjectMigrationPreview(try JSONDecoder().decode(
            Components.Schemas.ProjectGuidedMigrationPreview.self,
            from: Data(json.utf8)))

        XCTAssertTrue(preview.requiresPauseBeforeMigration)
    }

    func testTypedEngineClientDecodesMigrationApplyBackup() async throws {
        let client = EngineClient(
            serverURL: URL(string: "http://127.0.0.1:1")!,
            transport: CannedTransport(body: HTTPBody(Array("""
            {
              "apiVersion":"jarvis.dev/project-guided-migration/v1",
              "kind":"ProjectGuidedMigrationResult",
              "projectId":"project",
              "applied":true,
              "appliedAt":"2026-09-14T10:00:00.000Z",
              "historyId":"migration-1",
              "configuration":{},
              "backup":{"portableConfig":{"modules":[]}}
            }
            """.utf8))))

        let result = try await client.applyGuidedMigration(
            projectId: "project",
            compositionFingerprint: String(repeating: "a", count: 64),
            writeToRepository: false)

        XCTAssertTrue(result.applied)
        XCTAssertEqual(result.historyId, "migration-1")
        XCTAssertTrue(result.hasBackup)
    }

    private func configuration(compositionMode: String?) throws
        -> Components.Schemas.PortableProjectConfiguration
    {
        var document: [String: Any] = [
            "apiVersion": "jarvis.dev/project/v1",
            "kind": "Project",
            "metadata": ["id": "migration-test", "name": "Migration Test"],
            "repositories": [["id": "main", "root": "."]],
            "slots": [:],
            "modules": [[
                "instanceId": "legacy",
                "moduleId": "jarvis.module.automation-rules",
                "enabled": true,
                "bindings": [:],
                "configuration": [:],
            ]],
        ]
        if let compositionMode { document["compositionMode"] = compositionMode }
        let data = try JSONSerialization.data(withJSONObject: document)
        return try JSONDecoder().decode(
            Components.Schemas.PortableProjectConfiguration.self,
            from: data)
    }
}

private struct CannedTransport: ClientTransport {
    let body: HTTPBody

    func send(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String
    ) async throws -> (HTTPResponse, HTTPBody?) {
        (
            HTTPResponse(
                status: .ok,
                headerFields: [HTTPField.Name("Content-Type")!: "application/json"]),
            self.body
        )
    }
}
