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
        case .repository: "Dépôt"
        case .workflow: "Workflow"
        case .connections: "Accès et agent"
        case .review: "Vérification"
        }
    }
}

public enum ProjectOnboardingStepStatus: String, Sendable, Equatable {
    case needsAction = "À compléter"
    case inProgress = "En cours"
    case readyForReview = "Prêt à revoir"
    case complete = "Terminé"
    case failed = "À corriger"
    case stale = "À revérifier"
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

    public init(project: Project?, configuration: ProjectConfigurationState? = nil) {
        guard project != nil else {
            emptyState = EmptyState(
                title: "Bienvenue dans Jarvis",
                description: "Choisissez un dépôt, configurez votre workflow et suivez une issue GitHub jusqu’à sa Pull Request. Vous gardez la relecture et le merge.",
                primaryAction: "Choisir un dépôt Git")
            steps = []
            reviewIsAccessible = false
            canActivate = false
            return
        }

        emptyState = nil
        let reviewStatus: ProjectOnboardingStepStatus
        switch configuration?.preflight ?? .unchecked {
        case .unchecked: reviewStatus = .needsAction
        case .loading: reviewStatus = .inProgress
        case .failed: reviewStatus = .failed
        case .stale: reviewStatus = .stale
        case .current(let report):
            reviewStatus = report.valid && report.configurationReady ? .complete : .failed
        }
        let hasGitHub = configuration?.draft?.modules.contains { $0.enabled && $0.moduleId == "jarvis.module.github" } == true
        let hasDevelopment = configuration?.draft?.modules.contains { $0.enabled && $0.moduleId == "jarvis.module.development" } == true
        let resources = configuration?.resourceChoices ?? []
        let resourcesReady = !resources.isEmpty && resources.allSatisfy { $0.status == .bound }
            && configuration?.runtimeAllowsActivation == true
        let repositoryStatus: ProjectOnboardingStepStatus
        if configuration?.isLoading == true {
            repositoryStatus = .inProgress
        } else if configuration?.loadFailed == true {
            repositoryStatus = configuration?.detail == nil ? .failed : .stale
        } else if let bindings = configuration?.detail?.bindings, !bindings.isEmpty {
            repositoryStatus = bindings.allSatisfy(\.accessible) ? .complete : .failed
        } else {
            repositoryStatus = configuration?.errorMessage == nil ? .needsAction : .failed
        }
        steps = [
            Self.step(.repository, repositoryStatus),
            Self.step(.workflow, hasGitHub && hasDevelopment && configuration?.draft?.workflowCommandsConfigured == true ? .readyForReview : .needsAction),
            Self.step(.connections, resourcesReady ? .complete : .needsAction),
            Self.step(.review, reviewStatus),
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
    private let namespace: String

    public init(defaults: UserDefaults = .standard, namespace: String = "") {
        self.defaults = defaults
        self.namespace = namespace
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

    public var lastProjectID: String? {
        get { defaults.string(forKey: "\(namespace)dev.jarvis.last-project.v1") }
        set { defaults.set(newValue, forKey: "\(namespace)dev.jarvis.last-project.v1") }
    }

    public func key(for projectID: String) -> String {
        "\(namespace)dev.jarvis.project-onboarding.v1.\(projectID)"
    }
}
