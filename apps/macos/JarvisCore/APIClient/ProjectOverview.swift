import Foundation
import JarvisAPI

public struct ProjectOverview: Sendable, Equatable {
    public enum Status: String, Sendable, Equatable {
        case draft, ready, running, paused, degraded
    }

    public enum PrimaryAction: String, Sendable, Equatable {
        case activate, pause, resume, refresh
    }

    public enum PollingState: String, Sendable, Equatable {
        case live, reconnecting, failed, paused, unavailable
    }

    public struct Polling: Sendable, Equatable {
        public let state: PollingState
        public let lastPollAt: Date?
        public let errorReason: String?
    }

    public struct Stage: Identifiable, Sendable, Equatable {
        public enum ID: String, Sendable, Equatable {
            case github, development
            case pullRequest = "pull-request"
        }

        public let id: ID
        public let label: String
        public let status: String
        public let detail: String
    }

    public struct Issue: Identifiable, Sendable, Equatable {
        public enum Status: String, Sendable, Equatable {
            case eligible, waiting
            case inProgress = "in-progress"
            case blocked, ineligible, unavailable
        }

        public var id: String { workItemRef }
        public let workItemRef: String
        public let title: String
        public let issueNumber: Int
        public let repositoryId: String
        public let status: Status
        public let reason: String
        public let explanation: String
        public let openDependencyCount: Int
        public let blockerRefs: [String]
        public let readinessLabel: String
        public let executionId: String?
        public let lastExecutionStatus: String?
        public let executionStartedAt: Date?
        public let executionCompletedAt: Date?

        public init(
            workItemRef: String,
            title: String,
            issueNumber: Int,
            repositoryId: String,
            status: Status,
            reason: String,
            explanation: String,
            openDependencyCount: Int,
            blockerRefs: [String],
            readinessLabel: String,
            executionId: String? = nil,
            lastExecutionStatus: String? = nil,
            executionStartedAt: Date? = nil,
            executionCompletedAt: Date? = nil
        ) {
            self.workItemRef = workItemRef
            self.title = title
            self.issueNumber = issueNumber
            self.repositoryId = repositoryId
            self.status = status
            self.reason = reason
            self.explanation = explanation
            self.openDependencyCount = openDependencyCount
            self.blockerRefs = blockerRefs
            self.readinessLabel = readinessLabel
            self.executionId = executionId
            self.lastExecutionStatus = lastExecutionStatus
            self.executionStartedAt = executionStartedAt
            self.executionCompletedAt = executionCompletedAt
        }
    }

    public let projectId: String
    public let name: String
    public let status: Status
    public let primaryAction: PrimaryAction
    public let polling: Polling
    public let workflowAvailable: Bool
    public let stages: [Stage]
    public let nextStep: String
    public let issues: [Issue]
    public let activeExecutionCount: Int
    public let activeWorkItemRefs: [String]
    public let readinessHelp: String
    public let selectedWorkItemRef: String?

    public init(
        projectId: String,
        name: String,
        status: Status,
        primaryAction: PrimaryAction,
        polling: Polling,
        workflowAvailable: Bool,
        stages: [Stage],
        nextStep: String,
        issues: [Issue],
        activeExecutionCount: Int,
        activeWorkItemRefs: [String],
        readinessHelp: String,
        selectedWorkItemRef: String? = nil
    ) {
        self.projectId = projectId
        self.name = name
        self.status = status
        self.primaryAction = primaryAction
        self.polling = polling
        self.workflowAvailable = workflowAvailable
        self.stages = stages
        self.nextStep = nextStep
        self.issues = issues
        self.activeExecutionCount = activeExecutionCount
        self.activeWorkItemRefs = activeWorkItemRefs
        self.readinessHelp = readinessHelp
        self.selectedWorkItemRef = selectedWorkItemRef
    }

    init(payload: Components.Schemas.ProjectOverviewV1) {
        projectId = payload.projectId
        name = payload.name
        status = Self.status(payload.status)
        primaryAction = Self.primaryAction(payload.primaryAction)
        polling = Polling(
            state: Self.pollingState(payload.polling.state),
            lastPollAt: payload.polling.lastPollAt,
            errorReason: payload.polling.errorReason)
        workflowAvailable = payload.workflow.available
        stages = payload.workflow.stages.map {
            Stage(
                id: Self.stageID($0.id),
                label: $0.label,
                status: $0.status.rawValue,
                detail: $0.detail)
        }
        nextStep = payload.workflow.nextStep
        issues = payload.issues.map {
            Issue(
                workItemRef: $0.workItemRef,
                title: $0.title,
                issueNumber: $0.issueNumber,
                repositoryId: $0.repositoryId,
                status: Self.issueStatus($0.status),
                reason: $0.reason,
                explanation: $0.explanation,
                openDependencyCount: $0.openDependencyCount,
                blockerRefs: $0.blockerRefs,
                readinessLabel: $0.readinessLabel,
                executionId: $0.executionId,
                lastExecutionStatus: $0.lastExecutionStatus?.rawValue,
                executionStartedAt: $0.executionStartedAt,
                executionCompletedAt: $0.executionCompletedAt)
        }
        activeExecutionCount = payload.activeExecutionCount
        activeWorkItemRefs = payload.activeWorkItemRefs
        readinessHelp = payload.readinessHelp
        selectedWorkItemRef = payload.selectedWorkItemRef
    }

    private static func status(
        _ value: Components.Schemas.ProjectOverviewV1.statusPayload
    ) -> Status {
        switch value {
        case .draft: .draft
        case .ready: .ready
        case .running: .running
        case .paused: .paused
        case .degraded: .degraded
        }
    }

    private static func primaryAction(
        _ value: Components.Schemas.ProjectOverviewV1.primaryActionPayload
    ) -> PrimaryAction {
        switch value {
        case .activate: .activate
        case .pause: .pause
        case .resume: .resume
        case .refresh: .refresh
        }
    }

    private static func pollingState(
        _ value: Components.Schemas.ProjectOverviewV1.pollingPayload.statePayload
    ) -> PollingState {
        switch value {
        case .live: .live
        case .reconnecting: .reconnecting
        case .failed: .failed
        case .paused: .paused
        case .unavailable: .unavailable
        }
    }

    private static func stageID(
        _ value: Components.Schemas.ProjectOverviewStage.idPayload
    ) -> Stage.ID {
        switch value {
        case .github: .github
        case .development: .development
        case .pull_hyphen_request: .pullRequest
        }
    }

    private static func issueStatus(
        _ value: Components.Schemas.ProjectOverviewIssue.statusPayload
    ) -> Issue.Status {
        switch value {
        case .eligible: .eligible
        case .waiting: .waiting
        case .in_hyphen_progress: .inProgress
        case .blocked: .blocked
        case .ineligible: .ineligible
        case .unavailable: .unavailable
        }
    }
}
