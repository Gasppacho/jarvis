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
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    switch presentation.state {
                    case .loading:
                        ProgressView("Chargement de la supervision…")
                            .frame(maxWidth: .infinity, minHeight: 240)
                    case .failed(let message):
                        unavailable(message)
                    case .loaded(let overview):
                        overviewContent(overview, wide: geometry.size.width >= 800)
                    case .stale(let overview, let message):
                        warning(message)
                        overviewContent(overview, wide: geometry.size.width >= 800)
                    }
                }
                .frame(maxWidth: 1100, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(32)
            }
            .background(JarvisVisual.canvas)
        }
        .task(id: projectId) {
            await model.watch(projectId: projectId)
        }
    }

    private func overviewContent(_ overview: ProjectOverview, wide: Bool) -> some View {
        VStack(alignment: .leading, spacing: 24) {
            header(overview)
            if let issue = ProjectOverviewPresentation.focusedIssue(overview) {
                focusedWork(issue)
            }
            workflowCard(overview, wide: wide)
            issuesCard(overview, wide: wide)
            DisclosureGroup("Diagnostic technique du projet") {
                pollingCard(overview)
            }
        }
    }

    private func header(_ overview: ProjectOverview) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("SUPERVISION")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .tracking(1.2)
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(overview.name)
                        .font(.largeTitle.weight(.semibold))
                        .tracking(-0.8)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(overview.nextStep)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                JarvisStatusBadge(
                    title: ProjectOverviewPresentation.projectStatusLabel(overview.status),
                    symbol: statusSymbol(overview.status),
                    color: statusColor(overview.status))
            }
            if let ref = overview.selectedWorkItemRef {
                Label("Essai limité à \(ProjectPreflightState.issueLabel(ref))", systemImage: "scope")
                    .font(.callout.weight(.medium))
            }
            HStack(spacing: 12) {
                JarvisStatusBadge(
                    title: ProjectOverviewPresentation.pollingLabel(overview.polling.state),
                    symbol: pollingSymbol(overview.polling.state),
                    color: pollingColor(overview.polling.state))
                if let date = overview.polling.lastPollAt {
                    Text("Dernier contrôle : \(date, style: .relative)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if overview.polling.state == .reconnecting || overview.polling.state == .failed {
                Text("Les issues affichées viennent du dernier contrôle terminé. La connexion doit être rétablie.").foregroundStyle(.orange)
            }
            HStack(spacing: 8) {
                switch overview.primaryAction {
                case .pause:
                    Button("Suspendre les nouvelles issues") {
                        Task {
                            await model.pause(projectId: projectId)
                            await projects.refresh()
                        }
                    }
                    .accessibilityIdentifier("project.overview.pause")
                    .help("Empêche les nouveaux départs. Le travail actif continue ; ouvrez-le pour l’annuler.")
                case .resume:
                    Button("Reprendre la surveillance") {
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
                .buttonStyle(.bordered)
                .disabled(model.state(for: projectId).isLoading)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func workflowCard(_ overview: ProjectOverview, wide: Bool) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Votre workflow")
                    .font(.title2.weight(.semibold))
                Spacer()
                if let onOpenComposition {
                    Button("Configurer", systemImage: "slider.horizontal.3", action: onOpenComposition)
                        .accessibilityIdentifier("project.overview.open-composition")
                }
            }
            if overview.stages.isEmpty {
                Text("Aucun module actif. Configurez ce projet pour construire son workflow.")
                    .foregroundStyle(.secondary)
            }
            let layout = wide
                ? AnyLayout(HStackLayout(alignment: .center, spacing: 10))
                : AnyLayout(VStackLayout(alignment: .leading, spacing: 10))
            layout {
                ForEach(Array(overview.stages.enumerated()), id: \.element.id) { index, stage in
                    if index > 0, wide {
                        Image(systemName: "chevron.right")
                            .foregroundStyle(.tertiary)
                            .padding(.top, 2)
                            .accessibilityHidden(true)
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Image(systemName: stageSymbol(stage))
                            .font(.title3)
                            .foregroundStyle(stageColor(stage))
                        Text(stage.id == .development ? "Développement" : stage.label)
                            .font(.headline)
                        Text(stage.detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        JarvisStatusBadge(title: stageStatus(stage),
                                          symbol: stageStatusSymbol(stage),
                                          color: stageColor(stage))
                    }
                    .frame(maxWidth: .infinity, minHeight: 120, alignment: .leading)
                    .padding(14)
                    .background(JarvisVisual.surface, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(JarvisVisual.border))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(stage.label): \(stageStatus(stage)). \(stage.detail)")
                }
            }
        }
        .jarvisSurface()
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
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(issue.status == .inProgress ? "Travail en cours" : "Dernier travail")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                    .textCase(.uppercase)
                Spacer()
                JarvisStatusBadge(
                    title: ProjectOverviewPresentation.workStatusLabel(issue),
                    symbol: issue.reason == "execution-failed" ? "exclamationmark.triangle.fill" : issueSymbol(issue.status),
                    color: issueColor(issue.status))
            }
            VStack(alignment: .leading, spacing: 12) {
                Text(issue.title).font(.title2.weight(.semibold))
                Text("Issue #\(issue.issueNumber)")
                    .font(.callout)
                    .foregroundStyle(.secondary)
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
                    Button("Suivre le travail", systemImage: "arrow.up.right") { onOpenExecution?(id) }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("project.overview.open-work")
                        .accessibilityHint("Voir les étapes, le résultat et l’annulation de l’issue \(issue.issueNumber)")
                }
            }
        }
        .jarvisSurface(highlighted: issue.status == .inProgress)
        .task(id: "\(projectId):\(issue.executionId ?? "")") {
            if let id = issue.executionId { await executionDetail.watch(projectId: projectId, executionId: id) }
        }
    }

    private func issuesCard(_ overview: ProjectOverview, wide: Bool) -> some View {
        let issues = overview.issues.filter {
            issueFilter.isEmpty || "\($0.issueNumber) \($0.title)".localizedCaseInsensitiveContains(issueFilter)
        }
        return VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Issues suivies").font(.title2.weight(.semibold))
                Spacer()
            }
            Text(overview.readinessHelp).font(.callout).foregroundStyle(.secondary)
            TextField("Filtrer par titre ou numéro", text: $issueFilter)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 320)
                .accessibilityIdentifier("project.overview.issue-filter")
            if issues.isEmpty {
                Text(overview.issues.isEmpty ? "Aucune issue dans le dernier contrôle GitHub." : "Aucune issue ne correspond au filtre.")
                    .foregroundStyle(.secondary)
            }
            if !issues.isEmpty {
                if wide {
                    HStack(spacing: 20) {
                        Text("ISSUE").frame(maxWidth: .infinity, alignment: .leading)
                        Text("SITUATION").frame(width: 150, alignment: .leading)
                        Text("PROCHAINE ÉTAPE").frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.top, 8)
                }
                Divider()
                ForEach(issues) { issue in
                    issueRow(issue, wide: wide)
                    Divider()
                }
            }
        }
    }

    private func issueRow(_ issue: ProjectOverview.Issue, wide: Bool) -> some View {
        let layout = wide
            ? AnyLayout(HStackLayout(alignment: .top, spacing: 20))
            : AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
        return layout {
            issueTitle(issue).frame(maxWidth: .infinity, alignment: .leading)
            issueSituation(issue).frame(width: wide ? 150 : nil, alignment: .leading)
            issueNextStep(issue).frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
    }

    private func issueTitle(_ issue: ProjectOverview.Issue) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let executionId = issue.executionId, let onOpenExecution {
                Button(issue.title) { onOpenExecution(executionId) }
                    .buttonStyle(.link)
                    .accessibilityLabel("Ouvrir le travail de l’issue \(issue.issueNumber) : \(issue.title)")
            } else {
                Text(issue.title).fontWeight(.medium)
            }
            Text("#\(issue.issueNumber)").font(.caption).foregroundStyle(.secondary)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func issueSituation(_ issue: ProjectOverview.Issue) -> some View {
        Label(ProjectOverviewPresentation.workStatusLabel(issue), systemImage: issueSymbol(issue.status))
            .font(.callout.weight(.medium))
            .foregroundStyle(issueColor(issue.status))
            .fixedSize(horizontal: false, vertical: true)
    }

    private func issueNextStep(_ issue: ProjectOverview.Issue) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(issue.explanation)
            if issue.openDependencyCount > 0 {
                Text("Bloqueurs ouverts : \(issue.openDependencyCount)").fontWeight(.medium)
                ForEach(issue.blockerRefs, id: \.self) { blocker in
                    Text(ProjectPreflightState.issueLabel(blocker)).foregroundStyle(.secondary)
                }
            }
        }
        .font(.callout)
        .fixedSize(horizontal: false, vertical: true)
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
        case .development: "hammer"
        case .pullRequest: "arrow.triangle.pull"
        }
    }

    private func stageStatus(_ stage: ProjectOverview.Stage) -> String {
        switch stage.status {
        case "ready": "Prêt"
        case "active": "En cours"
        case "waiting": "En attente"
        case "complete": "Terminé"
        default: "Indisponible"
        }
    }

    private func stageStatusSymbol(_ stage: ProjectOverview.Stage) -> String {
        switch stage.status {
        case "ready": "checkmark.circle"
        case "active": "play.circle.fill"
        case "waiting": "clock"
        case "complete": "checkmark.circle.fill"
        default: "exclamationmark.triangle"
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
