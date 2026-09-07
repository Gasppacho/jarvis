import Foundation
import Network
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
