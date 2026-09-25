import Foundation
import JarvisAPI
import XCTest

@testable import JarvisCore

final class ProjectOnboardingPresentationTests: XCTestCase {
    func testEmptyStateAndDraftInventoryAreExplicitAndAccessible() {
        let empty = ProjectOnboardingPresentation(project: nil)
        XCTAssertEqual(empty.emptyState?.title, "Bienvenue dans Jarvis")
        XCTAssertEqual(empty.emptyState?.primaryAction, "Choisir un dépôt Git")

        let draft = Project(
            id: "draft-1",
            name: "Example",
            status: .draft,
            moduleCount: 0,
            activeExecutions: nil)
        let presentation = ProjectOnboardingPresentation(project: draft)

        XCTAssertEqual(
            presentation.steps.map(\.title),
            ["Workflow", "Paramétrage", "Vérification"])
        XCTAssertEqual(
            presentation.steps.map(\.status),
            [.complete, .complete, .needsAction])
        XCTAssertTrue(presentation.steps.allSatisfy { !$0.accessibilityLabel.isEmpty })
        XCTAssertTrue(presentation.reviewIsAccessible)
        XCTAssertFalse(presentation.canActivate)
        XCTAssertEqual(presentation.deletionLabel, "Supprimer le brouillon")

        let active = Project(
            id: "active-1",
            name: "Active",
            status: .active,
            moduleCount: 2,
            activeExecutions: 0)
        XCTAssertEqual(ProjectOnboardingPresentation(project: active).deletionLabel, "Supprimer le projet")
    }

    func testSavingAndReviewStatesDoNotClaimUnexecutedSuccess() {
        let project = Project(id: "draft-1", name: "Example", status: .draft, moduleCount: 0, activeExecutions: nil)
        var state = ProjectConfigurationState()
        XCTAssertEqual(state.saveStatus, "Modifications à enregistrer")
        state.isSaving = true
        XCTAssertEqual(state.saveStatus, "Enregistrement…")
        state.isSaving = false
        state.errorMessage = "Binding unavailable"
        XCTAssertEqual(state.saveStatus, "Modifications à enregistrer", "a binding error is not a failed save")
        state.saveFailed = true
        XCTAssertEqual(state.saveStatus, "Échec — Réessayer")
        state.saveFailed = false
        state.isDraftSaved = true
        XCTAssertEqual(state.saveStatus, "Enregistré", "a later review error must not claim the completed save failed")
        state.preflight = .loading
        XCTAssertEqual(ProjectOnboardingPresentation(project: project, configuration: state).steps.last?.status, .inProgress)
        state.preflight = .failed("Engine disconnected")
        XCTAssertEqual(ProjectOnboardingPresentation(project: project, configuration: state).steps.last?.status, .failed)
        state.preflight = .stale(nil)
        let stale = ProjectOnboardingPresentation(project: project, configuration: state)
        XCTAssertEqual(stale.steps.last?.status, .stale)
        XCTAssertFalse(stale.canActivate)
        state.isLoading = true
        XCTAssertEqual(ProjectOnboardingPresentation(project: project, configuration: state).steps.first?.status, .inProgress)
        state.isLoading = false
        XCTAssertEqual(ProjectOnboardingPresentation(project: project, configuration: state).steps.first?.status, .complete)
        state.errorMessage = nil
        XCTAssertEqual(ProjectOnboardingPresentation(project: project, configuration: state).steps.first?.status, .complete)
    }

    func testCurrentStepPersistsWithoutRewritingUnknownStoredValues() {
        let suite = "ProjectOnboardingPresentationTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        let store = ProjectOnboardingNavigationStore(defaults: defaults)
        store.lastProjectID = "draft-1"
        XCTAssertEqual(ProjectOnboardingNavigationStore(defaults: defaults).lastProjectID, "draft-1")
        store.set(.review, for: "draft-1")
        XCTAssertEqual(
            ProjectOnboardingNavigationStore(defaults: defaults).currentStep(for: "draft-1"),
            .review)

        defaults.set("future-step", forKey: store.key(for: "draft-1"))
        XCTAssertEqual(store.currentStep(for: "draft-1"), .workflow)
        XCTAssertEqual(defaults.string(forKey: store.key(for: "draft-1")), "future-step")
        let isolated = ProjectOnboardingNavigationStore(defaults: defaults, namespace: "isolated:")
        XCTAssertNil(isolated.lastProjectID)
        isolated.lastProjectID = "draft-2"
        XCTAssertEqual(store.lastProjectID, "draft-1")
        isolated.set(.workflow, for: "draft-1")
        XCTAssertEqual(defaults.string(forKey: store.key(for: "draft-1")), "future-step")
        XCTAssertEqual(ProjectOnboardingNavigationStore(defaults: defaults, namespace: "isolated:").currentStep(for: "draft-1"), .workflow)
    }

    func testSettingsShowOnlySelectedModulesAndKeepUnavailableCLISelectable() throws {
        var state = ProjectConfigurationState()
        state.draft = ProjectConfigurationDraft(
            configuration: try configuration(module: "development", readyLabel: ""),
            packages: [])
        state.localBindings = try localBindings(slot: "agentRuntime", kind: "runtime", ref: "runtime/codex")
        state.agentRuntimes = .init(
            required: true,
            items: [
                .init(
                    ref: "runtime/codex", displayName: "Codex", provider: "codex",
                    version: nil, capabilities: ["agent.execute"], bound: true,
                    selectable: true,
                    readiness: .init(
                        status: .absent, checkedAt: nil,
                        detail: "Codex n’est pas installé.")),
            ],
            readiness: .init(status: .unchecked, checkedAt: nil, detail: ""))

        let settings = ProjectSettingsPresentation(configuration: state)

        XCTAssertNil(settings.github)
        XCTAssertEqual(settings.development?.readyLabel, "")
        XCTAssertEqual(settings.development?.runtimes.map(\.name), ["Codex"])
        XCTAssertEqual(settings.development?.runtimes.first?.status, "Indisponible")
        XCTAssertTrue(settings.development?.runtimes.first?.isSelectable == true)
        XCTAssertTrue(settings.development?.runtimes.first?.isSelected == true)
    }

    func testPullRequestOnlyExposesRuntimeChoices() throws {
        var state = ProjectConfigurationState()
        state.draft = ProjectConfigurationDraft(
            configuration: try configuration(module: "pull-request", readyLabel: nil),
            packages: [])
        state.localBindings = try localBindings(slot: "agentRuntime", kind: "runtime", ref: "runtime/codex")
        let account = ProjectResourceCandidate(
            payload: .init(
                ref: "connection/github-me", kind: .connection, displayName: "me",
                capabilities: ["github.api"]))
        state.resourceChoices = [
            ProjectResourceBindingChoice(
                slotId: "sourceControl", requiredCapabilities: ["github.api"],
                candidates: [account], status: .bound, impact: "", repairAction: ""),
        ]
        state.agentRuntimes = .init(
            required: true,
            items: [
                .init(
                    ref: "runtime/codex", displayName: "Codex", provider: "codex",
                    version: nil, capabilities: ["agent.execute"], bound: true,
                    selectable: true,
                    readiness: .init(status: .ready, checkedAt: nil, detail: "")),
            ],
            readiness: .init(status: .ready, checkedAt: nil, detail: ""))

        let settings = ProjectSettingsPresentation(configuration: state)

        XCTAssertEqual(settings.github?.accounts.map(\.name), ["me"])
        XCTAssertNil(settings.development)
        XCTAssertEqual(settings.pullRequestRuntimes?.map(\.name), ["Codex"])
        XCTAssertTrue(settings.pullRequestRuntimes?.first?.isSelected == true)
    }

    func testGitHubSettingsExposeRepositoryStateAndSelectedAccount() throws {
        var state = ProjectConfigurationState()
        state.draft = ProjectConfigurationDraft(
            configuration: try configuration(module: "github", readyLabel: nil),
            packages: [])
        state.detail = try projectDetail(isGitRepository: true, isGitHubRepository: false)
        let account = ProjectResourceCandidate(
            payload: .init(
                ref: "connection/github-me", kind: .connection, displayName: "me",
                capabilities: ["scm.change-request.manage"]))
        state.candidates = [account]
        state.resourceChoices = [
            ProjectResourceBindingChoice(
                slotId: "sourceControl",
                requiredCapabilities: ["scm.change-request.manage"],
                candidates: [account], status: .bound, impact: "", repairAction: ""),
        ]
        state.localBindings = try localBindings(
            slot: "sourceControl", kind: "connection", ref: "connection/github-me")

        let settings = ProjectSettingsPresentation(configuration: state)

        XCTAssertNil(settings.development)
        XCTAssertEqual(settings.github?.accounts.map(\.name), ["me"])
        XCTAssertTrue(settings.github?.accounts.first?.isSelected == true)
        XCTAssertTrue(settings.github?.isGitRepository == true)
        XCTAssertFalse(settings.github?.isGitHubRepository == true)
    }

    private func configuration(
        module: String,
        readyLabel: String?
    ) throws -> Components.Schemas.PortableProjectConfiguration {
        let modulePayload: [String: Any]
        let slots: [String: Any]
        if module == "github" {
            modulePayload = [
                "instanceId": "github", "moduleId": "jarvis.module.github", "enabled": true,
                "bindings": ["sourceControl": "sourceControl"], "configuration": [:],
            ]
            slots = ["sourceControl": ["requires": "scm.change-request.manage"]]
        } else if module == "pull-request" {
            modulePayload = [
                "instanceId": "pull-request", "moduleId": "jarvis.module.pull-request",
                "enabled": true, "runtimeSlot": "agentRuntime",
                "bindings": ["repository": "main", "sourceControl": "sourceControl"],
            ]
            slots = ["agentRuntime": ["requires": "agent.execute"]]
        } else {
            modulePayload = [
                "instanceId": "development", "moduleId": "jarvis.module.development",
                "enabled": true, "runtimeSlot": "agentRuntime",
                "bindings": ["repository": "main"],
                "configuration": ["readyLabel": readyLabel ?? "ready-to-dev"],
            ]
            slots = ["agentRuntime": ["requires": "agent.execute"]]
        }
        let payload: [String: Any] = [
            "apiVersion": "jarvis.dev/project/v1", "kind": "Project",
            "metadata": ["id": "settings", "name": "Settings"],
            "repositories": [["id": "main", "root": "."]],
            "slots": slots,
            "modules": [modulePayload], "compositionMode": "fixed-modules",
        ]
        return try JSONDecoder().decode(
            Components.Schemas.PortableProjectConfiguration.self,
            from: JSONSerialization.data(withJSONObject: payload))
    }

    private func localBindings(
        slot: String,
        kind: String,
        ref: String
    ) throws -> LocalProjectBindings {
        let data = try JSONSerialization.data(withJSONObject: [
            "apiVersion": "jarvis.dev/project-bindings/v1", "kind": "ProjectBindings",
            "projectId": "settings", "repositories": [:],
            "slots": [slot: ["kind": kind, "ref": ref]],
        ])
        return LocalProjectBindings(
            payload: try JSONDecoder().decode(Components.Schemas.ProjectBindings.self, from: data))
    }

    private func projectDetail(
        isGitRepository: Bool,
        isGitHubRepository: Bool
    ) throws -> ProjectDetail {
        let configuration = try configuration(module: "github", readyLabel: nil)
        let configData = try JSONEncoder().encode(configuration)
        let config = try JSONSerialization.jsonObject(with: configData)
        let data = try JSONSerialization.data(withJSONObject: [
            "id": "settings", "name": "Settings", "status": "draft", "moduleCount": 1,
            "portableConfig": config,
            "bindingStatus": [
                "main": [
                    "path": "/tmp/settings", "accessible": true, "bookmarkRef": NSNull(),
                    "isGitRepository": isGitRepository,
                    "isGitHubRepository": isGitHubRepository,
                    "remoteUrl": NSNull(),
                ],
            ],
        ])
        return ProjectDetail(
            detail: try JSONDecoder().decode(Components.Schemas.ProjectDetail.self, from: data))
    }
}
