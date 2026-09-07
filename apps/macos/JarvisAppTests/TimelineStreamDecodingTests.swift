import Foundation
import XCTest

@testable import JarvisCore

/// Ticket #62: `TimelineStreamMessage.decode(fromDataLineJSON:)` — the one
/// `data:` line of an SSE frame (`data: <StreamMessage JSON>\n\n`, ticket
/// #60) turned into the same domain types ticket #61's REST fetch produces.
/// Pure, synchronous, no networking.
final class TimelineStreamDecodingTests: XCTestCase {
    func testDecodesAnEventRecordedMessage() throws {
        let json = """
            {
              "sequence": 7,
              "type": "event.recorded",
              "occurredAt": "2024-01-01T00:00:00Z",
              "projectId": "proj-1",
              "sessionId": "session-1",
              "payload": {
                "id": "evt-1",
                "type": "scm.work-item.tag-added",
                "version": 1,
                "kind": "request",
                "occurredAt": "2024-01-01T00:00:00Z",
                "producer": "github-connector",
                "correlationId": "corr-1",
                "subjectRef": "issue-42"
              }
            }
            """

        let message = try XCTUnwrap(
            try TimelineStreamMessage.decode(fromDataLineJSON: Data(json.utf8)))

        XCTAssertEqual(message.sequence, 7)
        XCTAssertEqual(message.projectId, "proj-1")
        XCTAssertEqual(message.sessionId, "session-1")
        guard case .event(let event) = message.payload else {
            return XCTFail("expected an .event payload")
        }
        XCTAssertEqual(event.id, "evt-1")
        XCTAssertEqual(event.type, "scm.work-item.tag-added")
        XCTAssertEqual(event.kind, .request)
        XCTAssertEqual(event.producer, "github-connector")
        XCTAssertEqual(event.correlationId, "corr-1")
        XCTAssertEqual(event.subjectRef, "issue-42")
    }

    func testDecodesAnExecutionChangedMessage() throws {
        let json = """
            {
              "sequence": 8,
              "type": "execution.changed",
              "occurredAt": "2024-01-01T00:00:05Z",
              "projectId": "proj-1",
              "sessionId": "session-1",
              "payload": {
                "id": "exe-1",
                "projectId": "proj-1",
                "moduleInstanceId": "development",
                "status": "running",
                "attempt": 2,
                "createdAt": "2024-01-01T00:00:05Z"
              }
            }
            """

        let message = try XCTUnwrap(
            try TimelineStreamMessage.decode(fromDataLineJSON: Data(json.utf8)))

        XCTAssertEqual(message.sequence, 8)
        guard case .execution(let execution) = message.payload else {
            return XCTFail("expected an .execution payload")
        }
        XCTAssertEqual(execution.id, "exe-1")
        XCTAssertEqual(execution.status, .running)
        XCTAssertEqual(execution.attempt, 2)
        XCTAssertEqual(execution.moduleInstanceId, "development")
    }

    func testUnrecognizedMessageTypeDecodesToNilRatherThanThrowing() throws {
        // OBSERVABILITY.md documents more message types
        // (`system.health-changed`, `project.status-changed`, …) this ticket
        // does not consume. One reaching a shell that only understands the
        // two ticket #60 emits must not fail the whole connection.
        let json = """
            {
              "sequence": 9,
              "type": "system.health-changed",
              "occurredAt": "2024-01-01T00:00:10Z",
              "payload": {}
            }
            """

        let message = try TimelineStreamMessage.decode(fromDataLineJSON: Data(json.utf8))

        XCTAssertNil(message)
    }
}
