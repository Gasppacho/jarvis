import Foundation
import JarvisAPI

public extension Components.Schemas.ProjectPreflightV1 {
    var configuredWorkItemRef: String? {
        if let trigger {
            switch trigger.scope {
            case .case1: return nil
            case .case2(let scope): return scope.workItemRef
            }
        }
        return rule?.selectedWorkItemRef
    }

    var candidateStatusLabel: String {
        switch candidateEligibility.status {
        case .empty: return "Aucune issue prête actuellement"
        case .unavailable: return "Accès GitHub non vérifiable"
        case .available:
            return "\(candidateEligibility.items.filter { $0.status == .eligible }.count) issue(s) prête(s) sur \(candidateEligibility.items.count) examinée(s)"
        }
    }
}

public protocol ProjectPreflightAPI: Sendable {
    func preflightProject(projectId: String) async throws -> Components.Schemas.ProjectPreflightV1
    func scopePreflightProject(projectId: String, fingerprint: String, workItemRef: String?) async throws -> Components.Schemas.PortableProjectConfiguration
    func activatePreflightProject(projectId: String, fingerprint: String) async throws -> Project
}

public struct ProjectPreflightRepairGroup: Identifiable, Sendable, Equatable {
    public let id: String
    public let step: ProjectOnboardingStep
    public let checks: [Components.Schemas.PreflightCheck]

    init(id: String, step: ProjectOnboardingStep, checks: [Components.Schemas.PreflightCheck]) {
        self.id = id
        self.step = step
        self.checks = checks
    }
}

/// Shell routing for an Engine-provided check identifier. The identifier is a
/// contract; no user-facing diagnostic text participates in navigation.
public struct ProjectPreflightRepairTarget: Sendable, Equatable {
    public let step: ProjectOnboardingStep
    public let controlID: String

    public init(step: ProjectOnboardingStep, controlID: String) {
        self.step = step
        self.controlID = controlID
    }
}

public enum ProjectPreflightState: Sendable, Equatable {
    case unchecked
    case loading
    case current(Components.Schemas.ProjectPreflightV1)
    case stale(Components.Schemas.ProjectPreflightV1?)
    case failed(String)

    public var report: Components.Schemas.ProjectPreflightV1? {
        switch self { case .current(let report), .stale(.some(let report)): report; default: nil }
    }
    public var canActivate: Bool {
        guard case .current(let report) = self else { return false }
        return report.valid && report.configurationReady && !report.compositionFingerprint.isEmpty
    }
    public var canStartWorkflow: Bool {
        guard canActivate, let report else { return false }
        guard let ref = report.configuredWorkItemRef else { return true }
        return report.candidateEligibility.status == .available
            && report.candidateEligibility.items.contains { $0.workItemRef == ref && $0.status == .eligible }
    }
    public var activationTitle: String {
        if let report, report.trigger == nil { return "Observer les issues" }
        return report?.configuredWorkItemRef.map { "Tester avec l’issue \(Self.issueLabel($0))" }
            ?? "Surveiller les issues prêtes"
    }
    public static func issueLabel(_ ref: String) -> String {
        guard let url = URL(string: ref), let number = Int(url.lastPathComponent), number > 0 else { return "sélectionnée" }
        return "#\(number)"
    }
    public var title: String {
        switch self {
        case .unchecked: "Configuration à vérifier"
        case .loading: "Vérification en cours"
        case .current: canActivate ? "Configuration vérifiée" : "Corrections nécessaires"
        case .stale: "Contrôle périmé : vérifiez à nouveau"
        case .failed: "Vérification indisponible"
        }
    }
    public static func repairStep(_ check: Components.Schemas.PreflightCheck) -> ProjectOnboardingStep {
        switch check.repairStep { case .Repository: .repository; case .Workflow: .workflow; case .Connections: .connections }
    }

    public static func repairTarget(_ check: Components.Schemas.PreflightCheck) -> ProjectPreflightRepairTarget {
        let step = repairStep(check)
        switch step {
        case .repository:
            return .init(step: step, controlID: "project.repository-access")
        case .connections:
            return .init(step: step, controlID: check.id == "runtime" ? "project.runtime.refresh" : "project.github.refresh")
        case .workflow:
            if check.id.hasPrefix("label:") || check.id == "development" {
                return .init(step: step, controlID: "workflow.development.ready-label")
            }
            if check.id.hasPrefix("preparation:") {
                return .init(step: step, controlID: "workflow.preparation")
            }
            if check.id.hasPrefix("validation:") {
                let name = check.id.dropFirst("validation:".count)
                return .init(step: step, controlID: "workflow.validation.\(name)")
            }
            return .init(step: step, controlID: "workflow.choose-recommended")
        case .review:
            return .init(step: step, controlID: "project.preflight.check")
        }
    }

    public static func failedChecks(
        _ report: Components.Schemas.ProjectPreflightV1,
        for step: ProjectOnboardingStep
    ) -> [Components.Schemas.PreflightCheck] {
        report.checks.filter { $0.status == .failed && repairStep($0) == step }
    }

    public static func repairGroups(
        _ report: Components.Schemas.ProjectPreflightV1
    ) -> [ProjectPreflightRepairGroup] {
        var groups: [String: (step: ProjectOnboardingStep, checks: [Components.Schemas.PreflightCheck])] = [:]
        var order: [String] = []
        for check in report.checks where check.status == .failed {
            let step = repairStep(check)
            let key = "\(step.rawValue):\(repairGroupKey(check))"
            if groups[key] == nil { order.append(key); groups[key] = (step, []) }
            groups[key]!.checks.append(check)
        }
        return order.compactMap { key in
            guard let group = groups[key] else { return nil }
            return ProjectPreflightRepairGroup(id: key, step: group.step, checks: group.checks)
        }
    }

    private static func repairGroupKey(_ check: Components.Schemas.PreflightCheck) -> String {
        switch check.id {
        case "runtime": return "runtime"
        case "account", "repositories", "github": return "github-access"
        default:
            if check.id.hasPrefix("repository:") { return "github-access" }
            if check.id.hasPrefix("issues:") || check.id.hasPrefix("github:") { return "github-reading" }
            if check.id.hasPrefix("dependencies:") { return "github-dependencies" }
            if check.id.hasPrefix("label:") { return "readiness-label" }
            if check.id.hasPrefix("preparation:") { return "preparation" }
            if check.id.hasPrefix("validation:") { return "validation" }
            if check.id.hasPrefix("composition:") { return "composition" }
            return check.id
        }
    }

    public static func userFacingTitle(_ check: Components.Schemas.PreflightCheck) -> String {
        switch check.id {
        case "account": return "Compte GitHub"
        case "repositories": return "Dépôt GitHub lié"
        case "github": return "Source GitHub"
        case "development": return "Label de readiness"
        case "concurrency": return "Concurrence du workflow"
        case "runtime": return "Agent de développement"
        case "composition": return "Parcours des modules"
        case "legacy-configuration": return "Configuration historique"
        default:
            if check.id.hasPrefix("tool:") { return "Outil : \(check.id.dropFirst(5))" }
            if check.id == "tools:repository" { return "Dossier du projet" }
            if check.id.hasPrefix("composition:") { return "Composition du projet" }
            if check.id.hasPrefix("preparation:") { return "Préparation" }
            if check.id.hasPrefix("validation:") { return "Commande de validation" }
            if check.id.hasPrefix("repository:") { return "Accès au dépôt GitHub" }
            if check.id.hasPrefix("label:") { return "Label de readiness" }
            if check.id.hasPrefix("issues:") { return "Lecture des issues" }
            if check.id.hasPrefix("dependencies:") { return "Lecture des dépendances" }
            if check.id.hasPrefix("github:") { return "Lecture GitHub" }
            return "Contrôle de configuration"
        }
    }

    public static func userFacingImpact(_ check: Components.Schemas.PreflightCheck) -> String {
        switch check.id {
        case "account": return "Un compte GitHub doit être autorisé pour lire les issues."
        case "repositories", "github": return "Jarvis ne peut pas vérifier le dépôt GitHub sélectionné."
        case "development": return "Le label indique quelles issues peuvent être proposées à Development."
        case "concurrency": return "Le workflow doit traiter une seule issue à la fois."
        case "runtime": return "Choisissez un agent disponible pour ce projet avant de démarrer Development."
        case "composition": return "Un module ou une ressource du parcours doit encore être corrigé."
        case "legacy-configuration": return "Mettez le projet en pause et lancez la migration guidée."
        default:
            if check.id.hasPrefix("tool:") { return "Cet outil doit être accessible pour exécuter les commandes choisies." }
            if check.id == "tools:repository" { return "Jarvis doit pouvoir accéder au dossier du projet." }
            if check.id.hasPrefix("composition:") { return "Le parcours ou ses ressources sont incomplets." }
            if check.id.hasPrefix("preparation:") { return "Confirmez la préparation avant de démarrer Development." }
            if check.id.hasPrefix("validation:") { return "Choisissez et confirmez les validations à exécuter." }
            if check.id.hasPrefix("label:") { return "Le label de readiness doit exister dans GitHub." }
            if check.id.hasPrefix("dependencies:") { return "Les dépendances doivent être lisibles avant toute admission." }
            if check.id.hasPrefix("repository:") { return "Le compte doit pouvoir lire les issues et pousser une branche si Development est activé." }
            if check.id.hasPrefix("issues:") { return "Jarvis doit pouvoir lire les issues du dépôt." }
            if check.id.hasPrefix("github:") { return "La lecture GitHub a échoué ; l’accès ne peut pas être confirmé." }
            return "Ce contrôle empêche la vérification complète de la configuration."
        }
    }
}
