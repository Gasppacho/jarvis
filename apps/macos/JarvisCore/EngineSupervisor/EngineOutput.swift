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

    var stderrText: String {
        lock.withLock { stderrBuffer }
    }

    func appendStandardOutput(_ text: String) {
        let resumeWith: String? = lock.withLock {
            guard firstLine == nil else {
                stdoutBuffer += text
                return nil
            }
            stdoutBuffer += text
            guard let newline = stdoutBuffer.firstIndex(of: "\n") else { return nil }
            let line = String(stdoutBuffer[stdoutBuffer.startIndex..<newline])
            firstLine = line
            return takeWaiter(resolving: line)
        }
        if let resumeWith { resumeContinuation(with: resumeWith) }
    }

    func appendStandardError(_ text: String) {
        lock.withLock { stderrBuffer += text }
    }

    /// Called when the process ends: unblocks a waiter that will never get a line.
    func finish() {
        let hadWaiter: Bool = lock.withLock {
            finished = true
            return waiter != nil
        }
        if hadWaiter { resumeContinuation(with: nil) }
    }

    /// The engine's single stdout line, or nil if it exited without writing one.
    func firstStandardOutputLine() async -> String? {
        await withCheckedContinuation { continuation in
            let immediate: String?? = lock.withLock {
                if let firstLine { return .some(firstLine) }
                if finished { return .some(nil) }
                waiter = continuation
                return nil
            }
            if let immediate { continuation.resume(returning: immediate) }
        }
    }

    // MARK: - Continuation plumbing

    private func takeWaiter(resolving line: String) -> String? {
        guard waiter != nil else { return nil }
        return line
    }

    private func resumeContinuation(with value: String?) {
        let continuation: CheckedContinuation<String?, Never>? = lock.withLock {
            defer { waiter = nil }
            return waiter
        }
        continuation?.resume(returning: value)
    }
}
