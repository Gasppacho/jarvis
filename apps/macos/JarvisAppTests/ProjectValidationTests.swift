import Foundation
import JarvisAPI
import XCTest

@testable import JarvisCore

final class ProjectValidationTests: XCTestCase {
    func testDecodesVersionedReportCodesTargetsRoutesAndCapabilitiesWithoutLosingIdentity() throws {
        let report = try decodeReport(fixture(valid: false, includesFindings: true))

        XCTAssertEqual(report.apiVersion, "jarvis.dev/project-validation/v1")
        XCTAssertEqual(report.kind, "ProjectValidationReport")
        XCTAssertEqual(report.projectId, "validation-fixture")
        XCTAssertFalse(report.valid)
        XCTAssertEqual(
            report.findings.map(\.code.rawValue),
            [
                "project.binding-missing",
                "project.capability-unresolved",
                "project.contract-incompatible",
                "project.instance-config-invalid",
                "project.module-package-unavailable",
                "project.request-ambiguous",
                "project.request-orphaned",
            ])
        XCTAssertEqual(
            Set(report.findings.map(\.target.kind)),
            Set([.requestEdge, .contractEdge, .moduleInstance, .slot, .capability]))
        XCTAssertTrue(report.findings.contains { finding in
            guard case .capability(_, .moduleInstance(let instanceId), let binding) = finding.target
            else { return false }
            return instanceId == "development" && binding == "repository"
        })
        XCTAssertTrue(report.findings.contains { finding in
            guard case .capability(_, .slot(let slot), _) = finding.target else { return false }
            return slot == "tickets"
        })

        let route = try XCTUnwrap(report.requestRoutes.first)
        XCTAssertEqual(route.contract.identity, "development.implementation.requested.v1.request")
        XCTAssertEqual(route.producer.instanceId, "automation-rules")
        XCTAssertEqual(route.producer.moduleId, "jarvis.module.automation-rules")
        XCTAssertEqual(route.consumer.instanceId, "development")
        XCTAssertEqual(route.consumer.moduleId, "jarvis.module.development")

        XCTAssertEqual(report.satisfiedCapabilities.count, 2)
        XCTAssertEqual(report.satisfiedCapabilities[0].capability, "work-items.read")
        XCTAssertEqual(report.satisfiedCapabilities[0].target.reference, "slot/tickets")
        XCTAssertEqual(report.satisfiedCapabilities[0].source.reference, "module-instance/github")
        XCTAssertEqual(report.satisfiedCapabilities[1].target.reference, "module-instance/development")
        XCTAssertEqual(report.satisfiedCapabilities[1].source.reference, "repository/repository/main")
    }

    func testGeneratedContractRejectsPlausibleValidationReportConstants() {
        let wrongVersion = fixture(valid: true).replacingOccurrences(
            of: "jarvis.dev/project-validation/v1",
            with: "jarvis.dev/project-validation/v2")
        let wrongKind = fixture(valid: true).replacingOccurrences(
            of: "ProjectValidationReport",
            with: "ValidationReport")

        XCTAssertThrowsError(try decodeReport(wrongVersion))
        XCTAssertThrowsError(try decodeReport(wrongKind))
    }

    func testStepFivePresentsUnvalidatedValidatingAndSuccessfulSummary() throws {
        let project = Project(
            id: "validation-fixture",
            name: "Validation Fixture",
            status: .draft,
            moduleCount: 2,
            activeExecutions: nil)

        var state = ProjectConfigurationState()
        var presentation = ProjectDetailPresentation(
            project: project, detail: nil, state: state, packages: [])
        XCTAssertEqual(presentation.validation.status, .unvalidated)
        XCTAssertEqual(presentation.validation.title, "Not validated")
        XCTAssertTrue(presentation.actions.contains(.asynchronous(.validate)))

        state.validation = .validating
        presentation = ProjectDetailPresentation(
            project: project, detail: nil, state: state, packages: [])
        XCTAssertEqual(presentation.validation.status, .validating)
        XCTAssertEqual(presentation.validation.title, "Validating Project…")

        state.validation = .valid(try decodeReport(fixture(valid: true)))
        presentation = ProjectDetailPresentation(
            project: project, detail: nil, state: state, packages: [])
        XCTAssertEqual(presentation.validation.status, .valid)
        XCTAssertEqual(presentation.validation.title, "Project validation passed")
        XCTAssertEqual(
            presentation.validation.requestRoutes.map(\.contractIdentity),
            ["development.implementation.requested.v1.request"])
        XCTAssertEqual(
            presentation.validation.requestRoutes.map(\.route),
            [
                "automation-rules (jarvis.module.automation-rules) → development (jarvis.module.development)"
            ])
        XCTAssertEqual(
            presentation.validation.satisfiedCapabilities.map(\.detail),
            [
                "slot/tickets ← module-instance/github",
                "module-instance/development ← repository/repository/main",
            ])
    }

    @MainActor
    func testValidationRequestPublishesValidatingBeforeApplyingControlledReport() async throws {
        let report = try decodeReport(fixture(valid: true))
        let gate = ValidationGate(report: report)
        let session = EngineSessionModel(supervisor: EngineSupervisor(resources: .developmentBuild()))
        let projects = ProjectsModel(session: session)
        let configuration = ProjectConfigurationModel(
            session: session,
            projects: projects,
            validationReportProvider: { projectId in
                XCTAssertEqual(projectId, "validation-fixture")
                return try await gate.load()
            })

        let task = Task { await configuration.validate(projectId: "validation-fixture") }
        await Task.yield()
        XCTAssertEqual(configuration.state(for: "validation-fixture").validation, .validating)

        await gate.resume()
        await task.value
        XCTAssertEqual(
            configuration.state(for: "validation-fixture").validation,
            .valid(report))
    }

    private func decodeReport(_ json: String) throws -> ProjectValidationReport {
        let payload = try JSONDecoder().decode(
            Components.Schemas.ProjectValidationReportV1.self,
            from: Data(json.utf8))
        return try ProjectValidationReport(payload: payload)
    }

    private func fixture(valid: Bool, includesFindings: Bool = false) -> String {
        let findings = includesFindings ? Self.findings : "[]"
        return """
            {
              "apiVersion": "jarvis.dev/project-validation/v1",
              "kind": "ProjectValidationReport",
              "projectId": "validation-fixture",
              "valid": \(valid),
              "requestRoutes": [{
                "contract": {"type":"development.implementation.requested","version":1,"kind":"request"},
                "producer": {"instanceId":"automation-rules","moduleId":"jarvis.module.automation-rules"},
                "consumer": {"instanceId":"development","moduleId":"jarvis.module.development"}
              }],
              "satisfiedCapabilities": [
                {"capability":"work-items.read","target":{"kind":"slot","slot":"tickets"},"source":{"kind":"module-instance","ref":"github"}},
                {"capability":"repository.write","target":{"kind":"module-instance","instanceId":"development"},"source":{"kind":"repository","ref":"repository/main"}}
              ],
              "findings": \(findings)
            }
            """
    }

    private static let findings = """
        [
          {"code":"project.binding-missing","severity":"error","message":"binding","target":{"kind":"slot","slot":"sourceControl"}},
          {"code":"project.capability-unresolved","severity":"error","message":"slot capability","target":{"kind":"capability","capability":"work-items.read","slot":"tickets"}},
          {"code":"project.contract-incompatible","severity":"error","message":"contract","target":{"kind":"contract-edge","producer":{"instanceId":"rules","moduleId":"jarvis.module.automation-rules","contract":{"type":"work.requested","version":1,"kind":"request"}},"consumer":{"instanceId":"development","moduleId":"jarvis.module.development","contract":{"type":"work.requested","version":2,"kind":"request"}}}},
          {"code":"project.instance-config-invalid","severity":"error","message":"config","target":{"kind":"module-instance","instanceId":"development","field":"/configuration"}},
          {"code":"project.module-package-unavailable","severity":"error","message":"package","target":{"kind":"module-instance","instanceId":"missing","field":"/moduleId"}},
          {"code":"project.request-ambiguous","severity":"error","message":"ambiguous","target":{"kind":"request-edge","contract":{"type":"work.requested","version":1,"kind":"request"},"producer":{"instanceId":"rules","moduleId":"jarvis.module.automation-rules"},"candidates":[{"instanceId":"one","moduleId":"jarvis.module.development"},{"instanceId":"two","moduleId":"jarvis.module.development"}]}},
          {"code":"project.request-orphaned","severity":"error","message":"module capability","target":{"kind":"capability","capability":"repository.write","instanceId":"development","binding":"repository"}}
        ]
        """
}

private actor ValidationGate {
    let report: ProjectValidationReport
    var continuation: CheckedContinuation<Void, Never>?

    init(report: ProjectValidationReport) {
        self.report = report
    }

    func load() async throws -> ProjectValidationReport {
        await withCheckedContinuation { continuation = $0 }
        return report
    }

    func resume() {
        continuation?.resume()
        continuation = nil
    }
}
