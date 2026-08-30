import Foundation

/// Collects the engine's two streams and hands out its first stdout line.
///
/// `@unchecked Sendable` with an explicit lock: the readability handlers fire on
/// arbitrary queues, so this cannot be actor-isolated, and the state it guards
/// is small enough to reason about directly.
final class EngineOutput: @unchecked Sendable {
    private static let newline = UInt8(ascii: "\n")
    /// The buffers exist to explain a startup failure, not to archive a
    /// session: the engine logs every HTTP request to stderr, so an uncapped
    /// buffer grows with request volume for as long as the app runs.
    private static let maximumBufferedBytes = 64 * 1024

    private let lock = NSLock()
    /// Bytes, not String: `availableData` can split a multi-byte UTF-8 sequence
    /// at a read boundary, and decoding per chunk would drop the whole chunk —
    /// including, on stdout, the handshake line itself.
    private var stdoutBytes = Data()
    private var stderrBytes = Data()
    private var firstLine: String?
    private var waiter: CheckedContinuation<String?, Never>?
    private var finished = false
    private var cancelled = false

    var stderrText: String {
        lock.withLock { String(decoding: stderrBytes, as: UTF8.self) }
    }

    func appendStandardOutput(_ data: Data) {
        let line: String? = lock.withLock {
            stdoutBytes.append(data)
            Self.trim(&stdoutBytes)
            guard firstLine == nil, let newline = stdoutBytes.firstIndex(of: Self.newline) else {
                return nil
            }
            firstLine = String(decoding: stdoutBytes[stdoutBytes.startIndex..<newline], as: UTF8.self)
            return firstLine
        }
        if let line { resumeWaiter(with: line) }
    }

    func appendStandardError(_ data: Data) {
        lock.withLock {
            stderrBytes.append(data)
            Self.trim(&stderrBytes)
        }
    }

    /// Keeps the tail: the last thing the engine said before dying is the part
    /// that explains why.
    private static func trim(_ buffer: inout Data) {
        guard buffer.count > maximumBufferedBytes else { return }
        buffer.removeFirst(buffer.count - maximumBufferedBytes)
    }

    /// Called when the process ends: unblocks a waiter that will never get a line.
    func finish() {
        lock.withLock { finished = true }
        resumeWaiter(with: nil)
    }

    /// The engine's single stdout line; nil if it exited or the wait was
    /// cancelled before one arrived.
    ///
    /// Cancellation-aware on purpose: the caller races this against a timeout,
    /// and a plain `withCheckedContinuation` would leave the losing child task
    /// parked forever — which kept `withTaskGroup` from ever returning.
    ///
    /// One waiter at a time. A second concurrent caller would orphan the first
    /// continuation, so it is resumed rather than dropped.
    func firstStandardOutputLine() async -> String? {
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                let outcome: (immediate: String??, displaced: CheckedContinuation<String?, Never>?) =
                    lock.withLock {
                        if let firstLine { return (.some(firstLine), nil) }
                        if finished || cancelled { return (.some(nil), nil) }
                        let displaced = waiter
                        waiter = continuation
                        return (nil, displaced)
                    }
                outcome.displaced?.resume(returning: nil)
                if let immediate = outcome.immediate { continuation.resume(returning: immediate) }
            }
        } onCancel: {
            // Set under the lock, and read in the same critical section that
            // installs the continuation: otherwise a cancellation arriving first
            // finds no waiter and the operation then parks one forever.
            lock.withLock { cancelled = true }
            resumeWaiter(with: nil)
        }
    }

    /// Resumes at most once: the continuation is taken under the lock, so a
    /// line, a process exit and a cancellation racing each other cannot double-resume.
    private func resumeWaiter(with value: String?) {
        let continuation: CheckedContinuation<String?, Never>? = lock.withLock {
            defer { waiter = nil }
            return waiter
        }
        continuation?.resume(returning: value)
    }
}
