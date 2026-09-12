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

    public static func issueStatusLabel(_ status: ProjectOverview.Issue.Status) -> String {
        switch status {
        case .eligible: "Eligible"
        case .waiting: "Waiting"
        case .inProgress: "Already running"
        case .blocked: "Blocked by dependencies"
        case .ineligible: "Not eligible"
        case .unavailable: "Unable to verify"
        }
    }

    public static func pollingLabel(_ state: ProjectOverview.PollingState) -> String {
        switch state {
        case .live: "Live"
        case .reconnecting: "Reconnecting…"
        case .failed: "Connection failed"
        case .paused: "New work paused"
        case .unavailable: "Not connected"
        }
    }

    public static func projectStatusLabel(_ status: ProjectOverview.Status) -> String {
        switch status {
        case .draft: "Draft"
        case .ready: "Ready"
        case .running: "Running"
        case .paused: "Paused"
        case .degraded: "Degraded"
        }
    }

    public static func primaryActionLabel(_ action: ProjectOverview.PrimaryAction) -> String {
        switch action {
        case .activate: "Activate"
        case .pause: "Pause new work"
        case .resume: "Resume new work"
        case .refresh: "Refresh"
        }
    }
}
