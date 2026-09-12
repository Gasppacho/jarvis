import Foundation
import JarvisAPI
import XCTest

@testable import JarvisCore

final class ProjectRuntimeTests: XCTestCase {
    @MainActor
    func testZeroOneAndSeveralCandidatesNeverChooseImplicitly() async {
        for names in [[], ["Codex personnel"], ["Codex personnel", "Codex travail"]] {
            let api = RuntimeAPIStub(choices: choices(names: names))
            let model = model(api: api)
            await model.refreshRuntimeCandidates(projectId: "a")
            let state = model.state(for: "a")
            XCTAssertEqual(state.runtimePresentation.candidates.map(\.name), names)
            XCTAssertTrue(state.runtimePresentation.candidates.allSatisfy { !$0.bound })
            XCTAssertFalse(state.runtimeAllowsActivation)
            XCTAssertTrue(state.runtimePresentation.reviewEnabled)
            let bindings = await api.bindingCount()
            XCTAssertEqual(bindings, 0)
        }
    }

    @MainActor
    func testEveryReadinessStateHasTextImpactAndActivationPolicy() async {
        let cases: [(Components.Schemas.ProjectRuntimeReadiness.statusPayload, String)] = [
            (.ready, "Prêt"), (.absent, "Absent"), (.access_hyphen_denied, "Accès refusé"),
            (.incompatible, "Version incompatible"), (.checking, "Vérification en cours"),
            (.engine_hyphen_error, "Erreur du moteur"), (.unchecked, "Non vérifié")
        ]
        for (status, label) in cases {
            let api = RuntimeAPIStub(choices: choices(), result: choices(status: status, bound: true))
            let model = model(api: api)
            await model.refreshRuntimeCandidates(projectId: "a")
            await model.checkRuntime(projectId: "a")
            let state = model.state(for: "a")
            XCTAssertEqual(state.runtimePresentation.status, label)
            XCTAssertEqual(state.runtimeAllowsActivation, status == .ready)
            XCTAssertFalse(state.runtimePresentation.icon.isEmpty)
            XCTAssertTrue(state.runtimePresentation.reviewEnabled)
            if status != .ready { XCTAssertEqual(state.runtimePresentation.impact, "Development ne peut pas démarrer.") }
        }
    }

    @MainActor
    func testExplicitChoiceChecksAndReopeningPreservesBindingButRequiresANewCheck() async {
        let api = RuntimeAPIStub(choices: choices(), result: choices(status: .ready, bound: true))
        let model = model(api: api)
        await model.refreshRuntimeCandidates(projectId: "a")
        await model.chooseRuntime(projectId: "a", ref: "runtime/0")
        XCTAssertTrue(model.state(for: "a").runtimeAllowsActivation)
        let bindings = await api.bindingCount()
        XCTAssertEqual(bindings, 1)
        await model.refreshRuntimeCandidates(projectId: "a")
        XCTAssertEqual(model.state(for: "a").runtimePresentation.status, "Non vérifié")
        XCTAssertTrue(model.state(for: "a").runtimePresentation.candidates[0].bound)
        XCTAssertFalse(model.state(for: "a").runtimeAllowsActivation)
        XCTAssertNil(model.state(for: "a").runtimePresentation.checkedAt)
        // A second shell model has no cached readiness and reads the same local binding.
        let reopened = self.model(api: api)
        await reopened.refreshRuntimeCandidates(projectId: "a")
        XCTAssertTrue(reopened.state(for: "a").runtimePresentation.candidates[0].bound)
        XCTAssertFalse(reopened.state(for: "a").runtimeAllowsActivation)
    }

    @MainActor
    func testAPIFailureIsNotAbsenceAndNeverDisplaysTheRawError() async {
        let api = RuntimeAPIStub(choices: choices(), fails: true)
        let model = model(api: api)
        await model.refreshRuntimeCandidates(projectId: "a")
        let presentation = model.state(for: "a").runtimePresentation
        XCTAssertEqual(presentation.status, "Erreur du moteur")
        XCTAssertFalse(presentation.detail.contains("secret-token"))
        XCTAssertFalse(presentation.detail.contains("/private/"))
        XCTAssertTrue(presentation.reviewEnabled)
        XCTAssertFalse(model.state(for: "a").runtimeAllowsActivation)
    }

    @MainActor
    func testPendingCheckLeavesReviewAccessibleAndReloadRejectsItsLateResponse() async {
        let api = RuntimeAPIStub(choices: choices(bound: true), deferred: true)
        let model = model(api: api)
        await model.refreshRuntimeCandidates(projectId: "a")
        let check = Task { await model.checkRuntime(projectId: "a") }
        await api.waitForCheck()
        XCTAssertEqual(model.state(for: "a").runtimePresentation.status, "Vérification en cours")
        XCTAssertFalse(model.state(for: "a").runtimePresentation.canCheck)
        XCTAssertFalse(model.state(for: "a").runtimeAllowsActivation)
        XCTAssertTrue(model.state(for: "a").runtimePresentation.reviewEnabled)
        // Reload revokes the in-flight snapshot even if the engine is unavailable.
        await model.refresh(projectId: "a")
        await api.finishCheck(choices(status: .ready, bound: true))
        await check.value
        XCTAssertEqual(model.state(for: "a").runtimePresentation.status, "Non vérifié")
        XCTAssertFalse(model.state(for: "a").runtimeAllowsActivation)
    }

    @MainActor
    func testRuntimeChoiceExcludesOtherBindingWritesUntilItsSnapshotIsReloaded() async {
        let api = RuntimeAPIStub(choices: choices(), result: choices(status: .ready, bound: true), deferBindings: true)
        let model = model(api: api)
        await model.refreshRuntimeCandidates(projectId: "a")
        let choose = Task { await model.chooseRuntime(projectId: "a", ref: "runtime/0") }
        await api.waitForBindingReload()
        XCTAssertTrue(model.state(for: "a").isSaving, "All binding controls must share the choice/reload exclusion")
        await model.chooseRuntime(projectId: "a", ref: "runtime/0")
        let count = await api.bindingCount()
        XCTAssertEqual(count, 1, "A second choice cannot race the outstanding binding reload")
        await api.finishBindingReload()
        await choose.value
        XCTAssertFalse(model.state(for: "a").isSaving)
        XCTAssertTrue(model.state(for: "a").runtimeAllowsActivation)
    }

    @MainActor
    func testFailedBindingReloadDiscardsTheStaleSnapshotBeforeOtherWrites() async {
        let api = RuntimeAPIStub(choices: choices(), result: choices(status: .ready, bound: true))
        let model = model(api: api)
        await model.refreshRuntimeCandidates(projectId: "a")
        await model.chooseRuntime(projectId: "a", ref: "runtime/0")
        XCTAssertNotNil(model.state(for: "a").localBindings)
        await api.failBindingReload()
        await model.chooseRuntime(projectId: "a", ref: "runtime/0")
        XCTAssertNil(model.state(for: "a").localBindings, "The old full-replacement payload must not erase the binding that the Engine just saved")
        XCTAssertFalse(model.state(for: "a").runtimeAllowsActivation)
        XCTAssertFalse(model.state(for: "a").isSaving)
        let changed = await model.setLocalBinding(projectId: "a", slotId: "sourceControl", candidate: nil)
        XCTAssertNil(changed)
        XCTAssertTrue(model.state(for: "a").errorMessage?.contains("not loaded") == true)
    }

    @MainActor
    private func model(api: RuntimeAPIStub) -> ProjectConfigurationModel {
        let session = EngineSessionModel(supervisor: EngineSupervisor(resources: .developmentBuild()))
        return ProjectConfigurationModel(session: session, projects: ProjectsModel(session: session), runtimeAPI: api)
    }

    private func choices(
        names: [String] = ["Codex personnel"],
        status: Components.Schemas.ProjectRuntimeReadiness.statusPayload = .unchecked,
        bound: Bool = false
    ) -> Components.Schemas.ProjectAgentRuntimeChoices {
        .init(required: true, items: names.enumerated().map { index, name in
            .init(ref: "runtime/\(index)", displayName: name, provider: "codex", version: "0.153.4", capabilities: ["agent.execute"], bound: bound, selectable: true,
                  readiness: .init(status: .unchecked, checkedAt: nil, detail: "Choisissez puis vérifiez le runtime."))
        }, readiness: .init(status: status, checkedAt: status == .ready ? Date(timeIntervalSince1970: 1) : nil, detail: "Vérifiez les accès locaux ou choisissez un autre runtime."))
    }
}

actor RuntimeAPIStub: ProjectRuntimeAPI {
    var choices: Components.Schemas.ProjectAgentRuntimeChoices
    let result: Components.Schemas.ProjectAgentRuntimeChoices?
    let fails: Bool
    let deferred: Bool
    let deferBindings: Bool
    var bindingContinuation: CheckedContinuation<Void, Never>?
    var bindingReloadFails = false
    var bindings = 0
    var continuation: CheckedContinuation<Components.Schemas.ProjectAgentRuntimeChoices, Never>?

    init(choices: Components.Schemas.ProjectAgentRuntimeChoices, result: Components.Schemas.ProjectAgentRuntimeChoices? = nil, fails: Bool = false, deferred: Bool = false, deferBindings: Bool = false) {
        self.choices = choices
        self.result = result
        self.fails = fails
        self.deferred = deferred
        self.deferBindings = deferBindings
    }
    func listProjectBindingCandidates(projectId: String) async throws -> ProjectResourceChoices {
        if fails { throw EngineClientError.unexpectedResponse("/private/login secret-token") }
        return ProjectResourceChoices(candidates: [], slots: [], agentRuntimes: choices)
    }
    func getProjectBindings(projectId: String) async throws -> LocalProjectBindings {
        if bindingReloadFails { throw EngineClientError.unexpectedResponse("Reload failed") }
        if deferBindings { await withCheckedContinuation { bindingContinuation = $0 } }
        let json = """
        {"apiVersion":"jarvis.dev/project-bindings/v1","kind":"ProjectBindings","projectId":"\(projectId)","repositories":{},"slots":{}}
        """
        return LocalProjectBindings(payload: try JSONDecoder().decode(Components.Schemas.ProjectBindings.self, from: Data(json.utf8)))
    }
    func discoverProjectRuntimes() async throws {}
    func bindProjectRuntime(projectId: String, ref: String) async throws -> Components.Schemas.ProjectAgentRuntimeChoices {
        bindings += 1
        choices.items[0].bound = true
        return choices
    }
    func checkProjectRuntime(projectId: String) async throws -> Components.Schemas.ProjectAgentRuntimeChoices {
        if deferred { return await withCheckedContinuation { continuation = $0 } }
        return result ?? choices
    }
    func failBindingReload() { bindingReloadFails = true }
    func bindingCount() -> Int { bindings }
    func waitForBindingReload() async { while bindingContinuation == nil { await Task.yield() } }
    func finishBindingReload() { bindingContinuation?.resume(); bindingContinuation = nil }
    func waitForCheck() async { while continuation == nil { await Task.yield() } }
    func finishCheck(_ result: Components.Schemas.ProjectAgentRuntimeChoices) { continuation?.resume(returning: result); continuation = nil }
}
