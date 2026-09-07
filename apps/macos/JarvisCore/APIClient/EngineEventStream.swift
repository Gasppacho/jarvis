import Foundation

/// Ticket #62: opens `/v1/stream` (ticket #60) on its own `URLSession` —
/// deliberately not `EngineClient`'s. Ordinary loopback REST calls keep their
/// five-second timeout; this stream session instead uses a five-minute
/// inactivity/resource safety limit because the Engine sends SSE comments
/// every 15 seconds while it is healthy. This type never touches
/// `EngineClient`'s session, so opening the stream cannot relax ordinary
/// calls or make them wait for a long-lived response.
///
/// Parses SSE frames itself (MACOS_APP.md: "un parseur dédié") rather than
/// through a generated decode step: the contract's response schema for this
/// operation is `type: string` (`text/event-stream`), so nothing decodes
/// `StreamMessage` for a caller automatically either way.
///
/// Uses a `URLSessionDataDelegate`, not the `bytes(for:)` convenience API:
/// against the real engine, `bytes(for:)` does not resolve its response
/// tuple until the server writes body bytes, even though the engine flushes
/// headers immediately on connect (`stream/routes.ts`'s `flushHeaders()`,
/// confirmed instant over the same loopback socket with `curl`) — a
/// connection that may sit open for minutes before the first Live Update
/// would otherwise read as hung. The delegate's `didReceive response:`
/// fires on headers alone, matching what the engine actually guarantees.
enum EngineEventStream {
    static func connect(port: Int, token: String) async throws -> AsyncThrowingStream<
        TimelineStreamMessage, Error
    > {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/v1/stream")!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")

        let delegate = StreamDelegate()
        // A fresh session with explicit stream timeouts. URLSession's
        // `timeoutIntervalForRequest` is an inactivity limit: it is reset by
        // received bytes and can terminate a quiet response mid-stream;
        // `timeoutIntervalForResource` is the overall safety limit. The
        // Engine probes healthy idle connections with an SSE comment every
        // 15 seconds (docs/contracts/LOCAL_API_V1.md,
        // docs/architecture/OBSERVABILITY.md), so five minutes is ample for
        // a healthy stream and still bounds a stream the Engine has genuinely
        // stopped keeping alive — the shell's reload-and-reconnect recovers
        // from that. A shared five-second REST session would be wrong here.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5 * 60
        configuration.timeoutIntervalForResource = 5 * 60
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        let task = session.dataTask(with: request)

        // Wired before `resume()`, so no chunk the delegate hands off can
        // ever arrive before something is listening for it.
        let stream = AsyncThrowingStream<TimelineStreamMessage, Error> { continuation in
            var buffer = Data()
            delegate.onData = { chunk in
                buffer.append(chunk)
                for line in Self.consumeLines(from: &buffer) {
                    guard let json = Self.dataPayload(fromLine: line) else { continue }
                    if let message = try? TimelineStreamMessage.decode(
                        fromDataLineJSON: Data(json.utf8))
                    {
                        continuation.yield(message)
                    }
                }
            }
            delegate.onComplete = { error in
                if let error {
                    continuation.finish(throwing: error)
                } else {
                    continuation.finish()
                }
            }
            // Fires on the consumer cancelling (AsyncThrowingStream observes
            // its awaiting Task's cancellation) as well as on normal/error
            // completion, so leaving the Timeline screen never leaves this
            // socket or its delegate behind.
            continuation.onTermination = { _ in
                task.cancel()
                session.invalidateAndCancel()
            }
        }

        let statusCode = try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Int, Error>) in
            delegate.onResponse = { result in continuation.resume(with: result) }
            task.resume()
        }

        switch statusCode {
        case 200:
            return stream
        case 401:
            session.invalidateAndCancel()
            throw EngineClientError.unauthorized(operation: "GET /v1/stream")
        case 403:
            session.invalidateAndCancel()
            throw EngineClientError.hostNotAllowed(operation: "GET /v1/stream")
        default:
            session.invalidateAndCancel()
            throw EngineClientError.unexpectedResponse("GET /v1/stream returned \(statusCode)")
        }
    }

    /// Drains every complete `\n`-terminated line currently in `buffer`,
    /// leaving a trailing partial line (if any) for the next chunk. A
    /// trailing `\r` (CRLF) is stripped.
    private static func consumeLines(from buffer: inout Data) -> [String] {
        var lines: [String] = []
        let newline: UInt8 = 0x0A
        while let index = buffer.firstIndex(of: newline) {
            let lineData = buffer[buffer.startIndex..<index]
            buffer.removeSubrange(buffer.startIndex...index)
            var line = String(decoding: lineData, as: UTF8.self)
            if line.hasSuffix("\r") { line.removeLast() }
            lines.append(line)
        }
        return lines
    }

    /// SSE framing (WHATWG "Server-sent events"): a `data:` line carries the
    /// event body. The contract emits exactly one per frame
    /// (`data: <StreamMessage JSON>\n\n`), so nothing else needs handling.
    private static func dataPayload(fromLine line: String) -> String? {
        guard line.hasPrefix("data:") else { return nil }
        let rest = line.dropFirst("data:".count)
        return String(rest.first == " " ? rest.dropFirst() : rest)
    }
}

/// Bridges `URLSessionDataDelegate`'s callback style to the closures
/// `connect()` wires up. `@unchecked Sendable`: `onData`/`onComplete` are
/// assigned once, before `task.resume()`, and never mutated afterward —
/// `resume()` happens-after that assignment on the calling thread, and
/// URLSession only invokes delegate methods after `resume()` — so no
/// concurrent access races the assignment. `onResponse` (assigned then
/// immediately consumed and cleared) is separately lock-guarded because it
/// is read from a delegate callback that can race the `didCompleteWithError`
/// callback for a connection that fails before ever receiving a response.
private final class StreamDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    var onData: ((Data) -> Void)?
    var onComplete: ((Error?) -> Void)?

    private let lock = NSLock()
    private var pendingResponse: ((Result<Int, Error>) -> Void)?

    var onResponse: ((Result<Int, Error>) -> Void)? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return pendingResponse
        }
        set {
            lock.lock()
            pendingResponse = newValue
            lock.unlock()
        }
    }

    func urlSession(
        _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        resolveResponse(.success(status))
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        onData?(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?)
    {
        if let error {
            // A connection that fails before ever receiving a response (e.g.
            // "connection refused") would otherwise leave `connect()`'s
            // `withCheckedThrowingContinuation` waiting forever.
            resolveResponse(.failure(error))
        }
        onComplete?(error)
    }

    private func resolveResponse(_ result: Result<Int, Error>) {
        let handler = onResponse
        onResponse = nil
        handler?(result)
    }
}
