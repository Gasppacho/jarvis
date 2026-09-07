import Foundation
import JarvisAPI

/// Ticket #61: one row of the Project's durable Event journal
/// (`GET /v1/projects/{projectId}/events`, ticket #59).
public struct TimelineEvent: Identifiable, Sendable, Equatable, Hashable {
    public enum Kind: Sendable, Equatable, Hashable {
        case request
        case fact
    }

    public let id: String
    public let type: String
    public let kind: Kind
    public let occurredAt: Date
    public let producer: String
    public let correlationId: String
    /// The id of the Event that caused this one, when the engine reports one.
    public let causationId: String?
    public let subjectRef: String?

    init(
        id: String,
        type: String,
        kind: Kind,
        occurredAt: Date,
        producer: String,
        correlationId: String,
        causationId: String? = nil,
        subjectRef: String? = nil
    ) {
        self.id = id
        self.type = type
        self.kind = kind
        self.occurredAt = occurredAt
        self.producer = producer
        self.correlationId = correlationId
        self.causationId = causationId
        self.subjectRef = subjectRef
    }

    init(payload: Components.Schemas.EventSummary) {
        id = payload.id
        type = payload._type
        kind = Kind(payload: payload.kind)
        occurredAt = payload.occurredAt
        producer = payload.producer
        correlationId = payload.correlationId
        causationId = payload.causationId
        subjectRef = payload.subjectRef
    }
}

extension TimelineEvent.Kind {
    init(payload: Components.Schemas.EventSummary.kindPayload) {
        // Exhaustive, not `?? .fact`: a value added to the contract must break
        // this build rather than be silently mapped to something plausible.
        self =
            switch payload {
            case .request: .request
            case .fact: .fact
            }
    }
}

/// Ticket #61: one row of the Project's Execution Ledger
/// (`GET /v1/projects/{projectId}/executions`, ticket #59).
public struct TimelineExecution: Identifiable, Sendable, Equatable, Hashable {
    public enum Status: Sendable, Equatable, Hashable {
        case queued
        case running
        case cancelling
        case completed
        case failed
        case cancelled
        case timedOut
    }

    public let id: String
    public let projectId: String
    public let moduleInstanceId: String
    public let status: Status
    public let attempt: Int
    public let createdAt: Date
    public let completedAt: Date?
    /// Ticket #59: the Event that caused this Execution. Optional so a client
    /// relying on the pre-#59 shape still validates.
    public let inputEventId: String?
    /// Ticket #59: `inputEventId`'s Event's correlationId, so this Execution
    /// attaches to its Event's chain without guessing from timestamps or
    /// Module Instance.
    public let correlationId: String?

    init(
        id: String,
        projectId: String,
        moduleInstanceId: String,
        status: Status,
        attempt: Int,
        createdAt: Date,
        completedAt: Date? = nil,
        inputEventId: String? = nil,
        correlationId: String? = nil
    ) {
        self.id = id
        self.projectId = projectId
        self.moduleInstanceId = moduleInstanceId
        self.status = status
        self.attempt = attempt
        self.createdAt = createdAt
        self.completedAt = completedAt
        self.inputEventId = inputEventId
        self.correlationId = correlationId
    }

    init(payload: Components.Schemas.ExecutionSummary) {
        id = payload.id
        projectId = payload.projectId
        moduleInstanceId = payload.moduleInstanceId
        status = Status(payload: payload.status)
        attempt = payload.attempt
        createdAt = payload.createdAt
        completedAt = payload.completedAt
        inputEventId = payload.inputEventId
        correlationId = payload.correlationId
    }
}

extension TimelineExecution.Status {
    /// The label the Timeline shows for this state, reused by
    /// `ProjectTimelinePresentation`'s accessibility text so the visible pill
    /// and the announced label never drift apart.
    public var displayLabel: String {
        switch self {
        case .queued: "Queued"
        case .running: "Running"
        case .cancelling: "Cancelling"
        case .completed: "Completed"
        case .failed: "Failed"
        case .cancelled: "Cancelled"
        case .timedOut: "Timed out"
        }
    }

    init(payload: Components.Schemas.ExecutionSummary.statusPayload) {
        // Exhaustive, not `?? .queued`: a value added to the contract must
        // break this build rather than be silently mapped to something
        // plausible.
        self =
            switch payload {
            case .queued: .queued
            case .running: .running
            case .cancelling: .cancelling
            case .completed: .completed
            case .failed: .failed
            case .cancelled: .cancelled
            case .timed_hyphen_out: .timedOut
            }
    }
}
