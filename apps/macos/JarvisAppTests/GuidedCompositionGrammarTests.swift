import XCTest

@testable import JarvisCore

final class GuidedCompositionGrammarTests: XCTestCase {
    func testSelectedGrammarPresentsEveryCompositionStageForTheSharedFixtures() {
        let inventories = SharedCompositionFixtures.all.map(GuidedCompositionInventory.init)

        XCTAssertEqual(
            inventories.map { $0.sections.map(\.stage) },
            Array(repeating: GuidedCompositionStage.allCases, count: 4))
        XCTAssertEqual(inventories.map(\.fixtureState), [.fresh, .valid, .orphaned, .ambiguous])
        XCTAssertTrue(
            inventories.allSatisfy { inventory in
                inventory.rows.allSatisfy {
                    !$0.accessibility.label.isEmpty && !$0.accessibility.hint.isEmpty
                }
            })
        XCTAssertTrue(
            inventories[0].rows.contains {
                $0.action == .chooseStartingPoint && $0.status == .needsAttention
            })
        XCTAssertTrue(
            inventories[2].rows.contains {
                $0.id == "event-development-requested" &&
                    $0.title == "When a work item is ready, request implementation" &&
                    $0.detail.contains("No enabled consumer") &&
                    $0.action == .repairEvent("development.implementation.requested.v1")
            })
        XCTAssertTrue(
            inventories[3].rows.contains {
                $0.id == "event-development-requested" &&
                    $0.detail.contains("More than one enabled consumer") &&
                    $0.status == .blocked
            })
    }

    func testSelectedGrammarPreservesDraftInputAndExposesStableKeyboardAndVoiceOverOrder() {
        let orphaned = GuidedCompositionInventory(fixture: SharedCompositionFixtures.orphaned)

        XCTAssertEqual(orphaned.grammar, .guidedStages)
        XCTAssertEqual(
            orphaned.sections.map(\.title),
            ["Starting point", "Module Instances", "Automation Rules", "Resources", "Review"])
        XCTAssertEqual(orphaned.rows.map(\.keyboardOrder), Array(orphaned.rows.indices))
        XCTAssertEqual(
            orphaned.rows.first { $0.id == "event-development-requested" }?.title,
            "When a work item is ready, request implementation")
        XCTAssertEqual(
            orphaned.rows.first { $0.id == "resource-agent-runtime" }?.accessibility.value,
            "Unbound; 0 eligible choices")
        XCTAssertEqual(
            orphaned.rows.first { $0.id == "review-draft" }?.accessibility.value,
            "Needs attention")
        XCTAssertEqual(SharedCompositionFixtures.all.map(\.apiVersion), [
            "jarvis.dev/project-composition-choices/v1",
            "jarvis.dev/project-composition-choices/v1",
            "jarvis.dev/project-composition-choices/v1",
            "jarvis.dev/project-composition-choices/v1",
        ])
    }
}

private enum SharedCompositionFixtures {
    static let fresh = GuidedCompositionFixture(
        state: .fresh,
        projectName: "Fresh Project",
        startingPoint: nil,
        moduleInstances: [],
        eventChoices: [],
        resourceBindings: [])

    static let valid = GuidedCompositionFixture(
        state: .valid,
        projectName: "Valid Project",
        startingPoint: "GitHub Development",
        moduleInstances: [
            .init(instanceId: "github", displayName: "GitHub", enabled: true),
            .init(instanceId: "development", displayName: "Development", enabled: true),
        ],
        eventChoices: [
            .init(
                id: "development.implementation.requested.v1",
                draftSentence: "When a work item is ready, request implementation",
                kind: .request,
                routing: .resolved,
                routingExplanation: "Exactly one enabled consumer: development.")
        ],
        resourceBindings: [
            .init(
                slotId: "agent-runtime",
                displayName: "Agent Runtime",
                selectedCandidate: "Local Codex",
                eligibleCandidateCount: 1)
        ])

    static let orphaned = GuidedCompositionFixture(
        state: .orphaned,
        projectName: "Orphaned Project",
        startingPoint: "Custom",
        moduleInstances: [
            .init(instanceId: "rules", displayName: "Automation Rules", enabled: true)
        ],
        eventChoices: [
            .init(
                id: "development.implementation.requested.v1",
                draftSentence: "When a work item is ready, request implementation",
                kind: .request,
                routing: .orphaned,
                routingExplanation: "No enabled consumer can receive this Request.")
        ],
        resourceBindings: [
            .init(
                slotId: "agent-runtime",
                displayName: "Agent Runtime",
                selectedCandidate: nil,
                eligibleCandidateCount: 0)
        ])

    static let ambiguous = GuidedCompositionFixture(
        state: .ambiguous,
        projectName: "Ambiguous Project",
        startingPoint: "Custom",
        moduleInstances: [
            .init(instanceId: "development-a", displayName: "Development A", enabled: true),
            .init(instanceId: "development-b", displayName: "Development B", enabled: true),
        ],
        eventChoices: [
            .init(
                id: "development.implementation.requested.v1",
                draftSentence: "When a work item is ready, request implementation",
                kind: .request,
                routing: .ambiguous,
                routingExplanation: "More than one enabled consumer can receive this Request.")
        ],
        resourceBindings: [])

    static let all = [fresh, valid, orphaned, ambiguous]
}
