import Foundation
import XCTest

@testable import JarvisCore

final class ProjectOnboardingPresentationTests: XCTestCase {
    func testGitHubPollingFrequencyUsesMinutesAndPreservesHistoricalSeconds() {
        XCTAssertEqual(GitHubPollingFrequency.display(seconds: nil), "1")
        XCTAssertEqual(GitHubPollingFrequency.display(seconds: 60), "1")
        XCTAssertEqual(GitHubPollingFrequency.display(seconds: 3600), "60")
        XCTAssertEqual(
            GitHubPollingFrequency.display(seconds: GitHubPollingFrequency.historicalSeconds),
            "15 secondes (historique)")
        XCTAssertEqual(GitHubPollingFrequency.seconds(fromMinutes: "1"), 60)
        XCTAssertEqual(GitHubPollingFrequency.seconds(fromMinutes: "60"), 3600)
        XCTAssertNil(GitHubPollingFrequency.seconds(fromMinutes: "0"))
        XCTAssertNil(GitHubPollingFrequency.seconds(fromMinutes: "-1"))
        XCTAssertNil(GitHubPollingFrequency.seconds(fromMinutes: "61"))
        XCTAssertNil(GitHubPollingFrequency.seconds(fromMinutes: ""))
    }

    func testEmptyStateAndDraftInventoryAreExplicitAndAccessible() {
        let empty = ProjectOnboardingPresentation(project: nil)
        XCTAssertEqual(empty.emptyState?.title, "Bienvenue dans Jarvis")
        XCTAssertEqual(empty.emptyState?.primaryAction, "Ajouter un projet")

        let draft = Project(
            id: "draft-1",
            name: "Example",
            status: .draft,
            moduleCount: 0,
            activeExecutions: nil)
        let presentation = ProjectOnboardingPresentation(project: draft)

        XCTAssertEqual(
            presentation.steps.map(\.title),
            ["Dépôt", "Workflow", "Accès et agent", "Vérification"])
        XCTAssertEqual(
            presentation.steps.map(\.status),
            [.needsAction, .needsAction, .needsAction, .needsAction])
        XCTAssertTrue(presentation.steps.allSatisfy { !$0.accessibilityLabel.isEmpty })
        XCTAssertTrue(presentation.reviewIsAccessible)
        XCTAssertFalse(presentation.canActivate)
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
        XCTAssertEqual(ProjectOnboardingPresentation(project: project, configuration: state).steps.first?.status, .failed)
        state.errorMessage = nil
        XCTAssertEqual(ProjectOnboardingPresentation(project: project, configuration: state).steps.first?.status, .needsAction)
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
        XCTAssertEqual(store.currentStep(for: "draft-1"), .repository)
        XCTAssertEqual(defaults.string(forKey: store.key(for: "draft-1")), "future-step")
        let isolated = ProjectOnboardingNavigationStore(defaults: defaults, namespace: "isolated:")
        XCTAssertNil(isolated.lastProjectID)
        isolated.lastProjectID = "draft-2"
        XCTAssertEqual(store.lastProjectID, "draft-1")
        isolated.set(.workflow, for: "draft-1")
        XCTAssertEqual(defaults.string(forKey: store.key(for: "draft-1")), "future-step")
        XCTAssertEqual(ProjectOnboardingNavigationStore(defaults: defaults, namespace: "isolated:").currentStep(for: "draft-1"), .workflow)
    }
}
