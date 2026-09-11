import Foundation
import XCTest

@testable import JarvisCore

/// Ticket #62: `TimelineStreamMessage.decode(fromDataLineJSON:)` — the one
/// `data:` line of an SSE frame (`data: <StreamMessage JSON>\n\n`, ticket
/// #60) turned into the same domain types ticket #61's REST fetch produces.
/// Pure, synchronous, no networking.
///
/// The fixture timestamps carry three fractional seconds — the exact shape
/// `new Date().toISOString()` produces, which is what the engine stamps on
/// every `occurredAt`. The whole-second form the contract's examples use
/// stays legal too: `date-time` is RFC 3339, and the pinned runtime's two
/// built-in transcoders each accept exactly one of the two forms, which is
/// why the client carries its own (see `FlexibleISO8601DateTranscoder`).
final class TimelineStreamDecodingTests: XCTestCase {
    func testDecodesAnEventRecordedMessage() throws {
        let json = """
            {
              "sequence": 7,
              "type": "event.recorded",
              "occurredAt": "2026-09-07T10:15:30.123Z",
              "projectId": "proj-1",
              "sessionId": "session-1",
              "payload": {
                "id": "evt-1",
                "type": "scm.work-item.tag-added",
                "version": 1,
                "kind": "request",
                "occurredAt": "2026-09-07T10:15:30.123Z",
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
              "occurredAt": "2026-09-07T10:15:35.456Z",
              "projectId": "proj-1",
              "sessionId": "session-1",
              "payload": {
                "id": "exe-1",
                "projectId": "proj-1",
                "moduleInstanceId": "development",
                "status": "running",
                "attempt": 2,
                "replayed": false,
                "createdAt": "2026-09-07T10:15:35.456Z"
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
              "occurredAt": "2026-09-07T10:15:40.789Z",
              "payload": {}
            }
            """

        let message = try TimelineStreamMessage.decode(fromDataLineJSON: Data(json.utf8))

        XCTAssertNil(message)
    }

    func testDecodesBothTheEnginesFractionalAndTheContractsWholeSecondForms() throws {
        // The contract's `date-time` is RFC 3339 and allows both
        // "2024-01-01T00:00:00Z" (examples, fixtures) and
        // "2024-01-01T00:00:00.000Z" (the engine's `toISOString()`) — and
        // both must decode to the same instant.
        let fractional = """
            {"sequence": 10, "type": "event.recorded",
             "occurredAt": "2024-01-01T00:00:00.000Z",
             "projectId": "proj-1", "sessionId": "session-1",
             "payload": {"id": "evt-1", "type": "scm.work-item.tag-added",
                         "version": 1, "kind": "request",
                         "occurredAt": "2024-01-01T00:00:00.000Z",
                         "producer": "p", "correlationId": "corr-1"}}
            """
        let wholeSecond = """
            {"sequence": 10, "type": "event.recorded",
             "occurredAt": "2024-01-01T00:00:00Z",
             "projectId": "proj-1", "sessionId": "session-1",
             "payload": {"id": "evt-1", "type": "scm.work-item.tag-added",
                         "version": 1, "kind": "request",
                         "occurredAt": "2024-01-01T00:00:00Z",
                         "producer": "p", "correlationId": "corr-1"}}
            """

        let expected = Date(timeIntervalSince1970: 1_704_067_200)
        let a = try XCTUnwrap(try TimelineStreamMessage.decode(fromDataLineJSON: Data(fractional.utf8)))
        let b = try XCTUnwrap(try TimelineStreamMessage.decode(fromDataLineJSON: Data(wholeSecond.utf8)))
        guard case .event(let ea) = a.payload, case .event(let eb) = b.payload else {
            return XCTFail("expected .event payloads")
        }
        XCTAssertEqual(ea.occurredAt, expected)
        XCTAssertEqual(eb.occurredAt, expected)
    }
}
