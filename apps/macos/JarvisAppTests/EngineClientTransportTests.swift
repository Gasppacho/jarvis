import Foundation
import HTTPTypes
import Network
import OpenAPIRuntime
import XCTest

@testable import JarvisCore

/// Ticket #62 acceptance criterion: "Opening the stream does not change the
/// shared API transport's short request timeout for ordinary Local API
/// calls." `EngineEventStream` (this ticket) gets its own `URLSession`
/// entirely — it never touches `EngineClient`'s. This test proves
/// `EngineClient` itself still times out fast: a bare TCP listener on
/// loopback accepts the connection but never answers, so `health()` can only
/// return by way of `EngineClient.requestTimeout` (5 seconds) firing, not
/// `URLSession`'s 60-second default.
final class EngineClientTransportTests: XCTestCase {
    func testOrdinaryCallsStillTimeOutAtTheShortLoopbackTimeout() async throws {
        let listener = try XCTUnwrap(BlackHoleListener())
        defer { listener.stop() }

        let client = EngineClient(port: Int(listener.port), token: "unused-token")

        let started = Date()
        do {
            _ = try await client.health()
            XCTFail("a listener that never answers must not resolve health()")
        } catch {
            // Any thrown error is acceptable here — what this test proves is
            // *when* it throws, not which error URLSession surfaces for a
            // client-side timeout.
        }
        let elapsed = Date().timeIntervalSince(started)

        XCTAssertLessThan(
            elapsed, 15,
            "health() took \(elapsed)s — the 5-second EngineClient.requestTimeout appears to have been relaxed toward URLSession's 60-second default")
    }

    /// findings-review #62-1: the engine stamps every `occurredAt` with
    /// `new Date().toISOString()` — always three fractional digits — while
    /// the `Configuration` default transcoder (whole-second only) cannot
    /// parse that shape. Before `FlexibleISO8601DateTranscoder` was wired
    /// into the generated client, a REST answer from a running engine
    /// decoded to nothing: the regression lived below the seam this test
    /// injects.
    func testRestDecodingAcceptsTheEnginesFractionalSecondTimestamps() async throws {
        let responseJSON = """
            {
              "items": [
                {
                  "id": "evt-1",
                  "type": "scm.work-item.tag-added",
                  "version": 1,
                  "kind": "request",
                  "occurredAt": "2026-09-07T10:15:30.123Z",
                  "producer": "github-connector",
                  "correlationId": "corr-1",
                  "subjectRef": "issue-42"
                }
              ]
            }
            """

        let client = EngineClient(
            serverURL: URL(string: "http://127.0.0.1:1")!,
            transport: CannedTransport(
                status: .ok,
                contentType: "application/json",
                body: HTTPBody(Array(responseJSON.utf8))))

        let events = try await client.listProjectEvents(projectId: "proj-1")
        XCTAssertEqual(events.map(\.id), ["evt-1"])
        guard let first = events.first else { return }
        XCTAssertEqual(first.correlationId, "corr-1")
        XCTAssertEqual(first.occurredAt.timeIntervalSince1970, 1_788_776_130.123, accuracy: 0.001)
    }

    func testReplayDecodingPreservesTheExecutionError() async throws {
        let responseJSON = """
            {
              "id": "execution-replay",
              "projectId": "project-1",
              "moduleInstanceId": "development",
              "status": "failed",
              "attempt": 4,
              "createdAt": "2026-09-07T10:15:35.456Z",
              "completedAt": "2026-09-07T10:15:36.456Z",
              "inputEventId": "event-1",
              "error": "The replayed handler rejected the event.",
              "replayed": true
            }
            """

        let client = EngineClient(
            serverURL: URL(string: "http://127.0.0.1:1")!,
            transport: CannedTransport(
                status: .accepted,
                contentType: "application/json",
                body: HTTPBody(Array(responseJSON.utf8))))

        let execution = try await client.replayDeadLetter(deliveryId: "delivery-1")

        XCTAssertEqual(execution.status, .failed)
        XCTAssertEqual(execution.error, "The replayed handler rejected the event.")
    }
}

/// A canned Local API answer: the exact bytes the engine would write, with
/// no socket involved — the only way to assert the generated client's
/// decoding against the engine's own JSON without running the engine.
private struct CannedTransport: ClientTransport {
    let status: HTTPResponse.Status
    let contentType: String
    let body: HTTPBody

    func send(
        _ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String
    ) async throws -> (HTTPResponse, HTTPBody?) {
        let response = HTTPResponse(
            status: status,
            headerFields: [HTTPField.Name("Content-Type")!: contentType])
        return (response, self.body)
    }
}

/// A loopback TCP listener that accepts connections and never writes a byte
/// back — the simplest reliable way to make an HTTP call hang until its own
/// client-side timeout fires, without depending on real network conditions.
private final class BlackHoleListener {
    let port: UInt16
    private let listener: NWListener

    init?() {
        guard let listener = try? NWListener(using: .tcp, on: .any) else { return nil }
        self.listener = listener
        listener.newConnectionHandler = { connection in
            // Accept and hold — read nothing, write nothing.
            connection.start(queue: .global())
        }
        let ready = DispatchSemaphore(value: 0)
        let boundPort = PortBox()
        listener.stateUpdateHandler = { state in
            if case .ready = state, let port = listener.port?.rawValue {
                boundPort.value = port
                ready.signal()
            }
        }
        listener.start(queue: .global())
        guard ready.wait(timeout: .now() + 5) == .success, boundPort.value != 0 else {
            listener.cancel()
            return nil
        }
        port = boundPort.value
    }

    func stop() {
        listener.cancel()
    }
}

/// A lock-guarded slot, mirroring `EngineSupervisorTests.OutcomeBox`: the
/// listener's state handler and this initializer read/write it from
/// different isolation domains.
private final class PortBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: UInt16 = 0

    var value: UInt16 {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}
