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
        public let status: String
        public let detail: String
    }

    public let title = "Runtime agentique"
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
        let readiness = choices?.readiness
        let state = isBusy ? .checking : (readiness?.status ?? Components.Schemas.ProjectRuntimeReadiness.statusPayload.unchecked)
        status = Self.label(state)
        icon = state == .ready ? "checkmark.circle.fill" : state == .checking ? "clock" : "exclamationmark.triangle"
        detail = readiness?.detail ?? "Découvrez puis choisissez un runtime Codex pour ce projet."
        impact = state == .ready ? "Development peut utiliser ce runtime." : "Development ne peut pas démarrer."
        checkedAt = readiness?.checkedAt
        candidates = (choices?.items ?? []).map {
            Candidate(id: $0.ref, name: $0.displayName, subtitle: $0.version.map { "Codex · \($0)" } ?? "Codex · Version non fournie", bound: $0.bound, selectable: $0.selectable && !isBusy, status: Self.label($0.readiness.status), detail: $0.readiness.detail)
        }
        canCheck = !isBusy && candidates.contains(where: \.bound)
    }

    private static func label(_ status: Components.Schemas.ProjectRuntimeReadiness.statusPayload) -> String {
        switch status {
        case .ready: "Prêt"
        case .absent: "Absent"
        case .access_hyphen_denied: "Accès refusé"
        case .incompatible: "Version incompatible"
        case .checking: "Vérification en cours"
        case .engine_hyphen_error: "Erreur du moteur"
        case .unchecked: "Non vérifié"
        }
    }
}
