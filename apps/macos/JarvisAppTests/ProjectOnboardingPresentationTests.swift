import Foundation
import XCTest

@testable import JarvisCore

final class ProjectOnboardingPresentationTests: XCTestCase {
    func testEmptyStateAndDraftInventoryAreExplicitAndAccessible() {
        let empty = ProjectOnboardingPresentation(project: nil)
        XCTAssertEqual(empty.emptyState?.title, "Welcome to Jarvis")
        XCTAssertEqual(empty.emptyState?.primaryAction, "Importer un repository")

        let draft = Project(
            id: "draft-1",
            name: "Example",
            status: .draft,
            moduleCount: 0,
            activeExecutions: nil)
        let presentation = ProjectOnboardingPresentation(project: draft)

        XCTAssertEqual(
            presentation.steps.map(\.title),
            ["Repository", "Workflow", "Connections", "Review"])
        XCTAssertEqual(
            presentation.steps.map(\.status),
            [.complete, .inProgress, .needsAction, .readyForReview])
        XCTAssertTrue(presentation.steps.allSatisfy { !$0.accessibilityLabel.isEmpty })
        XCTAssertTrue(presentation.reviewIsAccessible)
        XCTAssertFalse(presentation.canActivate)
    }

    func testCurrentStepPersistsWithoutRewritingUnknownStoredValues() {
        let suite = "ProjectOnboardingPresentationTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        let store = ProjectOnboardingNavigationStore(defaults: defaults)
        store.set(.review, for: "draft-1")
        XCTAssertEqual(
            ProjectOnboardingNavigationStore(defaults: defaults).currentStep(for: "draft-1"),
            .review)

        defaults.set("future-step", forKey: store.key(for: "draft-1"))
        XCTAssertEqual(store.currentStep(for: "draft-1"), .repository)
        XCTAssertEqual(defaults.string(forKey: store.key(for: "draft-1")), "future-step")
    }
}
