import Foundation

/// Human labels and stable empty/error states for the Overview. Keeping this
/// pure lets tests prove every Engine reason without constructing AppKit views.
public struct ProjectOverviewPresentation: Sendable, Equatable {
    public enum State: Sendable, Equatable {
        case loading
        case loaded(ProjectOverview)
        case stale(ProjectOverview, String)
        case failed(String)
    }

    public let state: State

    public init(_ snapshot: ProjectOverviewState) {
        if let overview = snapshot.overview {
            if let error = snapshot.errorMessage {
                state = .stale(overview, error)
            } else {
                state = .loaded(overview)
            }
        } else if snapshot.isLoading {
            state = .loading
        } else if let error = snapshot.errorMessage {
            state = .failed(error)
        } else {
            state = .loading
        }
    }

    public static func focusedIssue(_ overview: ProjectOverview) -> ProjectOverview.Issue? {
        overview.issues.first { $0.status == .inProgress && $0.executionId != nil }
            ?? overview.issues.filter { $0.executionId != nil }.max {
                ($0.executionStartedAt ?? .distantPast) < ($1.executionStartedAt ?? .distantPast)
            }
    }

    public static func workStatusLabel(_ issue: ProjectOverview.Issue) -> String {
        if issue.status == .inProgress { return "En cours" }
        return switch issue.lastExecutionStatus {
        case "failed", "timed-out": "Échec à examiner"
        case "cancelled": "Annulée"
        case "completed": "Exécution terminée"
        default: issueStatusLabel(issue.status)
        }
    }

    public static func issueStatusLabel(_ status: ProjectOverview.Issue.Status) -> String {
        switch status {
        case .eligible: "Prête"
        case .waiting: "En attente"
        case .inProgress: "En cours"
        case .blocked: "Bloquée par des dépendances"
        case .ineligible: "Non prête"
        case .unavailable: "Impossible à vérifier"
        }
    }

    public static func pollingLabel(_ state: ProjectOverview.PollingState) -> String {
        switch state {
        case .live: "À jour"
        case .reconnecting: "Reconnexion…"
        case .failed: "Connexion en échec"
        case .paused: "Nouveaux départs en pause"
        case .unavailable: "Non connecté"
        }
    }

    public static func projectStatusLabel(_ status: ProjectOverview.Status) -> String {
        switch status {
        case .draft: "Brouillon"
        case .ready: "En attente d’une issue prête"
        case .running: "En cours"
        case .paused: "En pause"
        case .degraded: "À examiner"
        }
    }

    public static func primaryActionLabel(_ action: ProjectOverview.PrimaryAction) -> String {
        switch action {
        case .activate: "Activer"
        case .pause: "Mettre les nouveaux départs en pause"
        case .resume: "Reprendre les nouveaux départs"
        case .refresh: "Actualiser"
        }
    }
}
