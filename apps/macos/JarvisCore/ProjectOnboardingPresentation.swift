import Foundation
import JarvisAPI

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
        case .connections: "Paramétrage"
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
    public let deletionLabel: String?

    public init(project: Project?, configuration: ProjectConfigurationState? = nil) {
        guard let project else {
            emptyState = EmptyState(
                title: "Bienvenue dans Jarvis",
                description: "Choisissez un dépôt, configurez votre workflow et suivez une issue GitHub jusqu’à sa Pull Request. Vous gardez la relecture et le merge.",
                primaryAction: "Choisir un dépôt Git")
            steps = []
            reviewIsAccessible = false
            canActivate = false
            deletionLabel = nil
            return
        }

        emptyState = nil
        deletionLabel = project.status == .draft ? "Supprimer le brouillon" : "Supprimer le projet"
        let reviewStatus: ProjectOnboardingStepStatus
        switch configuration?.preflight ?? .unchecked {
        case .unchecked: reviewStatus = .needsAction
        case .loading: reviewStatus = .inProgress
        case .failed: reviewStatus = .failed
        case .stale: reviewStatus = .stale
        case .current(let report):
            reviewStatus = report.valid && report.configurationReady ? .complete : .failed
        }
        let hasModules = configuration?.draft?.modules.contains { $0.enabled } == true
        let resources = configuration?.resourceChoices ?? []
        let resourcesReady = !resources.isEmpty && resources.allSatisfy { $0.status == .bound }
            && configuration?.runtimeAllowsActivation == true
        let workflowStatus: ProjectOnboardingStepStatus
        if configuration?.isLoading == true {
            workflowStatus = .inProgress
        } else if configuration?.loadFailed == true {
            workflowStatus = configuration?.detail == nil ? .failed : .stale
        } else {
            workflowStatus = .complete
        }
        steps = [
            Self.step(.workflow, workflowStatus),
            Self.step(.connections, !hasModules || resourcesReady ? .complete : .needsAction),
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

public struct ProjectSettingsPresentation: Sendable, Equatable {
    public struct Choice: Identifiable, Sendable, Equatable {
        public let id: String
        public let name: String
        public let status: String
        public let isSelected: Bool
        public let isSelectable: Bool
    }

    public struct GitHub: Sendable, Equatable {
        public let accounts: [Choice]
        public let isGitRepository: Bool
        public let isGitHubRepository: Bool
    }

    public struct Development: Sendable, Equatable {
        public let readyLabel: String
        public let runtimes: [Choice]
    }

    public let github: GitHub?
    public let development: Development?
    public let pullRequestRuntimes: [Choice]?

    public init(configuration state: ProjectConfigurationState) {
        let modules = state.draft?.modules.filter(\.enabled) ?? []
        let slotBindings = state.localBindings?.slots ?? []
        if let module = modules.first(where: {
            $0.moduleId == "jarvis.module.github" || $0.moduleId == "jarvis.module.pull-request"
        }) {
            let slots = Set([module.bindings["sourceControl"]].compactMap { $0 })
            let selected = slotBindings.first {
                slots.contains($0.slotId) && $0.kind == .connection
            }?.ref
            var seen = Set<String>()
            let accounts = state.resourceChoices
                .filter { slots.contains($0.slotId) }
                .flatMap(\.candidates)
                .filter { $0.kind == .connection && seen.insert($0.ref).inserted }
                .map {
                    Choice(
                        id: $0.ref, name: $0.displayName, status: "Disponible",
                        isSelected: $0.ref == selected, isSelectable: true)
                }
            let repository = state.detail?.bindings.first
            github = GitHub(
                accounts: accounts,
                isGitRepository: repository?.isGitRepository == true,
                isGitHubRepository: repository?.isGitHubRepository == true)
        } else {
            github = nil
        }

        let developmentModule = modules.first { $0.moduleId == "jarvis.module.development" }
        let pullRequestModule = modules.first { $0.moduleId == "jarvis.module.pull-request" }
        let runtimeModule = developmentModule ?? pullRequestModule
        let selectedRuntime = slotBindings.first {
            $0.slotId == runtimeModule?.runtimeSlot && $0.kind == .runtime
        }?.ref
        let runtimes = (state.agentRuntimes?.items ?? []).map {
            Choice(
                id: $0.ref,
                name: $0.displayName,
                status: Self.runtimeStatus($0.readiness.status),
                isSelected: $0.ref == selectedRuntime,
                isSelectable: $0.selectable)
        }
        if let module = developmentModule {
            development = Development(
                readyLabel: module.configurationValues["readyLabel"] ?? "",
                runtimes: runtimes)
        } else {
            development = nil
        }
        pullRequestRuntimes = developmentModule == nil && pullRequestModule != nil ? runtimes : nil
    }

    private static func runtimeStatus(
        _ status: Components.Schemas.ProjectRuntimeReadiness.statusPayload
    ) -> String {
        switch status {
        case .ready, .unchecked: "Disponible"
        case .absent, .access_hyphen_denied, .incompatible, .engine_hyphen_error: "Indisponible"
        case .checking: "Recherche…"
        }
    }
}

public struct ProjectVerificationPresentation: Sendable, Equatable {
    public enum Status: Sendable, Equatable { case unchecked, checking, failed, succeeded }

    public struct Check: Identifiable, Sendable, Equatable {
        public let id: String
        public let title: String
        public let detail: String
        public let passed: Bool
    }

    public let status: Status
    public let title: String
    public let detail: String
    public let checks: [Check]
    public let actionTitle: String
    public let canActivate: Bool

    public init(project: Project, configuration: ProjectConfigurationState) {
        actionTitle = project.status == .draft ? "Créer le projet" : "Appliquer la configuration"
        switch configuration.preflight {
        case .unchecked, .stale:
            status = .unchecked
            title = "Configuration à vérifier"
            detail = "Vérifiez les dépendances externes des modules sélectionnés."
            checks = []
        case .loading:
            status = .checking
            title = "Vérification en cours…"
            detail = "Jarvis vérifie les dépendances externes."
            checks = []
        case .failed(let message):
            status = .failed
            title = "Vérification impossible"
            detail = message
            checks = []
        case .current(let report):
            checks = report.checks.map {
                let passed = $0.status == .passed
                return Check(
                    id: $0.id, title: $0.title, detail: passed ? "" : $0.impact,
                    passed: passed)
            }
            if report.valid && report.configurationReady {
                status = .succeeded
                title = "Configuration vérifiée"
                detail = "Les dépendances externes sont disponibles."
            } else {
                status = .failed
                title = "Vérification échouée"
                detail = "Modifiez le workflow ou son paramétrage, puis vérifiez à nouveau."
            }
        }
        canActivate = status == .succeeded && configuration.isDraftSaved
            && !configuration.isSaving && configuration.activation != .activating
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
        else { return .workflow }
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
