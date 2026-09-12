import Foundation

/// The first-opened Project path. It is presentation data only: the Engine
/// remains the source of truth for Draft values and activation readiness.
public enum ProjectOnboardingStep: String, CaseIterable, Codable, Sendable, Hashable {
    case repository
    case workflow
    case connections
    case review

    public var title: String {
        switch self {
        case .repository: "Repository"
        case .workflow: "Workflow"
        case .connections: "Connections"
        case .review: "Review"
        }
    }
}

public enum ProjectOnboardingStepStatus: String, Sendable, Equatable {
    case needsAction = "À compléter"
    case inProgress = "En cours"
    case readyForReview = "Prêt à revoir"
    case complete = "Terminé"
}

/// Stable content inventory for the native first-opened shell.
public struct ProjectOnboardingPresentation: Sendable, Equatable {
    public struct EmptyState: Sendable, Equatable {
        public let title: String
        public let description: String
        public let primaryAction: String
    }

    public struct Step: Identifiable, Sendable, Equatable {
        public let id: ProjectOnboardingStep
        public let title: String
        public let status: ProjectOnboardingStepStatus
        public let accessibilityLabel: String
    }

    public let emptyState: EmptyState?
    public let steps: [Step]
    public let reviewIsAccessible: Bool
    /// This shell does not infer readiness. The Engine-backed configuration
    /// screen enables activation only after its current validation report.
    public let canActivate: Bool

    public init(project: Project?) {
        guard project != nil else {
            emptyState = EmptyState(
                title: "Welcome to Jarvis",
                description: "Turn a ready issue into development and a pull request. Start by importing a local repository.",
                primaryAction: "Importer un repository")
            steps = []
            reviewIsAccessible = false
            canActivate = false
            return
        }

        emptyState = nil
        steps = [
            Self.step(.repository, .complete),
            Self.step(.workflow, .inProgress),
            Self.step(.connections, .needsAction),
            Self.step(.review, .readyForReview),
        ]
        reviewIsAccessible = true
        canActivate = false
    }

    private static func step(
        _ id: ProjectOnboardingStep,
        _ status: ProjectOnboardingStepStatus
    ) -> Step {
        Step(
            id: id,
            title: id.title,
            status: status,
            accessibilityLabel: "\(id.title), \(status.rawValue)")
    }
}

/// Shell-owned navigation state. Unknown future values remain untouched so a
/// newer app can safely share this local store with an older one.
public final class ProjectOnboardingNavigationStore {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func currentStep(for projectID: String) -> ProjectOnboardingStep {
        guard let value = defaults.string(forKey: key(for: projectID)),
            let step = ProjectOnboardingStep(rawValue: value)
        else { return .repository }
        return step
    }

    public func set(_ step: ProjectOnboardingStep, for projectID: String) {
        defaults.set(step.rawValue, forKey: key(for: projectID))
    }

    public func key(for projectID: String) -> String {
        "dev.jarvis.project-onboarding.v1.\(projectID)"
    }
}
