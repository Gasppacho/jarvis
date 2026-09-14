import Foundation
import HTTPTypes
import JarvisAPI
import OpenAPIRuntime
import XCTest

@testable import JarvisCore

final class ProjectMigrationTests: XCTestCase {
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
              "modules":["jarvis.module.github","jarvis.module.development"],
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
