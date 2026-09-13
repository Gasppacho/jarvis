import Foundation
import JarvisAPI

public protocol ProjectRuntimeAPI: Sendable {
    func listProjectBindingCandidates(projectId: String) async throws -> ProjectResourceChoices
    func getProjectBindings(projectId: String) async throws -> LocalProjectBindings
    func discoverProjectRuntimes() async throws
    func bindProjectRuntime(projectId: String, ref: String) async throws -> Components.Schemas.ProjectAgentRuntimeChoices
    func checkProjectRuntime(projectId: String) async throws -> Components.Schemas.ProjectAgentRuntimeChoices
}

extension EngineClient: ProjectRuntimeAPI {}

/// Presentation only: compatibility, grants and readiness are Engine decisions.
public struct ProjectRuntimePresentation: Sendable, Equatable {
    public struct Candidate: Identifiable, Sendable, Equatable {
        public let id: String
        public let name: String
        public let subtitle: String
        public let bound: Bool
        public let selectable: Bool
        public let needsAttention: Bool
        public let status: String
        public let detail: String
    }

    public let title = "Agent de développement"
    /// The runner supplies no model override and ignores user configuration.
    public let modelLabel = "Modèle par défaut de Codex"
    public let requiresWorkflow: Bool
    public let status: String
    public let icon: String
    public let detail: String
    public let impact: String
    public let checkedAt: Date?
    public let candidates: [Candidate]
    public let isBusy: Bool
    public let canCheck: Bool
    public let reviewEnabled = true
    public let approval = "Choisir autorise, pour ce projet seulement, les outils et le contexte de connexion Codex détectés sur ce Mac. Aucun token n’est copié."

    public init(choices: Components.Schemas.ProjectAgentRuntimeChoices?, isBusy: Bool) {
        self.isBusy = isBusy
        requiresWorkflow = choices?.required == false
        let readiness = choices?.readiness
        let state = isBusy ? .checking : (readiness?.status ?? Components.Schemas.ProjectRuntimeReadiness.statusPayload.unchecked)
        status = requiresWorkflow ? "Choisissez d’abord un workflow" : Self.label(state)
        icon = state == .ready ? "checkmark.circle.fill" : state == .checking ? "clock" : "exclamationmark.triangle"
        detail = readiness?.detail ?? "Recherchez puis choisissez Codex pour ce projet."
        impact = state == .ready ? "Development peut utiliser ce runtime." : "Development ne peut pas démarrer."
        checkedAt = readiness?.checkedAt
        candidates = (choices?.items ?? []).map {
            Candidate(id: $0.ref, name: $0.displayName, subtitle: $0.version.map { "Codex · \($0)" } ?? "Codex · Version non fournie", bound: $0.bound, selectable: $0.selectable && !isBusy && choices?.required == true, needsAttention: $0.readiness.status != .unchecked && $0.readiness.status != .ready, status: Self.label($0.readiness.status), detail: $0.readiness.detail)
        }
        canCheck = !isBusy && !requiresWorkflow && candidates.contains(where: \.bound)
    }

    private static func label(_ status: Components.Schemas.ProjectRuntimeReadiness.statusPayload) -> String {
        switch status {
        case .ready: "Prêt"
        case .absent: "Codex non installé"
        case .access_hyphen_denied: "Connexion ou autorisation requise"
        case .incompatible: "Agent non compatible"
        case .checking: "Vérification en cours"
        case .engine_hyphen_error: "Erreur du moteur"
        case .unchecked: "Non vérifié"
        }
    }
}
