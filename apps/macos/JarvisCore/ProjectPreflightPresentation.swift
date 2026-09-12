import Foundation
import JarvisAPI

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
    public var title: String {
        switch self {
        case .unchecked: "Vérifier que le workflow est prêt"
        case .loading: "Vérification en cours"
        case .current(let report): report.configurationReady ? "Prêt à activer" : "Corrections nécessaires"
        case .stale: "Rapport périmé : relancez le préflight"
        case .failed: "Erreur Local API — préflight indisponible"
        }
    }
    public static func repairStep(_ check: Components.Schemas.PreflightCheck) -> ProjectOnboardingStep {
        switch check.repairStep { case .Repository: .repository; case .Workflow: .workflow; case .Connections: .connections }
    }
}
