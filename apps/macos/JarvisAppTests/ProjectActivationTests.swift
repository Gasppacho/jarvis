import Foundation
import JarvisAPI
import XCTest

@testable import JarvisCore

/// Ticket #55: the Wizard's Activate affordance. #45 already built the
/// readiness signal and its vocabulary (ProjectValidationTests.swift); these
/// tests cover only what #55 adds — a real, callable request that carries the
/// exact displayed report's `compositionFingerprint`, refuses without one,
/// and renders an engine rejection distinctly from a validation finding.
final class ProjectActivationTests: XCTestCase {
    private var roots: [URL] = []

    override func tearDown() {
        for root in roots { try? FileManager.default.removeItem(at: root) }
        roots.removeAll()
        super.tearDown()
    }

    // MARK: - Presentation: reuses #45's vocabulary, never a second one

    func testActivationIsDisabledForEveryUnavailableValidationStateWithReusedExplanation() throws {
        let project = makeProject(status: .draft)
        let validReport = try decodeReport(fingerprint: Self.fingerprint)
        let invalidReport = try decodeReport(valid: false, fingerprint: Self.fingerprint)

        let states: [ProjectValidationState] = [
            .unvalidated,
            .validating,
            .invalid(invalidReport),
            .stale(validReport),
            .failed("Local API unavailable"),
        ]

        for validationState in states {
            var state = ProjectConfigurationState()
            state.validation = validationState
            let presentation = ProjectDetailPresentation(
                project: project, detail: nil, state: state, packages: [])

            XCTAssertFalse(
                presentation.activation.isEnabled,
                "unexpected enablement for \(validationState)")
            XCTAssertEqual(
                presentation.activation.explanation,
                presentation.validation.activationReadinessExplanation,
                "#55 must reuse #45's readiness vocabulary, not invent a second one, for \(validationState)"
            )
        }
    }

    func testActivationEnabledOnlyForACurrentSuccessfulReportCarryingAFingerprint() throws {
        let project = makeProject(status: .draft)

        var ready = ProjectConfigurationState()
        ready.validation = .valid(try decodeReport(fingerprint: Self.fingerprint))
        let readyPresentation = ProjectDetailPresentation(
            project: project, detail: nil, state: ready, packages: [])
        XCTAssertEqual(readyPresentation.activation.status, .ready)
        XCTAssertTrue(readyPresentation.activation.isEnabled)

        var noFingerprint = ProjectConfigurationState()
        noFingerprint.validation = .valid(try decodeReport(fingerprint: nil))
        let noFingerprintPresentation = ProjectDetailPresentation(
            project: project, detail: nil, state: noFingerprint, packages: [])
        XCTAssertFalse(
            noFingerprintPresentation.activation.isEnabled,
            "a report with no compositionFingerprint must refuse activation rather than guess or omit one"
        )
        XCTAssertTrue(
            noFingerprintPresentation.activation.explanation.contains("no composition fingerprint"))
    }

    func testAlreadyActiveProjectNeverOffersActivateRegardlessOfLocalActivationState() throws {
        let project = makeProject(status: .active)
        var state = ProjectConfigurationState()
        state.validation = .valid(try decodeReport(fingerprint: Self.fingerprint))
        let presentation = ProjectDetailPresentation(
            project: project, detail: nil, state: state, packages: [])
        XCTAssertFalse(presentation.activation.isEnabled)
        XCTAssertEqual(presentation.activation.status, .succeeded)
    }

    func testActivationRejectionRendersDistinctlyFromAValidationFinding() throws {
        let project = makeProject(status: .draft)
        var state = ProjectConfigurationState()
        state.validation = .valid(try decodeReport(fingerprint: Self.fingerprint))
        state.activation = .rejected(
            code: "project.activation-report-stale",
            message: "The composition changed since this report was generated.")
        let presentation = ProjectDetailPresentation(
            project: project, detail: nil, state: state, packages: [])

        XCTAssertEqual(presentation.activation.status, .rejected)
        XCTAssertTrue(presentation.activation.explanation.contains("project.activation-report-stale"))
        XCTAssertTrue(
            presentation.activation.explanation.contains(
                "The composition changed since this report was generated."))
        // The rejection is carried on its own Activation value, never folded
        // into the Validation Report's findings: an engine error must never
        // look like a validation finding.
        XCTAssertTrue(presentation.validation.findings.isEmpty)
        XCTAssertEqual(presentation.validation.status, .valid)
        // A rejection can be retried while the underlying report is still current.
        XCTAssertTrue(presentation.activation.isEnabled)
    }

    func testTransportFailureRendersAsAnActivationFailureNotAValidationFinding() throws {
        let project = makeProject(status: .draft)
        var state = ProjectConfigurationState()
        state.validation = .valid(try decodeReport(fingerprint: Self.fingerprint))
        state.activation = .transportFailure(
            "The engine did not answer (POST /v1/projects/x/activate returned 503).")
        let presentation = ProjectDetailPresentation(
            project: project, detail: nil, state: state, packages: [])

        XCTAssertEqual(presentation.activation.status, .transportFailure)
        XCTAssertTrue(presentation.activation.explanation.contains("did not answer"))
        XCTAssertTrue(presentation.validation.findings.isEmpty)
        XCTAssertEqual(presentation.validation.status, .valid)
    }

    // MARK: - Model: local refusal, engine rejection, transport failure, success

    @MainActor
    func testActivateRefusesLocallyWithNoCurrentSuccessfulReport() async throws {
        let session = EngineSessionModel(supervisor: EngineSupervisor(resources: .developmentBuild()))
        let projects = ProjectsModel(session: session)
        let configuration = ProjectConfigurationModel(session: session, projects: projects)

        await configuration.activate(projectId: "never-validated")

        guard case .rejected(let code, let message) =
            configuration.state(for: "never-validated").activation
        else { return XCTFail("must refuse locally without ever reaching the engine") }
        XCTAssertNil(code, "a client-side refusal must never carry an engine error code")
        XCTAssertTrue(message.contains("No current successful validation report"))
    }

    @MainActor
    func testActivateRefusesLocallyWhenTheDisplayedReportCarriesNoFingerprint() async throws {
        let session = EngineSessionModel(supervisor: EngineSupervisor(resources: .developmentBuild()))
        let projects = ProjectsModel(session: session)
        let report = try decodeReport(
            projectId: "fingerprint-fixture", valid: true, fingerprint: nil)
        let configuration = ProjectConfigurationModel(
            session: session,
            projects: projects,
            validationReportProvider: { _ in report })

        await configuration.validate(projectId: "fingerprint-fixture")
        guard case .valid = configuration.state(for: "fingerprint-fixture").validation else {
            return XCTFail("the fixture report must become current before activating")
        }

        await configuration.activate(projectId: "fingerprint-fixture")

        guard case .rejected(let code, let message) =
            configuration.state(for: "fingerprint-fixture").activation
        else { return XCTFail("must refuse locally rather than send a guessed fingerprint") }
        XCTAssertNil(code, "a client-side refusal must never carry an engine error code")
        XCTAssertTrue(message.contains("no composition fingerprint"))
    }

    @MainActor
    func testActivateRendersAnEngineRejectionDistinctlyAndLeavesDisplayedStateConsistent()
        async throws
    {
        let session = EngineSessionModel(supervisor: EngineSupervisor(resources: .developmentBuild()))
        let projects = ProjectsModel(session: session)
        let report = try decodeReport(
            projectId: "engine-rejects", valid: true, fingerprint: Self.fingerprint)
        let configuration = ProjectConfigurationModel(
            session: session,
            projects: projects,
            validationReportProvider: { _ in report },
            activationProvider: { _, _ in
                throw EngineClientError.engineError(
                    operation: "POST /v1/projects/engine-rejects/activate",
                    code: "project.activation-not-validated",
                    message: "No successful validation report matches the composition saved right now.")
            })

        await configuration.validate(projectId: "engine-rejects")
        await configuration.activate(projectId: "engine-rejects")

        guard case .rejected(let code, let message) =
            configuration.state(for: "engine-rejects").activation
        else { return XCTFail("an engine rejection must render as a rejected activation") }
        XCTAssertEqual(code, "project.activation-not-validated")
        XCTAssertTrue(message.contains("No successful validation report"))

        let presentation = ProjectDetailPresentation(
            project: makeProject(id: "engine-rejects", status: .draft),
            detail: nil,
            state: configuration.state(for: "engine-rejects"),
            packages: [])
        XCTAssertEqual(presentation.activation.status, .rejected)
        XCTAssertEqual(
            presentation.validation.status, .valid,
            "a rejected activation must leave the still-current validation report untouched")
    }

    @MainActor
    func testActivateRendersATransportFailureDistinctlyFromAnEngineRejection() async throws {
        let session = EngineSessionModel(supervisor: EngineSupervisor(resources: .developmentBuild()))
        let projects = ProjectsModel(session: session)
        let report = try decodeReport(
            projectId: "transport-fails", valid: true, fingerprint: Self.fingerprint)
        let configuration = ProjectConfigurationModel(
            session: session,
            projects: projects,
            validationReportProvider: { _ in report },
            activationProvider: { _, _ in
                throw EngineClientError.unexpectedResponse(
                    "POST /v1/projects/transport-fails/activate returned 503")
            })

        await configuration.validate(projectId: "transport-fails")
        await configuration.activate(projectId: "transport-fails")

        guard case .transportFailure(let message) =
            configuration.state(for: "transport-fails").activation
        else { return XCTFail("a transport failure must not be confused with an engine rejection") }
        XCTAssertTrue(message.contains("503"))
    }

    @MainActor
    func testSuccessfulActivationTransitionsAwayFromFailureAndRefreshesTheProjectList()
        async throws
    {
        let session = EngineSessionModel(supervisor: EngineSupervisor(resources: .developmentBuild()))
        let projects = ProjectsModel(session: session)
        let report = try decodeReport(
            projectId: "activates-cleanly", valid: true, fingerprint: Self.fingerprint)
        let forwarded = ForwardedFingerprint()
        let configuration = ProjectConfigurationModel(
            session: session,
            projects: projects,
            validationReportProvider: { _ in report },
            activationProvider: { projectId, fingerprint in
                await forwarded.record(fingerprint)
                return Project(
                    id: projectId, name: "Activates Cleanly", status: .active,
                    moduleCount: 1, activeExecutions: 0)
            })

        await configuration.validate(projectId: "activates-cleanly")
        await configuration.activate(projectId: "activates-cleanly")

        XCTAssertEqual(
            configuration.state(for: "activates-cleanly").activation, .succeeded,
            "success must not remain in an activating or failed state")
        let value = await forwarded.value()
        XCTAssertEqual(
            value, Self.fingerprint,
            "the exact fingerprint of the displayed report must be the one forwarded")
    }

    @MainActor
    func testActivateAgainstTheRealEngineRejectsAFingerprintThatNeverValidated() async throws {
        let repository = try makeRepository()
        let session = EngineSessionModel(
            supervisor: EngineSupervisor(
                resources: .developmentBuild(),
                dataRoot: temporaryDirectory(prefix: "jarvis-activate-real-engine")))
        let projects = ProjectsModel(
            session: session,
            repositoryGrants: RepositoryGrantStore(
                storageDirectory: temporaryDirectory(prefix: "jarvis-activate-real-engine-grants")))
        await session.start()
        await projects.inspect(at: repository)
        let importResult = await projects.confirmImport()
        let imported = try XCTUnwrap(importResult)

        // No `/validation-report` call ever reached the real engine for this
        // Project: the fixture forges only the Wizard's *local* belief that a
        // current report exists, so `activate()` calls the real endpoint
        // instead of refusing locally — exercising the real stable error code.
        let report = try decodeReport(
            projectId: imported.id, valid: true, fingerprint: Self.fingerprint)
        let configuration = ProjectConfigurationModel(
            session: session,
            projects: projects,
            validationReportProvider: { _ in report })

        await configuration.validate(projectId: imported.id)
        await configuration.activate(projectId: imported.id)

        guard case .rejected(let code, let message) =
            configuration.state(for: imported.id).activation
        else { return XCTFail("the real engine must reject a fingerprint it never issued") }
        XCTAssertTrue(
            code?.hasPrefix("project.activation-") == true,
            "unexpected code: \(code ?? "nil")")
        XCTAssertFalse(message.isEmpty)

        let detail = try await projects.detail(for: imported.id)
        XCTAssertEqual(
            detail.project.status, .draft,
            "a failed activation must leave the displayed Project state consistent with the engine")

        projects.releaseRepositoryAccess()
        await session.shutdown()
    }

    // MARK: - Fixtures

    private static let fingerprint = String(repeating: "a", count: 64)

    private func makeProject(id: String = "activation-fixture", status: Project.Status) -> Project {
        Project(id: id, name: "Activation Fixture", status: status, moduleCount: 1, activeExecutions: nil)
    }

    private func decodeReport(
        projectId: String = "activation-fixture",
        valid: Bool = true,
        fingerprint: String?
    ) throws -> ProjectValidationReport {
        let fingerprintField = fingerprint.map { "\"\($0)\"" } ?? "null"
        let json = """
            {
              "apiVersion": "jarvis.dev/project-validation/v1",
              "kind": "ProjectValidationReport",
              "projectId": "\(projectId)",
              "valid": \(valid),
              "requestRoutes": [],
              "satisfiedCapabilities": [],
              "findings": [],
              "compositionFingerprint": \(fingerprintField)
            }
            """
        let payload = try JSONDecoder().decode(
            Components.Schemas.ProjectValidationReportV1.self, from: Data(json.utf8))
        return try ProjectValidationReport(payload: payload)
    }

    private func makeRepository() throws -> URL {
        let root = temporaryDirectory(prefix: "jarvis-activation-repository")
        let git = root.appendingPathComponent(".git", isDirectory: true)
        try FileManager.default.createDirectory(at: git, withIntermediateDirectories: true)
        try "ref: refs/heads/main\n".write(
            to: git.appendingPathComponent("HEAD"), atomically: true, encoding: .utf8)
        try #"{"name":"activation-fixture"}"#.write(
            to: root.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        return root
    }

    private func temporaryDirectory(prefix: String) -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        roots.append(root)
        return root
    }
}

private actor ForwardedFingerprint {
    private var stored: String?
    func record(_ fingerprint: String) { stored = fingerprint }
    func value() -> String? { stored }
}
