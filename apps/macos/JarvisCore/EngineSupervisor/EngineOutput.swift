import Foundation

/// Collects the engine's two streams and hands out its first stdout line.
///
/// `@unchecked Sendable` with an explicit lock: the readability handlers fire on
/// arbitrary queues, so this cannot be actor-isolated, and the state it guards
/// is small enough to reason about directly.
final class EngineOutput: @unchecked Sendable {
    private let lock = NSLock()
    private var stdoutBuffer = ""
    private var stderrBuffer = ""
    private var firstLine: String?
    private var waiter: CheckedContinuation<String?, Never>?
    private var finished = false
    private var cancelled = false

    var stderrText: String {
        lock.withLock { stderrBuffer }
    }

    func appendStandardOutput(_ text: String) {
        let line: String? = lock.withLock {
            stdoutBuffer += text
            guard firstLine == nil, let newline = stdoutBuffer.firstIndex(of: "\n") else {
                return nil
            }
            firstLine = String(stdoutBuffer[stdoutBuffer.startIndex..<newline])
            return firstLine
        }
        if let line { resumeWaiter(with: line) }
    }

    func appendStandardError(_ text: String) {
        lock.withLock { stderrBuffer += text }
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
    func firstStandardOutputLine() async -> String? {
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                let immediate: String?? = lock.withLock {
                    if let firstLine { return .some(firstLine) }
                    if finished || cancelled { return .some(nil) }
                    waiter = continuation
                    return nil
                }
                if let immediate { continuation.resume(returning: immediate) }
            }
        } onCancel: {
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
