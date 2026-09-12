import Foundation

/// Pure presentation rules for the execution detail. Keeping these rules out
/// of SwiftUI makes every lifecycle state testable without a running Engine.
public struct ProjectExecutionDetailPresentation: Sendable, Equatable {
    public enum State: Sendable, Equatable {
        case loading
        case loaded(ProjectExecutionDetail)
        case stale(ProjectExecutionDetail, String)
        case failed(String)
    }

    public let state: State
    public let connectionLabel: String
    public let connectionSymbol: String
    public let isSnapshot: Bool

    public init(
        _ snapshot: ProjectExecutionDetailState,
        connection: TimelineConnectionState
    ) {
        if let detail = snapshot.detail {
            state = snapshot.errorMessage.map { .stale(detail, $0) } ?? .loaded(detail)
        } else if snapshot.isLoading {
            state = .loading
        } else {
            state = .failed(snapshot.errorMessage ?? "No execution detail is available yet.")
        }
        switch connection {
        case .live:
            connectionLabel = "Live"
            connectionSymbol = "dot.radiowaves.left.and.right"
            isSnapshot = false
        case .reconnecting:
            connectionLabel = "Reconnecting…"
            connectionSymbol = "arrow.triangle.2.circlepath"
            isSnapshot = true
        case .failed:
            connectionLabel = "Snapshot précédent"
            connectionSymbol = "clock.arrow.circlepath"
            isSnapshot = true
        }
    }

    public static func executionStatusLabel(_ status: ProjectExecutionDetail.ExecutionStatus) -> String {
        switch status {
        case .queued: "Queued"
        case .running: "Running"
        case .cancelling: "Cancelling"
        case .completed: "Completed"
        case .failed: "Failed"
        case .cancelled: "Cancelled"
        case .timedOut: "Timed out"
        }
    }

    public static func stepStatusLabel(_ status: ProjectExecutionDetail.Step.Status) -> String {
        switch status {
        case .proved: "Confirmed"
        case .active: "In progress"
        case .failed: "Failed"
        case .cancelled: "Cancelled"
        case .unavailable: "Information indisponible"
        }
    }

    public static func checkStatusLabel(_ status: ProjectExecutionDetail.Check.Status) -> String {
        switch status {
        case .passed: "Passed"
        case .failed: "Failed"
        case .unavailable: "Information indisponible"
        }
    }

    public func currentExecution(_ detail: ProjectExecutionDetail) -> ProjectExecutionDetail.Execution? {
        detail.executions.max { left, right in
            if left.createdAt == right.createdAt { return left.id < right.id }
            return left.createdAt < right.createdAt
        }
    }
}
