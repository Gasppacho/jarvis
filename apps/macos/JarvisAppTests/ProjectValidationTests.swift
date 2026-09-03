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
            Set(report.findings.map(\.code.rawValue)),
            Set([
                "project.composition-incomplete",
                "project.binding-missing",
                "project.capability-unresolved",
                "project.contract-incompatible",
                "project.instance-config-invalid",
                "project.module-package-unavailable",
                "project.request-ambiguous",
                "project.request-orphaned",
            ]))
        XCTAssertEqual(
            Set(report.findings.map(\.target.kind)),
            Set([.project, .requestEdge, .contractEdge, .moduleInstance, .slot, .capability]))
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

    func testStepFivePresentsInvalidFindingsInStableContractOrderWithActionableCopy() throws {
        let project = Project(
            id: "validation-fixture",
            name: "Validation Fixture",
            status: .draft,
            moduleCount: 2,
            activeExecutions: nil)
        var state = ProjectConfigurationState()
        state.validation = .invalid(try decodeReport(fixture(valid: false, includesFindings: true)))

        let presentation = ProjectDetailPresentation(
            project: project, detail: nil, state: state, packages: [])

        XCTAssertEqual(presentation.validation.status, .invalid)
        XCTAssertEqual(presentation.validation.title, "Project validation needs attention")
        XCTAssertEqual(
            presentation.validation.findings.map(\.code),
            [
                "project.binding-missing",
                "project.capability-unresolved",
                "project.capability-unresolved",
                "project.composition-incomplete",
                "project.contract-incompatible",
                "project.instance-config-invalid",
                "project.module-package-unavailable",
                "project.request-ambiguous",
                "project.request-orphaned",
            ])
        XCTAssertEqual(
            Set(presentation.validation.findings.map(\.targetKind)),
            Set([.project, .requestEdge, .contractEdge, .moduleInstance, .slot, .capability]))
        XCTAssertTrue(
            presentation.validation.findings.contains {
                $0.reference.contains("work.requested.v1.request")
                    && $0.reference.contains("producer/rules")
                    && $0.reference.contains("candidates/one,two")
            })
        XCTAssertTrue(
            presentation.validation.findings.contains {
                $0.reference.contains("producer/rules/work.requested.v1.request")
                    && $0.reference.contains("consumer/development/work.requested.v2.request")
            })
        let references = Set(presentation.validation.findings.map(\.reference))
        XCTAssertTrue(
            references.contains("request-edge/deploy.requested.v1.request/producer/automation/candidates/none"))
        XCTAssertTrue(references.contains("module-instance/development/field/configuration"))
        XCTAssertTrue(references.contains("module-instance/missing/field/moduleId"))
        XCTAssertTrue(references.contains("slot/sourceControl"))
        XCTAssertTrue(
            references.contains(
                "capability/repository.write/module-instance/development/binding/repository"))
        XCTAssertTrue(references.contains("capability/work-items.read/slot/tickets"))
        XCTAssertTrue(references.contains("project/field/modules"))
        XCTAssertTrue(
            presentation.validation.findings.allSatisfy {
                $0.unavailable.contains("unavailable")
                    && $0.impact.contains("behaviour")
                    && !$0.correctiveAction.isEmpty
                    && $0.accessibilityLabel.contains($0.reference)
            })
    }

    func testStepFiveDerivesActivationReadinessFromOnlyTheCurrentValidReport() throws {
        let selectedProject = Project(
            id: "validation-fixture",
            name: "Validation Fixture",
            status: .draft,
            moduleCount: 2,
            activeExecutions: nil)
        let validReport = try decodeReport(fixture(valid: true))
        let invalidReport = try decodeReport(fixture(valid: false, includesFindings: true))
        let states: [(ProjectValidationState, Bool, String)] = [
            (.unvalidated, false, "Validation is required"),
            (.validating, false, "Validation is still running"),
            (.stale(validReport), false, "Validation is stale"),
            (.failed("Local API unavailable"), false, "Validation failed"),
            (.invalid(invalidReport), false, "Project is invalid"),
            (.valid(validReport), true, "Ready to activate"),
        ]

        for (validation, expectedReadiness, expectedExplanation) in states {
            var state = ProjectConfigurationState()
            state.validation = validation
            let presentation = ProjectDetailPresentation(
                project: selectedProject, detail: nil, state: state, packages: [])

            XCTAssertEqual(presentation.validation.isReadyToActivate, expectedReadiness)
            XCTAssertTrue(
                presentation.validation.activationReadinessExplanation.contains(expectedExplanation),
                "unexpected explanation for \(validation)")
        }

        var mismatchedState = ProjectConfigurationState()
        mismatchedState.validation = .valid(
            try decodeReport(
                fixture(valid: true).replacingOccurrences(
                    of: "validation-fixture", with: "another-project")))
        let mismatchedPresentation = ProjectDetailPresentation(
            project: selectedProject, detail: nil, state: mismatchedState, packages: [])
        XCTAssertFalse(mismatchedPresentation.validation.isReadyToActivate)
        XCTAssertTrue(
            mismatchedPresentation.validation.activationReadinessExplanation.contains(
                "selected Project"))

        let callableOperations = Set(
            mismatchedPresentation.actions.compactMap { action -> String? in
                guard case .asynchronous(let asynchronous) = action else { return nil }
                switch asynchronous.operation {
                case .setLocalBinding: return "set-local-binding"
                case .saveLocal: return "save-local"
                case .saveRepository: return "save-repository"
                case .validate: return "validate"
                case .confirmProjectDeletion: return "confirm-project-deletion"
                }
            })
        XCTAssertEqual(
            callableOperations,
            ["save-local", "save-repository", "validate", "confirm-project-deletion"],
            "step 5 must expose readiness without adding a callable activation request")
    }

    @MainActor
    func testActionableValidationErrorRetriesAndTransitionsToInvalidReport() async throws {
        let report = try decodeReport(fixture(valid: false, includesFindings: true))
        let sequence = ValidationSequence(report: report)
        let session = EngineSessionModel(supervisor: EngineSupervisor(resources: .developmentBuild()))
        let projects = ProjectsModel(session: session)
        let configuration = ProjectConfigurationModel(
            session: session,
            projects: projects,
            validationReportProvider: { _ in try await sequence.load() })

        await configuration.validate(projectId: "validation-fixture")

        guard case .failed(let message) = configuration.state(for: "validation-fixture").validation
        else { return XCTFail("a Local API failure must not look invalid or unvalidated") }
        XCTAssertTrue(message.contains("Validation report is unavailable"))
        XCTAssertTrue(message.contains("readiness cannot be determined"))
        XCTAssertTrue(message.contains("Retry validation"))
        XCTAssertNil(configuration.state(for: "validation-fixture").errorMessage)
        let failedPresentation = ProjectDetailPresentation(
            project: Project(
                id: "validation-fixture",
                name: "Validation Fixture",
                status: .draft,
                moduleCount: 2,
                activeExecutions: nil),
            detail: nil,
            state: configuration.state(for: "validation-fixture"),
            packages: [])
        XCTAssertEqual(failedPresentation.validation.status, .failed)
        XCTAssertEqual(failedPresentation.validation.title, "Validation report unavailable")
        XCTAssertEqual(failedPresentation.validation.errorMessage, message)
        XCTAssertTrue(failedPresentation.actions.contains(.asynchronous(.validate)))

        await configuration.validate(projectId: "validation-fixture")

        XCTAssertEqual(
            configuration.state(for: "validation-fixture").validation,
            .invalid(report))
        let attempts = await sequence.attemptCount()
        XCTAssertEqual(attempts, 2)
    }

    @MainActor
    func testValidationResponseForAnotherProjectCannotBecomeCurrent() async throws {
        let report = try decodeReport(fixture(valid: true))
        let session = EngineSessionModel(supervisor: EngineSupervisor(resources: .developmentBuild()))
        let projects = ProjectsModel(session: session)
        let configuration = ProjectConfigurationModel(
            session: session,
            projects: projects,
            validationReportProvider: { _ in report })

        await configuration.validate(projectId: "new-selection")

        guard case .failed(let message) = configuration.state(for: "new-selection").validation
        else { return XCTFail("a response for another Project must not become current") }
        XCTAssertTrue(message.contains("different Project"))
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
          {"code":"project.request-orphaned","severity":"error","message":"orphaned","target":{"kind":"request-edge","contract":{"type":"deploy.requested","version":1,"kind":"request"},"producer":{"instanceId":"automation","moduleId":"jarvis.module.automation-rules"}}},
          {"code":"project.module-package-unavailable","severity":"error","message":"package","target":{"kind":"module-instance","instanceId":"missing","field":"/moduleId"}},
          {"code":"project.capability-unresolved","severity":"error","message":"module capability","target":{"kind":"capability","capability":"repository.write","instanceId":"development","binding":"repository"}},
          {"code":"project.binding-missing","severity":"error","message":"binding","target":{"kind":"slot","slot":"sourceControl"}},
          {"code":"project.composition-incomplete","severity":"error","message":"composition","target":{"kind":"project","field":"/modules"}},
          {"code":"project.request-ambiguous","severity":"error","message":"ambiguous","target":{"kind":"request-edge","contract":{"type":"work.requested","version":1,"kind":"request"},"producer":{"instanceId":"rules","moduleId":"jarvis.module.automation-rules"},"candidates":[{"instanceId":"two","moduleId":"jarvis.module.development"},{"instanceId":"one","moduleId":"jarvis.module.development"}]}},
          {"code":"project.instance-config-invalid","severity":"error","message":"config","target":{"kind":"module-instance","instanceId":"development","field":"/configuration"}},
          {"code":"project.contract-incompatible","severity":"error","message":"contract","target":{"kind":"contract-edge","producer":{"instanceId":"rules","moduleId":"jarvis.module.automation-rules","contract":{"type":"work.requested","version":1,"kind":"request"}},"consumer":{"instanceId":"development","moduleId":"jarvis.module.development","contract":{"type":"work.requested","version":2,"kind":"request"}}}},
          {"code":"project.capability-unresolved","severity":"error","message":"slot capability","target":{"kind":"capability","capability":"work-items.read","slot":"tickets"}}
        ]
        """
}

private actor ValidationSequence {
    let report: ProjectValidationReport
    var attempts = 0

    init(report: ProjectValidationReport) {
        self.report = report
    }

    func load() throws -> ProjectValidationReport {
        attempts += 1
        if attempts == 1 {
            throw EngineClientError.unexpectedResponse(
                "POST /v1/projects/validation-fixture/validation-report returned 503")
        }
        return report
    }

    func attemptCount() -> Int { attempts }
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
