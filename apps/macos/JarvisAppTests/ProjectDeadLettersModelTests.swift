import Foundation
import XCTest

@testable import JarvisCore

@MainActor
final class ProjectDeadLettersModelTests: XCTestCase {
    private let createdAt = Date(timeIntervalSince1970: 1_700_000_000)

    func testRefreshKeepsRowsScopedToEachProject() async {
        let projectOne = makeDeadLetter(deliveryId: "delivery-1", projectId: "project-1")
        let projectTwo = makeDeadLetter(deliveryId: "delivery-2", projectId: "project-2")
        let model = ProjectDeadLettersModel(
            api: FakeDeadLettersAPI(
                lists: ["project-1": [projectOne], "project-2": [projectTwo]]))

        await model.refresh(projectId: "project-1")
        await model.refresh(projectId: "project-2")

        XCTAssertEqual(model.state(for: "project-1").deadLetters, [projectOne])
        XCTAssertEqual(model.state(for: "project-2").deadLetters, [projectTwo])
    }

    func testEmptyProjectIsDistinctFromUnavailableEngine() async {
        let empty = ProjectDeadLettersModel(api: FakeDeadLettersAPI(lists: ["project-1": []]))
        await empty.refresh(projectId: "project-1")
        XCTAssertTrue(empty.state(for: "project-1").deadLetters.isEmpty)
        XCTAssertNil(empty.state(for: "project-1").errorMessage)

        let unavailable = ProjectDeadLettersModel(
            api: FakeDeadLettersAPI(
                listError: .engineError(
                    operation: "GET /v1/projects/project-1/dead-letters",
                    code: "engine.database-unavailable",
                    message: "The database is suspended.")))
        await unavailable.refresh(projectId: "project-1")
        XCTAssertTrue(unavailable.state(for: "project-1").deadLetters.isEmpty)
        XCTAssertEqual(
            unavailable.state(for: "project-1").errorMessage,
            "The database is suspended. (engine.database-unavailable)")
    }

    func testSuccessfulReplayRemovesTheRowAndCallsTheDeliveryOperation() async {
        let deadLetter = makeDeadLetter(deliveryId: "delivery-1", projectId: "project-1")
        let api = FakeDeadLettersAPI(lists: ["project-1": [deadLetter]])
        let model = ProjectDeadLettersModel(api: api)
        await model.refresh(projectId: "project-1")

        let replayed = await model.replay(projectId: "project-1", deliveryId: deadLetter.deliveryId)
        let replayedDeliveryIDs = await api.replayedDeliveryIDs

        XCTAssertTrue(replayed)
        XCTAssertTrue(model.state(for: "project-1").deadLetters.isEmpty)
        XCTAssertEqual(replayedDeliveryIDs, ["delivery-1"])
    }

    func testFailedReplayKeepsTheRowAndSurfacesTheExecutionError() async {
        let deadLetter = makeDeadLetter(deliveryId: "delivery-1", projectId: "project-1")
        let model = ProjectDeadLettersModel(
            api: FakeDeadLettersAPI(
                lists: ["project-1": [deadLetter]],
                replayResult: makeExecution(
                    status: .failed,
                    error: "The replayed handler rejected the event.")))
        await model.refresh(projectId: "project-1")

        let replayed = await model.replay(projectId: "project-1", deliveryId: deadLetter.deliveryId)

        XCTAssertFalse(replayed)
        XCTAssertEqual(model.state(for: "project-1").deadLetters, [deadLetter])
        XCTAssertEqual(
            model.state(for: "project-1").replayErrorMessages[deadLetter.deliveryId],
            "Replay execution execution-replay ended with failed: The replayed handler rejected the event.")
    }

    func testCancelledAndTimedOutReplayKeepTheRowAndUseTheDeadLetterMessage() async {
        for status in [TimelineExecution.Status.cancelled, .timedOut] {
            let deadLetter = makeDeadLetter(deliveryId: "delivery-\(status)", projectId: "project-1")
            let model = ProjectDeadLettersModel(
                api: FakeDeadLettersAPI(
                    lists: ["project-1": [deadLetter]],
                    replayResult: makeExecution(status: status)))
            await model.refresh(projectId: "project-1")

            let replayed = await model.replay(
                projectId: "project-1", deliveryId: deadLetter.deliveryId)

            XCTAssertFalse(replayed)
            XCTAssertEqual(model.state(for: "project-1").deadLetters, [deadLetter])
            XCTAssertEqual(
                model.state(for: "project-1").replayErrorMessages[deadLetter.deliveryId],
                "Replay execution execution-replay ended with \(status.displayLabel.lowercased()): The provider did not answer.")
        }
    }

    private func makeExecution(
        status: TimelineExecution.Status,
        error: String? = nil
    ) -> TimelineExecution {
        TimelineExecution(
            id: "execution-replay",
            projectId: "project-1",
            moduleInstanceId: "development",
            status: status,
            attempt: 4,
            createdAt: createdAt,
            error: error)
    }

    private func makeDeadLetter(deliveryId: String, projectId: String) -> DeadLetter {
        DeadLetter(
            deliveryId: deliveryId,
            projectId: projectId,
            eventId: "event-\(deliveryId)",
            moduleInstanceId: "development",
            code: "provider.unavailable",
            message: "The provider did not answer.",
            attempts: 3,
            lastExecutionId: "execution-\(deliveryId)",
            createdAt: createdAt)
    }
}

private actor FakeDeadLettersAPI: DeadLettersAPI {
    let lists: [String: [DeadLetter]]
    let listError: EngineClientError?
    let replayResult: TimelineExecution
    private(set) var replayedDeliveryIDs: [String] = []

    init(
        lists: [String: [DeadLetter]] = [:],
        listError: EngineClientError? = nil,
        replayResult: TimelineExecution = TimelineExecution(
            id: "execution-replay",
            projectId: "project-1",
            moduleInstanceId: "development",
            status: .completed,
            attempt: 4,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000))
    ) {
        self.lists = lists
        self.listError = listError
        self.replayResult = replayResult
    }

    func listProjectDeadLetters(projectId: String) async throws -> [DeadLetter] {
        if let listError { throw listError }
        return lists[projectId] ?? []
    }

    func replayDeadLetter(deliveryId: String) async throws -> TimelineExecution {
        replayedDeliveryIDs.append(deliveryId)
        return replayResult
    }
}
