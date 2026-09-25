import Foundation
import JarvisAPI

/// Ticket #200: a bounded, user-oriented snapshot. The wire payload is
/// converted once here so views do not depend on generated OpenAPI spelling.
public struct ProjectExecutionDetail: Sendable, Equatable {
    public struct WorkItem: Sendable, Equatable {
        public let ref: String
        public let title: String?
        public let issueNumber: Int?
        public let repositoryId: String?
    }

    public enum ExecutionStatus: String, Sendable, Equatable {
        case queued, running, cancelling, completed, failed, cancelled
        case timedOut = "timed-out"
    }

    public struct Execution: Identifiable, Sendable, Equatable {
        public let id: String
        public let moduleInstanceId: String
        public let status: ExecutionStatus
        public let attempt: Int
        public let createdAt: Date
        public let error: String?
        public let completedAt: Date?
        public let inputEventId: String
        public let durationMs: Int?
    }

    public struct Step: Identifiable, Sendable, Equatable {
        public enum ID: String, Sendable, Equatable {
            case issueReceived = "issue-received"
            case eligibilityConfirmed = "eligibility-confirmed"
            case workspacePrepared = "workspace-prepared"
            case agentRunning = "agent-running"
            case checks
            case commitPush = "commit-push"
            case pullRequestPreparation = "pull-request-preparation"
            case pullRequest = "pull-request"
        }

        public enum Status: String, Sendable, Equatable {
            case proved, active, repairing, failed, cancelled, unavailable
            case notStarted = "not-started"
        }

        public let id: ID
        public let label: String
        public let status: Status
        public let occurredAt: Date?
        public let completedAt: Date?
        public let executionId: String?
        public let detail: String
    }

    public struct Check: Identifiable, Sendable, Equatable {
        public enum Status: String, Sendable, Equatable {
            case passed, running, failed, cancelled, unavailable
        }

        public var id: String { "\(name):\(executionId ?? "unavailable"):\(attempt)" }
        public let name: String
        public let attempt: Int
        public let status: Status
        public let durationMs: Int?
        public let startedAt: Date?
        public let completedAt: Date?
        public let output: String?
        public let executionId: String?
    }

    public var lastActivityAt: Date? {
        (steps.flatMap { [$0.occurredAt, $0.completedAt].compactMap { $0 } }
            + agentExcerpts.map(\.occurredAt)
            + [lastEvent?.occurredAt].compactMap { $0 }).max()
    }

    public struct AgentExcerpt: Identifiable, Sendable, Equatable {
        public var id: String { "\(executionId):\(occurredAt.timeIntervalSince1970):\(text)" }
        public let occurredAt: Date
        public let executionId: String
        public let text: String
        public let truncated: Bool
    }

    public struct Workspace: Sendable, Equatable {
        public let path: String
        public let repositoryId: String
        public let branch: String
        public let baseRevisionSha: String
        public let status: String
        public let executionId: String
    }

    public struct Artifact: Identifiable, Sendable, Equatable {
        public var id: String { ref }
        public let ref: String
        public let label: String
    }

    public struct PullRequest: Sendable, Equatable {
        public let ref: String
        public let number: Int?
        public let title: String?
        public let url: String?
        public let repositoryId: String?
    }

    public struct Event: Identifiable, Sendable, Equatable {
        public let id: String
        public let type: String
        public let occurredAt: Date
        public let producer: String
        public let correlationId: String
        public let causationId: String?
        public let subjectRef: String?
        public let payloadExcerpt: String
    }

    public struct Technical: Sendable, Equatable {
        public let inputEventIds: [String]
        public let correlationId: String?
        public let causationIds: [String]
        public let events: [Event]
    }

    public struct Failure: Sendable, Equatable {
        public let code: String
        public let message: String
        public let retryable: Bool
        public let impact: String
        public let nextAction: String
        public let stepId: Step.ID?
    }

    public let projectId: String
    public let correlationId: String?
    public let workItem: WorkItem?
    public let executions: [Execution]
    public let steps: [Step]
    public let checks: [Check]
    public let agentExcerpts: [AgentExcerpt]
    public let workspace: Workspace?
    public let artifacts: [Artifact]?
    public let pullRequest: PullRequest?
    public let lastEvent: Event?
    public let technical: Technical
    public let failure: Failure?
    public let retryDeliveryId: String?
    public let cancellableExecutionId: String?

    public init(
        projectId: String,
        correlationId: String?,
        workItem: WorkItem?,
        executions: [Execution],
        steps: [Step],
        checks: [Check],
        agentExcerpts: [AgentExcerpt],
        workspace: Workspace?,
        artifacts: [Artifact]?,
        pullRequest: PullRequest?,
        lastEvent: Event?,
        technical: Technical,
        failure: Failure?,
        retryDeliveryId: String?,
        cancellableExecutionId: String?
    ) {
        self.projectId = projectId
        self.correlationId = correlationId
        self.workItem = workItem
        self.executions = executions
        self.steps = steps
        self.checks = checks
        self.agentExcerpts = agentExcerpts
        self.workspace = workspace
        self.artifacts = artifacts
        self.pullRequest = pullRequest
        self.lastEvent = lastEvent
        self.technical = technical
        self.failure = failure
        self.retryDeliveryId = retryDeliveryId
        self.cancellableExecutionId = cancellableExecutionId
    }

    init(payload: Components.Schemas.ExecutionDetailV1) {
        projectId = payload.projectId
        correlationId = payload.correlationId
        workItem = payload.workItem.map {
            WorkItem(ref: $0.ref, title: $0.title, issueNumber: $0.issueNumber, repositoryId: $0.repositoryId)
        }
        executions = payload.executions.map(Execution.init(payload:))
        steps = payload.steps.map(Step.init(payload:))
        checks = payload.checks.map(Check.init(payload:))
        agentExcerpts = payload.agentExcerpts.map(AgentExcerpt.init(payload:))
        workspace = payload.workspace.map(Workspace.init(payload:))
        artifacts = payload.artifacts?.map(Artifact.init(payload:))
        pullRequest = payload.pullRequest.map(PullRequest.init(payload:))
        lastEvent = payload.lastEvent.map(Event.init(payload:))
        technical = Technical(payload: payload.technical)
        failure = payload.failure.map(Failure.init(payload:))
        retryDeliveryId = payload.retryDeliveryId
        cancellableExecutionId = payload.cancellableExecutionId
    }
}

extension ProjectExecutionDetail.Execution {
    init(payload: Components.Schemas.ExecutionDetailExecution) {
        id = payload.id
        moduleInstanceId = payload.moduleInstanceId
        status = Self.status(payload.status)
        attempt = payload.attempt
        createdAt = payload.createdAt
        error = payload.error
        completedAt = payload.completedAt
        inputEventId = payload.inputEventId
        durationMs = payload.durationMs
    }

    private static func status(
        _ value: Components.Schemas.ExecutionDetailExecution.statusPayload
    ) -> ProjectExecutionDetail.ExecutionStatus {
        switch value {
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

extension ProjectExecutionDetail.Step {
    init(payload: Components.Schemas.ExecutionDetailStep) {
        id = Self.id(payload.id)
        label = payload.label
        status = Self.status(payload.status)
        occurredAt = payload.occurredAt
        completedAt = payload.completedAt
        executionId = payload.executionId
        detail = payload.detail
    }

    private static func id(
        _ value: Components.Schemas.ExecutionDetailStep.idPayload
    ) -> ID {
        switch value {
        case .issue_hyphen_received: .issueReceived
        case .eligibility_hyphen_confirmed: .eligibilityConfirmed
        case .workspace_hyphen_prepared: .workspacePrepared
        case .agent_hyphen_running: .agentRunning
        case .checks: .checks
        case .commit_hyphen_push: .commitPush
        case .pull_hyphen_request_hyphen_preparation: .pullRequestPreparation
        case .pull_hyphen_request: .pullRequest
        }
    }

    private static func status(
        _ value: Components.Schemas.ExecutionDetailStep.statusPayload
    ) -> Status {
        switch value {
        case .proved: .proved
        case .active: .active
        case .repairing: .repairing
        case .not_hyphen_started: .notStarted
        case .failed: .failed
        case .cancelled: .cancelled
        case .unavailable: .unavailable
        }
    }
}

extension ProjectExecutionDetail.Check {
    init(payload: Components.Schemas.ExecutionDetailCheck) {
        name = payload.name
        attempt = payload.attempt
        status = switch payload.status {
        case .passed: .passed
        case .running: .running
        case .failed: .failed
        case .cancelled: .cancelled
        case .unavailable: .unavailable
        }
        durationMs = payload.durationMs
        startedAt = payload.startedAt
        completedAt = payload.completedAt
        output = payload.output
        executionId = payload.executionId
    }
}

extension ProjectExecutionDetail.AgentExcerpt {
    init(payload: Components.Schemas.ExecutionDetailAgentExcerpt) {
        occurredAt = payload.occurredAt
        executionId = payload.executionId
        text = payload.text
        truncated = payload.truncated
    }
}

extension ProjectExecutionDetail.Workspace {
    init(payload: Components.Schemas.ExecutionDetailV1.workspacePayload) {
        path = payload.path
        repositoryId = payload.repositoryId
        branch = payload.branch
        baseRevisionSha = payload.baseRevisionSha
        status = payload.status.rawValue
        executionId = payload.executionId
    }

}

extension ProjectExecutionDetail.Artifact {
    init(payload: Components.Schemas.ExecutionDetailArtifact) {
        ref = payload.ref
        label = payload.label
    }
}

extension ProjectExecutionDetail.PullRequest {
    init(payload: Components.Schemas.ExecutionDetailV1.pullRequestPayload) {
        ref = payload.ref
        number = payload.number
        title = payload.title
        url = payload.url
        repositoryId = payload.repositoryId
    }

}

extension ProjectExecutionDetail.Event {
    init(payload: Components.Schemas.ExecutionDetailV1.lastEventPayload) {
        id = payload.id
        type = payload._type
        occurredAt = payload.occurredAt
        producer = payload.producer
        correlationId = payload.correlationId
        causationId = payload.causationId
        subjectRef = payload.subjectRef
        payloadExcerpt = payload.payloadExcerpt
    }

    init(payload: Components.Schemas.ExecutionDetailEvent) {
        id = payload.id
        type = payload._type
        occurredAt = payload.occurredAt
        producer = payload.producer
        correlationId = payload.correlationId
        causationId = payload.causationId
        subjectRef = payload.subjectRef
        payloadExcerpt = payload.payloadExcerpt
    }
}

extension ProjectExecutionDetail.Technical {
    init(payload: Components.Schemas.ExecutionDetailTechnical) {
        inputEventIds = payload.inputEventIds
        correlationId = payload.correlationId
        causationIds = payload.causationIds
        events = payload.events.map(ProjectExecutionDetail.Event.init(payload:))
    }
}

extension ProjectExecutionDetail.Failure {
    init(payload: Components.Schemas.ExecutionDetailV1.failurePayload) {
        code = payload.code
        message = payload.message
        retryable = payload.retryable
        impact = payload.impact
        nextAction = payload.nextAction
        stepId = payload.stepId.flatMap { ProjectExecutionDetail.Step.ID(rawValue: $0.rawValue) }
    }

}
