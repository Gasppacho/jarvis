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
}

public protocol ProjectPreflightAPI: Sendable {
    func preflightProject(projectId: String) async throws -> Components.Schemas.ProjectPreflightV1
    func scopePreflightProject(projectId: String, fingerprint: String, workItemRef: String?) async throws -> Components.Schemas.PortableProjectConfiguration
    func activatePreflightProject(projectId: String, fingerprint: String) async throws -> Project
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
        report?.configuredWorkItemRef.map { "Tester avec l’issue \(Self.issueLabel($0))" }
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
}
