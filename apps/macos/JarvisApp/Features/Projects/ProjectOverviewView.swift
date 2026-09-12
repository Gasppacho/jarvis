import JarvisCore
import SwiftUI

/// Ticket #199: the first answer after a Project is activated. The view is a
/// native reading surface; eligibility and pause policy come from the Engine.
struct ProjectOverviewView: View {
    let model: ProjectOverviewModel
    let projects: ProjectsModel
    let projectId: String

    var body: some View {
        let presentation = ProjectOverviewPresentation(model.state(for: projectId))
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                switch presentation.state {
                case .loading:
                    ProgressView("Loading Project Overview…")
                        .frame(maxWidth: .infinity, minHeight: 240)
                case .failed(let message):
                    unavailable(message)
                case .loaded(let overview):
                    overviewContent(overview)
                case .stale(let overview, let message):
                    warning(message)
                    overviewContent(overview)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)
        }
        .task(id: projectId) {
            await model.refresh(projectId: projectId)
        }
    }

    private func overviewContent(_ overview: ProjectOverview) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            header(overview)
            workflowCard(overview)
            pollingCard(overview)
            issuesCard(overview)
        }
    }

    private func header(_ overview: ProjectOverview) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(overview.name)
                    .font(.title2.bold())
                    .fixedSize(horizontal: false, vertical: true)
                Label(
                    ProjectOverviewPresentation.projectStatusLabel(overview.status),
                    systemImage: statusSymbol(overview.status))
                    .foregroundStyle(statusColor(overview.status))
                    .font(.callout.weight(.medium))
                Spacer()
            }
            Text(overview.nextStep)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                switch overview.primaryAction {
                case .pause:
                    Button("Pause new work") {
                        Task {
                            await model.pause(projectId: projectId)
                            await projects.refresh()
                        }
                    }
                case .resume:
                    Button("Resume new work") {
                        Task {
                            await model.resume(projectId: projectId)
                            await projects.refresh()
                        }
                    }
                case .activate:
                    Text("Complete the Project configuration to activate it.")
                        .foregroundStyle(.secondary)
                case .refresh:
                    EmptyView()
                }
                Button {
                    Task { await model.retryPolling(projectId: projectId) }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .disabled(model.state(for: projectId).isLoading)
            }
        }
        .padding(16)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .contain)
    }

    private func workflowCard(_ overview: ProjectOverview) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 8) {
                    ForEach(Array(overview.stages.enumerated()), id: \.element.id) { index, stage in
                        if index > 0 {
                            Image(systemName: "chevron.right")
                                .foregroundStyle(.secondary)
                                .accessibilityHidden(true)
                        }
                        VStack(spacing: 4) {
                            Image(systemName: stageSymbol(stage))
                                .foregroundStyle(stageColor(stage))
                            Text(stage.label)
                                .font(.caption.weight(.medium))
                                .fixedSize(horizontal: false, vertical: true)
                            Text(stageStatus(stage))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .frame(maxWidth: .infinity)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(stage.label): \(stageStatus(stage)). \(stage.detail)")
                    }
                }
                Text(overview.nextStep)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } label: {
            Label("Workflow", systemImage: "arrow.triangle.branch")
        }
    }

    private func pollingCard(_ overview: ProjectOverview) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                Label(
                    ProjectOverviewPresentation.pollingLabel(overview.polling.state),
                    systemImage: pollingSymbol(overview.polling.state))
                    .foregroundStyle(pollingColor(overview.polling.state))
                if let lastPollAt = overview.polling.lastPollAt {
                    Text("Last poll: \(lastPollAt, format: .dateTime)")
                        .font(.callout)
                } else {
                    Text("No GitHub poll has completed yet.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                if let errorReason = overview.polling.errorReason {
                    Label("Retry reason: \(errorReason)", systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if overview.polling.state == .failed || overview.polling.state == .unavailable {
                    Button("Retry GitHub polling") {
                        Task { await model.retryPolling(projectId: projectId) }
                    }
                    .disabled(model.state(for: projectId).isLoading)
                }
            }
        } label: {
            Label("GitHub polling", systemImage: "arrow.triangle.2.circlepath")
        }
    }

    private func issuesCard(_ overview: ProjectOverview) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 12) {
                Text(overview.readinessHelp)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if overview.issues.isEmpty {
                    ContentUnavailableView {
                        Label("No relevant issues", systemImage: "checkmark.circle")
                    } description: {
                        Text("The latest GitHub snapshot contains no issue to display yet.")
                    }
                } else {
                    ForEach(overview.issues) { issue in
                        issueRow(issue)
                    }
                }
            }
        } label: {
            Label("Issues", systemImage: "list.bullet.rectangle")
        }
    }

    private func issueRow(_ issue: ProjectOverview.Issue) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                Label(
                    ProjectOverviewPresentation.issueStatusLabel(issue.status),
                    systemImage: issueSymbol(issue.status))
                    .foregroundStyle(issueColor(issue.status))
                    .font(.callout.weight(.medium))
                Spacer()
                Text("#\(issue.issueNumber)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            Text(issue.title)
                .font(.body.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)
            Text(issue.explanation)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            if issue.openDependencyCount > 0 {
                Text("Open native dependencies: \(issue.openDependencyCount)")
                    .font(.caption.weight(.medium))
                ForEach(issue.blockerRefs, id: \.self) { blocker in
                    Text(blocker)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            "Issue \(issue.issueNumber), \(ProjectOverviewPresentation.issueStatusLabel(issue.status)). \(issue.title). \(issue.explanation)")
    }

    private func unavailable(_ message: String) -> some View {
        ContentUnavailableView {
            Label("Project Overview unavailable", systemImage: "exclamationmark.triangle.fill")
        } description: {
            Text(message)
        } actions: {
            Button("Retry") { Task { await model.refresh(projectId: projectId) } }
        }
    }

    private func warning(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle.fill")
            .font(.callout)
            .foregroundStyle(.orange)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func statusSymbol(_ status: ProjectOverview.Status) -> String {
        switch status {
        case .draft: "square.and.pencil"
        case .ready: "checkmark.circle"
        case .running: "play.circle"
        case .paused: "pause.circle"
        case .degraded: "exclamationmark.triangle"
        }
    }

    private func statusColor(_ status: ProjectOverview.Status) -> Color {
        switch status {
        case .draft: .blue
        case .ready: .green
        case .running: .accentColor
        case .paused: .orange
        case .degraded: .red
        }
    }

    private func stageSymbol(_ stage: ProjectOverview.Stage) -> String {
        switch stage.id {
        case .github: "chevron.left.forwardslash.chevron.right"
        case .rules: "line.3.horizontal.decrease.circle"
        case .development: "hammer"
        case .pullRequest: "arrow.triangle.pull"
        }
    }

    private func stageStatus(_ stage: ProjectOverview.Stage) -> String {
        switch stage.status {
        case "ready": "Ready"
        case "active": "Active"
        case "waiting": "Waiting"
        case "complete": "Complete"
        default: "Unavailable"
        }
    }

    private func stageColor(_ stage: ProjectOverview.Stage) -> Color {
        switch stage.status {
        case "ready", "complete": .green
        case "active": .accentColor
        case "waiting": .orange
        default: .red
        }
    }

    private func pollingSymbol(_ state: ProjectOverview.PollingState) -> String {
        switch state {
        case .live: "dot.radiowaves.left.and.right"
        case .reconnecting: "arrow.triangle.2.circlepath"
        case .failed: "exclamationmark.triangle.fill"
        case .paused: "pause.circle"
        case .unavailable: "questionmark.circle"
        }
    }

    private func pollingColor(_ state: ProjectOverview.PollingState) -> Color {
        switch state {
        case .live: .green
        case .reconnecting: .orange
        case .failed: .red
        case .paused: .orange
        case .unavailable: .secondary
        }
    }

    private func issueSymbol(_ status: ProjectOverview.Issue.Status) -> String {
        switch status {
        case .eligible: "checkmark.circle.fill"
        case .waiting: "clock"
        case .inProgress: "play.circle.fill"
        case .blocked: "link.badge.plus"
        case .ineligible: "minus.circle"
        case .unavailable: "questionmark.circle"
        }
    }

    private func issueColor(_ status: ProjectOverview.Issue.Status) -> Color {
        switch status {
        case .eligible: .green
        case .waiting: .orange
        case .inProgress: .accentColor
        case .blocked: .red
        case .ineligible: .secondary
        case .unavailable: .red
        }
    }
}
