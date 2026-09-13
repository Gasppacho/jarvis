import Foundation
import HTTPTypes
import OpenAPIRuntime
import JarvisAPI
import XCTest
@testable import JarvisCore

final class ProjectPreflightTests: XCTestCase {
    func testReadinessStatesEmptyCandidatesBlockersAndRepairDestinations() throws {
        let empty = try fixture(empty: true)
        XCTAssertTrue(ProjectPreflightState.current(empty).canActivate)
        XCTAssertEqual(ProjectPreflightState.current(empty).title, "Configuration vérifiée")
        XCTAssertEqual(empty.candidateEligibility.status, .empty)
        let blocked = try fixture(blocked: true)
        XCTAssertTrue(ProjectPreflightState.current(blocked).canActivate, "A blocker affects the candidate, not configuration readiness")
        XCTAssertEqual(blocked.candidateEligibility.items.first?.status, .ineligible)
        XCTAssertEqual(blocked.candidateEligibility.items.first?.openDependencyCount, 1)
        XCTAssertEqual(blocked.candidateEligibility.items.first?.blockerRefs, ["github://owner/repo/issues/99"])
        let eligible = try fixture()
        XCTAssertEqual(eligible.candidateEligibility.items.first?.status, .eligible)
        XCTAssertEqual(eligible.candidateEligibility.items.first?.openDependencyCount, 0)
        XCTAssertEqual(eligible.checks.map(ProjectPreflightState.repairStep), [.repository, .workflow, .connections])
        for state: ProjectPreflightState in [.unchecked, .loading, .stale(empty), .failed("offline"), .current(try fixture(valid: false))] {
            XCTAssertFalse(state.canActivate)
            XCTAssertFalse(state.title.isEmpty)
        }
    }

    func testFinalActionKeepsExactIssueIntentAndRejectsUnverifiedCandidates() throws {
        var report = try fixture()
        XCTAssertEqual(ProjectPreflightState.current(report).activationTitle, "Surveiller les issues prêtes")
        report.rule = .init(instanceId: "rules", ruleId: "ready", label: "ready-for-agent", selectedWorkItemRef: "github://owner/repo/issues/1")
        XCTAssertEqual(ProjectPreflightState.current(report).activationTitle, "Tester avec l’issue #1")
        XCTAssertTrue(ProjectPreflightState.current(report).canStartWorkflow)
        report.candidateEligibility.items[0].status = .ineligible
        XCTAssertFalse(ProjectPreflightState.current(report).canStartWorkflow)
        report.candidateEligibility.items = []
        XCTAssertFalse(ProjectPreflightState.current(report).canStartWorkflow)
        XCTAssertEqual(ProjectPreflightState.stale(report).activationTitle, "Tester avec l’issue #1")
        XCTAssertFalse(ProjectPreflightState.stale(report).canStartWorkflow)
        report.rule = nil
        XCTAssertTrue(ProjectPreflightState.current(report).canStartWorkflow, "No candidate does not prevent explicit monitoring")
    }

    @MainActor
    func testTransportRetryKeepsErrorsSeparateAndForwardsOnlyCurrentFingerprint() async throws {
        let api = PreflightStub(report: try fixture())
        let model = model(api)
        await api.setFailure(true)
        await model.preflight(projectId: "project")
        guard case .failed = model.state(for: "project").preflight else { return XCTFail("transport failure must not become findings") }
        XCTAssertNil(model.state(for: "project").preflightReceivedAt)
        await model.activateWorkflow(projectId: "project")
        let rejectedCalls = await api.activations
        XCTAssertTrue(rejectedCalls.isEmpty)
        await api.setFailure(false)
        await model.preflight(projectId: "project")
        XCTAssertTrue(model.state(for: "project").preflight.canActivate)
        XCTAssertNotNil(model.state(for: "project").preflightReceivedAt)
        await model.activateWorkflow(projectId: "project")
        let calls = await api.activations
        XCTAssertEqual(calls, [String(repeating: "a", count: 64)])
        XCTAssertEqual(model.state(for: "project").activation, .succeeded)
        await model.refresh(projectId: "project")
        let disconnected = model.state(for: "project")
        XCTAssertFalse(disconnected.preflight.canActivate)
        XCTAssertEqual(ProjectOnboardingPresentation(
            project: Project(id: "project", name: "Project", status: .draft, moduleCount: 3, activeExecutions: 0),
            configuration: disconnected).steps.last?.status, .stale)
        await model.activateWorkflow(projectId: "project")
        let afterDisconnect = await api.activations
        XCTAssertEqual(afterDisconnect, calls, "a lost Engine client must invalidate the old report")
    }

    @MainActor
    func testBindingChangeInvalidatesReportAndRejectsLateResponse() async throws {
        let api = PreflightStub(report: try fixture(), delay: true)
        let model = model(api)
        let task = Task { await model.preflight(projectId: "project") }
        while model.state(for: "project").preflight != .loading { await Task.yield() }
        XCTAssertFalse(model.state(for: "project").preflight.canActivate)
        await model.refreshAfterRepositoryBindingChange(projectId: "project")
        await task.value
        XCTAssertFalse(model.state(for: "project").preflight.canActivate)
        await model.activateWorkflow(projectId: "project")
        let calls = await api.activations
        XCTAssertTrue(calls.isEmpty, "a response predating an edit must never supply activation's fingerprint")
        await api.setDelay(false)
        await model.preflight(projectId: "project")
        await model.refreshAfterRepositoryBindingChange(projectId: "project")
        guard case .stale = model.state(for: "project").preflight else { return XCTFail("current report must become stale") }
        await model.activateWorkflow(projectId: "project")
        let stillNoCalls = await api.activations
        XCTAssertTrue(stillNoCalls.isEmpty)
    }

    @MainActor
    func testActivationRejectionAndTransportDoNotBecomeSuccessOrReplaceReport() async throws {
        let api = PreflightStub(report: try fixture())
        let model = model(api)
        await model.preflight(projectId: "project")
        await api.setActivationFailure(.engineError(operation: "activate", code: "project.activation-report-stale", message: "Changed"))
        await model.activateWorkflow(projectId: "project")
        XCTAssertEqual(model.state(for: "project").activation, .rejected(code: "project.activation-report-stale", message: "Changed"))
        XCTAssertTrue(model.state(for: "project").preflight.canActivate)
        await api.setActivationFailure(.unexpectedResponse("offline"))
        await model.activateWorkflow(projectId: "project")
        guard case .transportFailure = model.state(for: "project").activation else { return XCTFail("transport must stay distinct") }
    }

    @MainActor
    func testAnotherProjectsResponseCannotBecomeCurrent() async throws {
        let api = PreflightStub(report: try fixture())
        let model = model(api)
        await model.preflight(projectId: "other")
        XCTAssertFalse(model.state(for: "other").preflight.canActivate)
        await model.activateWorkflow(projectId: "other")
        let calls = await api.activations
        XCTAssertTrue(calls.isEmpty)
    }

    @MainActor
    func testTrialProvenanceSurvivesReopeningAndNeverOwnsAPermanentFilter() async throws {
        let key = "dev.jarvis.project-trial.v1.project"
        let previous = UserDefaults.standard.object(forKey: key)
        defer { UserDefaults.standard.set(previous, forKey: key) }
        UserDefaults.standard.removeObject(forKey: key)
        var report = try fixture()
        report.rule = .init(instanceId: "rules", ruleId: "ready", label: "ready-for-agent", selectedWorkItemRef: "github://owner/repo/issues/1")
        let api = PreflightStub(report: report)
        let permanent = model(api)
        await permanent.preflight(projectId: "project")
        XCTAssertFalse(permanent.state(for: "project").canRestoreTrial)
        UserDefaults.standard.set("github://owner/repo/issues/1", forKey: key)
        let reopened = model(api)
        await reopened.preflight(projectId: "project")
        XCTAssertTrue(reopened.state(for: "project").canRestoreTrial)
        let isolated = model(api, preferenceNamespace: "isolated:fixture:")
        await isolated.preflight(projectId: "project")
        XCTAssertFalse(isolated.state(for: "project").canRestoreTrial, "an isolated data root must not inherit the real project's trial")
        UserDefaults.standard.set("github://owner/repo/issues/2", forKey: key)
        let changed = model(api)
        await changed.preflight(projectId: "project")
        XCTAssertFalse(changed.state(for: "project").canRestoreTrial)
    }

    func testMonitoringScopeRequestCarriesAnExplicitIntentWhenReferenceIsAbsent() async throws {
        let transport = ScopeRequestTransport()
        let client = EngineClient(serverURL: URL(string: "http://127.0.0.1:1")!, transport: transport)
        do { _ = try await client.scopePreflightProject(projectId: "project", fingerprint: "fp", workItemRef: nil) } catch { }
        let allRequest = try JSONSerialization.jsonObject(with: Data(await transport.bytes())) as! [String: Any]
        XCTAssertEqual(allRequest["scope"] as? String, "all")
        XCTAssertEqual(allRequest["compositionFingerprint"] as? String, "fp")
        XCTAssertNil(allRequest["workItemRef"])
        do { _ = try await client.scopePreflightProject(projectId: "project", fingerprint: "fp", workItemRef: "github://owner/repo/issues/1") } catch { }
        let issueRequest = try JSONSerialization.jsonObject(with: Data(await transport.bytes())) as! [String: Any]
        XCTAssertEqual(issueRequest["scope"] as? String, "issue")
        XCTAssertEqual(issueRequest["workItemRef"] as? String, "github://owner/repo/issues/1")
    }

    @MainActor private func model(_ api: PreflightStub, preferenceNamespace: String = "") -> ProjectConfigurationModel {
        let session = EngineSessionModel(supervisor: EngineSupervisor(resources: .developmentBuild()))
        return ProjectConfigurationModel(session: session, projects: ProjectsModel(session: session, preferenceNamespace: preferenceNamespace), preflightAPI: api)
    }

    private func fixture(valid: Bool = true, blocked: Bool = false, empty: Bool = false) throws -> Components.Schemas.ProjectPreflightV1 {
        let candidate = """
        {"workItemRef":"github://owner/repo/issues/1","title":"Issue one","repositoryId":"main","status":"\(blocked ? "ineligible" : "eligible")","openDependencyCount":\(blocked ? 1 : 0),"blockerRefs":\(blocked ? "[\"github://owner/repo/issues/99\"]" : "[]"),"reason":"Dependency assessment"}
        """
        let json = """
        {"apiVersion":"jarvis.dev/project-preflight/v1","kind":"ProjectPreflight","projectId":"project","compositionFingerprint":"\(String(repeating: "a", count: 64))","valid":\(valid),"configurationReady":\(valid),
        "validation":{"apiVersion":"jarvis.dev/project-validation/v1","kind":"ProjectValidationReport","projectId":"project","valid":\(valid),"compositionFingerprint":"\(String(repeating: "a", count: 64))","requestRoutes":[],"satisfiedCapabilities":[],"findings":[]},
        "runtime":{"required":true,"items":[],"readiness":{"status":"ready","checkedAt":null,"detail":"Ready"}},
        "checks":[{"id":"repository","title":"Repository","status":"passed","impact":"Access","repairStep":"Repository"},{"id":"rule","title":"Rule","status":"passed","impact":"Label","repairStep":"Workflow"},{"id":"runtime","title":"Runtime","status":"passed","impact":"Agent","repairStep":"Connections"}],
        "candidateEligibility":{"status":"\(empty ? "empty" : "available")","items":[\(empty ? "" : candidate)]}}
        """
        return try JSONDecoder().decode(Components.Schemas.ProjectPreflightV1.self, from: Data(json.utf8))
    }
}

private actor PreflightStub: ProjectPreflightAPI {
    let report: Components.Schemas.ProjectPreflightV1
    var fail = false
    var delay: Bool
    var activationFailure: EngineClientError?
    private(set) var activations: [String] = []
    init(report: Components.Schemas.ProjectPreflightV1, delay: Bool = false) { self.report = report; self.delay = delay }
    func setFailure(_ value: Bool) { fail = value }
    func setDelay(_ value: Bool) { delay = value }
    func setActivationFailure(_ value: EngineClientError) { activationFailure = value }
    func preflightProject(projectId: String) async throws -> Components.Schemas.ProjectPreflightV1 {
        if delay { try await Task.sleep(for: .milliseconds(60)) }
        if fail { throw EngineClientError.unexpectedResponse("offline") }
        return report
    }
    func scopePreflightProject(projectId: String, fingerprint: String, workItemRef: String?) async throws -> Components.Schemas.PortableProjectConfiguration { throw EngineClientError.unexpectedResponse("Not configured") }
    func activatePreflightProject(projectId: String, fingerprint: String) async throws -> Project {
        activations.append(fingerprint)
        if let activationFailure { throw activationFailure }
        return Project(id: projectId, name: "Project", status: .active, moduleCount: 3, activeExecutions: 0)
    }
}

private actor ScopeRequestTransport: ClientTransport {
    private var captured: [UInt8] = []
    func bytes() -> [UInt8] { captured }
    func send(_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String) async throws -> (HTTPResponse, HTTPBody?) {
        captured = []
        if let body { for try await chunk in body { captured.append(contentsOf: chunk) } }
        throw EngineClientError.unexpectedResponse("Request captured")
    }
}
