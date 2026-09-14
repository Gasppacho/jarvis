import JarvisCore
import SwiftUI

/// Ticket #199: the first answer after a Project is activated. The view is a
/// native reading surface; eligibility and pause policy come from the Engine.
struct ProjectOverviewView: View {
    let model: ProjectOverviewModel
    let projects: ProjectsModel
    let executionDetail: ProjectExecutionDetailModel
    let projectId: String
    var onOpenExecution: ((String) -> Void)? = nil
    var onOpenComposition: (() -> Void)? = nil
    @State private var issueFilter = ""

    var body: some View {
        let presentation = ProjectOverviewPresentation(model.state(for: projectId))
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                switch presentation.state {
                case .loading:
                    ProgressView("Chargement de la supervision…")
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
            await model.watch(projectId: projectId)
        }
    }

    private func overviewContent(_ overview: ProjectOverview) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            header(overview)
            if let issue = ProjectOverviewPresentation.focusedIssue(overview) {
                focusedWork(issue)
            }
            issuesCard(overview)
            DisclosureGroup("Surveillance et workflow") {
                pollingCard(overview)
                workflowCard(overview)
            }
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
            if let ref = overview.selectedWorkItemRef {
                Label("Essai limité à \(ProjectPreflightState.issueLabel(ref))", systemImage: "scope").font(.headline)
            }
            HStack {
                Label(ProjectOverviewPresentation.pollingLabel(overview.polling.state), systemImage: pollingSymbol(overview.polling.state))
                    .foregroundStyle(pollingColor(overview.polling.state))
                if let date = overview.polling.lastPollAt {
                    Text("Dernier contrôle GitHub : \(date, format: .dateTime)").font(.caption)
                }
            }
            if overview.polling.state == .reconnecting || overview.polling.state == .failed {
                Text("Les issues affichées viennent du dernier contrôle terminé. La connexion doit être rétablie.").foregroundStyle(.orange)
            }
            Text(overview.nextStep)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                switch overview.primaryAction {
                case .pause:
                    Button("Mettre les nouveaux départs en pause") {
                        Task {
                            await model.pause(projectId: projectId)
                            await projects.refresh()
                        }
                    }
                    .accessibilityIdentifier("project.overview.pause")
                    .help("Empêche les nouveaux départs. Le travail actif continue ; ouvrez-le pour l’annuler.")
                case .resume:
                    Button("Reprendre les nouveaux départs") {
                        Task {
                            await model.resume(projectId: projectId)
                            await projects.refresh()
                        }
                    }
                    .accessibilityIdentifier("project.overview.resume")
                case .activate:
                    Text("Terminez la configuration pour activer le projet.")
                        .foregroundStyle(.secondary)
                case .refresh:
                    EmptyView()
                }
                Button {
                    Task { await model.retryPolling(projectId: projectId) }
                } label: {
                    Label("Actualiser", systemImage: "arrow.clockwise")
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
                if let onOpenComposition {
                    Button("Ouvrir la composition") { onOpenComposition() }
                        .accessibilityIdentifier("project.overview.open-composition")
                }
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
                    Text("Dernier contrôle : \(lastPollAt, format: .dateTime)")
                        .font(.callout)
                } else {
                    Text("Aucun contrôle GitHub terminé pour le moment.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                if let errorReason = overview.polling.errorReason {
                    Label("Motif de reprise : \(errorReason)", systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if overview.polling.state == .failed || overview.polling.state == .unavailable {
                    Button("Réessayer le contrôle GitHub") {
                        Task { await model.retryPolling(projectId: projectId) }
                    }
                    .disabled(model.state(for: projectId).isLoading)
                }
            }
        } label: {
            Label("Surveillance GitHub", systemImage: "arrow.triangle.2.circlepath")
        }
    }

    private func focusedWork(_ issue: ProjectOverview.Issue) -> some View {
        GroupBox(issue.status == .inProgress ? "Travail en cours" : "Dernier travail") {
            VStack(alignment: .leading, spacing: 10) {
                Text("#\(issue.issueNumber) — \(issue.title)").font(.title3.bold())
                Label(ProjectOverviewPresentation.workStatusLabel(issue), systemImage: issue.reason == "execution-failed" ? "exclamationmark.triangle.fill" : "clock")
                if let id = issue.executionId {
                    let snapshot = executionDetail.state(for: projectId, executionId: id)
                    if let detail = snapshot.detail {
                        if let step = detail.steps.last(where: { [.active, .repairing, .failed].contains($0.status) }) ?? detail.steps.last(where: { $0.status == .proved }) {
                            Text("\(step.label) · \(ProjectExecutionDetailPresentation.stepStatusLabel(step.status))").font(.headline)
                        }
                        if let failure = detail.failure {
                            Text(failure.message).foregroundStyle(.orange)
                            Text(failure.nextAction).font(.callout)
                        }
                        if detail.pullRequest?.url != nil { Text("PR créée — prête à relire") }
                        if let date = detail.lastActivityAt {
                            Text("Dernière activité : \(date, format: .dateTime)").font(.caption)
                        }
                    } else if snapshot.isLoading {
                        ProgressView("Chargement de l’étape…")
                    }
                    if let error = snapshot.errorMessage {
                        Label("Dernier état conservé : \(error)", systemImage: "network.slash").foregroundStyle(.orange)
                    }
                    if let start = issue.executionStartedAt {
                        HStack {
                            Text("Durée :")
                            if let end = issue.executionCompletedAt {
                                Text("\(max(0, end.timeIntervalSince(start)), specifier: "%.0f") s")
                            } else { Text(start, style: .timer) }
                        }.font(.caption)
                    }
                    Button("Ouvrir le travail") { onOpenExecution?(id) }
                        .accessibilityIdentifier("project.overview.open-work")
                        .accessibilityHint("Voir les étapes, le résultat et l’annulation de l’issue \(issue.issueNumber)")
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: "\(projectId):\(issue.executionId ?? "")") {
            if let id = issue.executionId { await executionDetail.watch(projectId: projectId, executionId: id) }
        }
    }

    private func issuesCard(_ overview: ProjectOverview) -> some View {
        let focused = ProjectOverviewPresentation.focusedIssue(overview)?.id
        let ready = overview.issues.filter { $0.id != focused && $0.status == .eligible }
        let attention = overview.issues.filter { $0.id != focused && $0.status == .unavailable }
        let others = overview.issues.filter { $0.id != focused && $0.status != .eligible && $0.status != .unavailable }
        return VStack(alignment: .leading, spacing: 12) {
            if !attention.isEmpty {
                GroupBox("Actions requises") {
                    ForEach(attention) { issueRow($0) }
                }
            }
            GroupBox("Issues prêtes (\(ready.count))") {
                VStack(alignment: .leading, spacing: 10) {
                    Text(overview.readinessHelp).font(.callout).foregroundStyle(.secondary)
                    if ready.isEmpty { Text("Aucune autre issue prête dans le dernier contrôle GitHub.") }
                    ForEach(ready) { issueRow($0) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            DisclosureGroup("Autres issues (\(others.count))") {
                TextField("Filtrer par titre ou numéro", text: $issueFilter)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("project.overview.issue-filter")
                ForEach(others.filter { issueFilter.isEmpty || "\($0.issueNumber) \($0.title)".localizedCaseInsensitiveContains(issueFilter) }) { issueRow($0) }
            }
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
                Text("Bloqueurs ouverts : \(issue.openDependencyCount)")
                    .font(.caption.weight(.medium))
                ForEach(issue.blockerRefs, id: \.self) { blocker in
                    Text(ProjectPreflightState.issueLabel(blocker))
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let executionId = issue.executionId, let onOpenExecution {
                Button("Ouvrir le travail") { onOpenExecution(executionId) }
                    .accessibilityLabel("Ouvrir le travail de l’issue \(issue.issueNumber)")
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
            Label("Supervision indisponible", systemImage: "exclamationmark.triangle.fill")
        } description: {
            Text(message)
        } actions: {
            Button("Réessayer") { Task { await model.refresh(projectId: projectId) } }
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
