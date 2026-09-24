import Foundation
import AppKit
import JarvisCore
import SwiftUI

func projectExecutionStatusSymbol(_ status: ProjectExecutionDetail.ExecutionStatus) -> String {
    switch status {
    case .queued: "clock"
    case .running: "arrow.clockwise.circle"
    case .cancelling: "stop.circle"
    case .completed: "checkmark.circle"
    case .failed, .timedOut: "exclamationmark.circle"
    case .cancelled: "minus.circle"
    }
}

/// Ticket #200: the nominal view is a readable stepper; identifiers, paths and
/// redacted payload excerpts stay behind Technical details.
struct ProjectExecutionDetailView: View {
    let model: ProjectExecutionDetailModel
    let timeline: ProjectTimelineModel
    let projectId: String
    let executionId: String
    var backLabel = "Retour à l’historique"
    let close: () -> Void

    @State private var isTechnicalDetailsExpanded = false
    @State private var isCancelConfirmationPresented = false
    @State private var copiedPullRequestURL: String?

    var body: some View {
        let state = model.state(for: projectId, executionId: executionId)
        let presentation = ProjectExecutionDetailPresentation(
            state, connection: timeline.connectionState)
        VStack(spacing: 0) {
            HStack {
                Button(backLabel, action: close)
                    .accessibilityIdentifier("execution.back")
                Spacer()
                Label(
                    presentation.connectionLabel,
                    systemImage: presentation.connectionSymbol)
                    .foregroundStyle(connectionColor)
                    .font(.caption.weight(.medium))
                    .accessibilityLabel("Actualisation : \(presentation.connectionLabel)")
            }
            .padding(.horizontal, 24)
            .padding(.top, 12)
            Group {
                switch presentation.state {
                case .loading:
                    ProgressView("Chargement du travail…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .failed(let message):
                    ContentUnavailableView {
                        Label("Travail indisponible", systemImage: "exclamationmark.triangle.fill")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Réessayer") {
                            Task { await model.refresh(projectId: projectId, executionId: executionId) }
                        }
                    }
                case .loaded(let detail):
                    detailContent(
                        detail,
                        staleMessage: presentation.isSnapshot ? presentation.connectionLabel : nil)
                case .stale(let detail, let message):
                    detailContent(detail, staleMessage: message)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .task(id: "\(projectId):\(executionId)") {
            async let live: Void = timeline.watchLive(projectId: projectId)
            await model.watch(projectId: projectId, executionId: executionId)
            _ = await live
        }
        .onChange(of: timeline.state(for: projectId).executions) { _, _ in
            Task { await model.refresh(projectId: projectId, executionId: executionId) }
        }
        .onChange(of: timeline.state(for: projectId).events) { _, _ in
            Task { await model.refresh(projectId: projectId, executionId: executionId) }
        }
        .onChange(of: executionId) { _, _ in copiedPullRequestURL = nil }
        .onChange(of: model.state(for: projectId, executionId: executionId).detail?.pullRequest?.url) { _, _ in copiedPullRequestURL = nil }
        .confirmationDialog(
            "Annuler cette exécution ?",
            isPresented: $isCancelConfirmationPresented,
            titleVisibility: .visible
        ) {
            Button("Annuler l’exécution", role: .destructive) {
                guard let cancellableExecutionId else { return }
                Task {
                    _ = await model.cancelExecution(
                        projectId: projectId,
                        executionId: executionId,
                        targetExecutionId: cancellableExecutionId)
                }
            }
            Button("Continuer l’exécution", role: .cancel) {}
        } message: {
            Text("Jarvis conserve le résultat final et applique la politique de conservation du dossier de travail après l’annulation.")
        }
    }

    private func detailContent(
        _ detail: ProjectExecutionDetail,
        staleMessage: String?
    ) -> some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let staleMessage {
                        HStack {
                            Label(staleMessage, systemImage: "exclamationmark.triangle.fill")
                                .font(.callout)
                                .foregroundStyle(.orange)
                            Spacer()
                            Button("Réessayer") {
                                Task {
                                    await model.refresh(projectId: projectId, executionId: executionId)
                                }
                            }
                            .accessibilityLabel("Recharger le détail de l’exécution")
                        }
                    }
                    header(detail)
                    if let failure = detail.failure {
                        failureCard(failure)
                    }
                    if detail.pullRequest != nil { pullRequestCard(detail.pullRequest) }
                    let layout = geometry.size.width >= 800
                        ? AnyLayout(HStackLayout(alignment: .top, spacing: 24))
                        : AnyLayout(VStackLayout(alignment: .leading, spacing: 16))
                    layout {
                        progressContent(detail).frame(maxWidth: .infinity, alignment: .leading)
                        contextContent(detail).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    DisclosureGroup("Détails des exécutions et fichiers") {
                        executionsCard(detail.executions)
                        workspaceCard(detail)
                        artifactsCard(detail.artifacts)
                        if !detail.checks.isEmpty {
                            checksCard(detail.checks)
                        }
                    }
                    technicalDetails(
                        detail.technical,
                        workspace: detail.workspace,
                        retryDeliveryId: detail.retryDeliveryId)
                }
                .frame(maxWidth: 1100, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(24)
            }
        }
    }

    private func progressContent(_ detail: ProjectExecutionDetail) -> some View {
        stepper(detail.steps)
    }

    private func contextContent(_ detail: ProjectExecutionDetail) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            GroupBox("Contexte") {
                VStack(alignment: .leading, spacing: 8) {
                    if detail.workspace != nil {
                        Label("Travail dans une copie isolée", systemImage: "folder")
                    } else {
                        Text("Aucune copie de travail renseignée pour cette exécution.")
                    }
                    Label("Relecture et fusion manuelles", systemImage: "person.crop.circle")
                }
                .font(.callout)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let latest = detail.agentExcerpts.last {
                excerptsCard([latest])
                if detail.agentExcerpts.count > 1 {
                    DisclosureGroup("Messages précédents de l’agent") {
                        excerptsCard(Array(detail.agentExcerpts.dropLast()))
                    }
                }
            } else {
                Text("Aucun message de l’agent disponible.").foregroundStyle(.secondary)
            }
        }
    }

    private func header(_ detail: ProjectExecutionDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                if let workItem = detail.workItem {
                    Text(workItem.title ?? workItem.ref)
                        .font(.title2.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    if let issueNumber = workItem.issueNumber {
                        Text("#\(issueNumber)")
                            .font(.callout.monospaced())
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Text("Suivi de l’exécution")
                        .font(.title2.weight(.semibold))
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                if let currentExecution {
                    Label(
                        ProjectExecutionDetailPresentation.executionStatusLabel(currentExecution.status),
                        systemImage: projectExecutionStatusSymbol(currentExecution.status))
                        .font(.callout.weight(.medium))
                        .foregroundStyle(executionColor(currentExecution.status))
                    if let durationMs = currentExecution.durationMs {
                        Label("Durée : \(formatDuration(durationMs))", systemImage: "stopwatch")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    } else if currentExecution.status == .running || currentExecution.status == .cancelling {
                        Label {
                            Text("Depuis \(currentExecution.createdAt, style: .relative)")
                        } icon: {
                            Image(systemName: "clock")
                        }
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    }
                }
                if let currentExecution,
                   currentExecution.status == .running || currentExecution.status == .cancelling,
                   let activeStep = detail.steps.first(where: {
                       $0.status == .active || $0.status == .repairing
                   }) {
                    Label("Étape : \(activeStep.label)", systemImage: stepSymbol(activeStep.status))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                if let lastActivity = detail.lastActivityAt {
                    Label {
                        Text("Dernière activité : \(lastActivity, style: .relative)")
                    } icon: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .font(.callout)
                    .foregroundStyle(.secondary)
                }
            }
            if let cancellableExecutionId,
               let execution = detail.executions.first(where: { $0.id == cancellableExecutionId }),
               execution.status == .running || execution.status == .cancelling {
                let detailState = model.state(for: projectId, executionId: executionId)
                let isCancelling = detailState.isCancelling || execution.status == .cancelling
                HStack {
                    Spacer()
                    Button(role: .destructive) {
                        isCancelConfirmationPresented = true
                    } label: {
                        Label(
                            isCancelling ? "Annulation…" : "Annuler le travail",
                            systemImage: "stop.circle")
                    }
                    .disabled(isCancelling)
                    .accessibilityIdentifier("execution.cancel")
                    .accessibilityLabel(
                        isCancelling
                            ? "Annulation de l’exécution"
                            : "Annuler l’exécution")
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
    }

    private func executionsCard(
        _ executions: [ProjectExecutionDetail.Execution]
    ) -> some View {
        GroupBox {
            if executions.isEmpty {
                Text("Information indisponible")
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(executions) { execution in
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(execution.moduleInstanceId)
                                    .font(.body.monospaced())
                                Text("Tentative \(execution.attempt) · \(execution.id)")
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 2) {
                                Text(ProjectExecutionDetailPresentation.executionStatusLabel(execution.status))
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(executionColor(execution.status))
                                if let durationMs = execution.durationMs {
                                    Text(formatDuration(durationMs))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
        } label: {
            Label("Exécutions", systemImage: "clock.arrow.circlepath")
        }
    }

    private func stepper(_ steps: [ProjectExecutionDetail.Step]) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Avancement").font(.title2.weight(.semibold))
            if steps.isEmpty {
                Label("Aucune étape détaillée disponible.", systemImage: "list.number")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                    HStack(alignment: .top, spacing: 12) {
                        VStack(spacing: 6) {
                            Image(systemName: stepSymbol(step.status))
                                .font(.title3).foregroundStyle(stepColor(step.status))
                            if index < steps.count - 1 {
                                Rectangle().fill(.quaternary).frame(width: 1)
                            }
                        }
                        .frame(width: 24)
                        .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(step.label).font(.headline)
                                Spacer(minLength: 8)
                                Text(ProjectExecutionDetailPresentation.stepStatusLabel(step.status))
                                    .font(.callout.weight(.medium))
                                    .foregroundStyle(stepColor(step.status))
                            }
                            Text(step.detail).font(.callout).foregroundStyle(.secondary)
                            if let date = step.occurredAt {
                                Text(date, format: .dateTime).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.bottom, 12)
                        .accessibilityElement(children: .combine)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func excerptsCard(_ excerpts: [ProjectExecutionDetail.AgentExcerpt]) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(excerpts) { excerpt in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(excerpt.occurredAt, format: .dateTime)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text(excerpt.text)
                            .font(.callout.monospaced())
                            .textSelection(.enabled)
                        if excerpt.truncated {
                            Text("Extrait tronqué")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        } label: {
            Label("Message de l’agent", systemImage: "text.bubble")
        }
    }

    private func checksCard(_ checks: [ProjectExecutionDetail.Check]) -> some View {
        GroupBox {
            if checks.isEmpty {
                Text("Information indisponible")
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(checks) { check in
                        HStack(alignment: .firstTextBaseline) {
                            Image(systemName: checkSymbol(check.status))
                                .foregroundStyle(checkColor(check.status))
                                .accessibilityHidden(true)
                            Text("\(check.name) · tentative \(check.attempt)").font(.body.monospaced())
                            Spacer()
                            Text(ProjectExecutionDetailPresentation.checkStatusLabel(check.status))
                                .foregroundStyle(checkColor(check.status))
                            if let durationMs = check.durationMs {
                                Text(formatDuration(durationMs))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        if let output = check.output {
                            DisclosureGroup("Sortie de \(check.name) — tentative \(check.attempt)") {
                                Text(output).font(.caption.monospaced()).textSelection(.enabled)
                            }
                        }
                    }
                }
            }
        } label: {
            Label("Vérifications rapportées", systemImage: "checkmark.shield")
        }
    }

    private func workspaceCard(_ detail: ProjectExecutionDetail) -> some View {
        GroupBox {
            if let workspace = detail.workspace {
                VStack(alignment: .leading, spacing: 5) {
                    Text("État : \(workspace.status)")
                    Text("Branche : \(workspace.branch)").font(.caption.monospaced())
                    Text("Informations dans les détails techniques.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("Information indisponible")
                    .foregroundStyle(.secondary)
            }
        } label: {
            Label("Copie de travail", systemImage: "folder")
        }
    }

    private func artifactsCard(
        _ artifacts: [ProjectExecutionDetail.Artifact]?
    ) -> some View {
        GroupBox {
            if let artifacts, !artifacts.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(artifacts) { artifact in
                        Label(artifact.label, systemImage: "doc")
                            .accessibilityValue(artifact.ref)
                    }
                }
            } else {
                Text("Information indisponible")
                    .foregroundStyle(.secondary)
            }
        } label: {
            Label("Fichiers produits", systemImage: "doc.on.doc")
        }
    }

    private func pullRequestCard(
        _ pullRequest: ProjectExecutionDetail.PullRequest?
    ) -> some View {
        GroupBox {
            if let pullRequest {
                VStack(alignment: .leading, spacing: 8) {
                    if let number = pullRequest.number {
                        Text("#\(number) \(pullRequest.title ?? "Pull Request")")
                            .font(.body.weight(.medium))
                    } else {
                        Text(pullRequest.title ?? "Pull Request")
                            .font(.body.weight(.medium))
                    }
                    if let urlString = pullRequest.url, let url = URL(string: urlString) {
                        HStack {
                            Link("Ouvrir la PR", destination: url)
                                .accessibilityIdentifier("execution.pull-request.open")
                            Button(copiedPullRequestURL == urlString ? "Lien copié" : "Copier le lien") {
                                NSPasteboard.general.clearContents()
                                if NSPasteboard.general.setString(urlString, forType: .string) { copiedPullRequestURL = urlString }
                            }
                            .accessibilityIdentifier("execution.pull-request.copy")
                            .accessibilityHint("Copier le lien de la PR créée et vérifiée par GitHub")
                        }
                    } else {
                        Text("URL indisponible")
                            .foregroundStyle(.secondary)
                    }
                    Label(
                        "Relecture et fusion manuelles.",
                        systemImage: "person.crop.circle.badge.checkmark")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("Information indisponible")
                    .foregroundStyle(.secondary)
            }
        } label: {
            Label("Pull Request", systemImage: "arrow.triangle.pull")
        }
    }

    private func technicalDetails(
        _ technical: ProjectExecutionDetail.Technical,
        workspace: ProjectExecutionDetail.Workspace?,
        retryDeliveryId: String?
    ) -> some View {
        DisclosureGroup("Détails techniques", isExpanded: $isTechnicalDetailsExpanded) {
            VStack(alignment: .leading, spacing: 8) {
                labeledIDs("Input event IDs", technical.inputEventIds)
                if let correlationId = technical.correlationId {
                    labeledIDs("Correlation ID", [correlationId])
                }
                labeledIDs("Causation IDs", technical.causationIds)
                labeledIDs("Retry delivery ID", retryDeliveryId.map { [$0] } ?? [])
                if let workspace {
                    Text("Dossier dans les données Jarvis : \(workspace.path)")
                        .font(.caption.monospaced())
                        .textSelection(.disabled)
                    Text("Base revision: \(workspace.baseRevisionSha)")
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                }
                ForEach(technical.events) { event in
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(event.type) · \(event.occurredAt, format: .dateTime)")
                            .font(.caption.weight(.medium))
                        Text("Event \(event.id)")
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                        Text(event.payloadExcerpt)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 3)
                }
            }
        }
        .font(.callout)
    }

    private func labeledIDs(_ label: String, _ ids: [String]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption.weight(.medium))
            if ids.isEmpty {
                Text("Information indisponible")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(ids, id: \.self) { id in
                    Text(id).font(.caption.monospaced()).textSelection(.enabled)
                }
            }
        }
    }

    private var currentExecution: ProjectExecutionDetail.Execution? {
        model.state(for: projectId, executionId: executionId).detail?.executions.last
    }

    private var cancellableExecutionId: String? {
        model.state(for: projectId, executionId: executionId).detail?.cancellableExecutionId
    }

    private var connectionColor: Color {
        switch timeline.connectionState {
        case .live: .green
        case .reconnecting: .orange
        case .failed: .secondary
        }
    }

    private func stepSymbol(_ status: ProjectExecutionDetail.Step.Status) -> String {
        switch status {
        case .proved: "checkmark.circle.fill"
        case .active: "circle.dotted"
        case .repairing: "wrench.and.screwdriver"
        case .notStarted: "circle"
        case .failed: "xmark.octagon.fill"
        case .cancelled: "minus.circle"
        case .unavailable: "questionmark.circle"
        }
    }

    private func stepColor(_ status: ProjectExecutionDetail.Step.Status) -> Color {
        switch status {
        case .proved: .green
        case .active: .accentColor
        case .repairing: .orange
        case .notStarted: .secondary
        case .failed: .red
        case .cancelled: .orange
        case .unavailable: .secondary
        }
    }

    private func checkSymbol(_ status: ProjectExecutionDetail.Check.Status) -> String {
        switch status {
        case .passed: "checkmark.circle.fill"
        case .running: "circle.dotted"
        case .cancelled: "minus.circle"
        case .failed: "xmark.octagon.fill"
        case .unavailable: "questionmark.circle"
        }
    }

    private func checkColor(_ status: ProjectExecutionDetail.Check.Status) -> Color {
        switch status {
        case .passed: .green
        case .running: .accentColor
        case .cancelled: .orange
        case .failed: .red
        case .unavailable: .secondary
        }
    }

    private func executionColor(_ status: ProjectExecutionDetail.ExecutionStatus) -> Color {
        switch status {
        case .completed: .green
        case .failed, .timedOut: .red
        case .cancelled, .cancelling: .orange
        case .queued, .running: .accentColor
        }
    }

    private func formatDuration(_ durationMs: Int) -> String {
        durationMs < 1000 ? "\(durationMs) ms" : String(format: "%.2f s", Double(durationMs) / 1000)
    }

    private func failureCard(_ failure: ProjectExecutionDetail.Failure) -> some View {
        let cancelled = failure.code.contains("cancelled")
        return GroupBox {
            VStack(alignment: .leading, spacing: 6) {
                Label(failure.message, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(cancelled ? .orange : .red)
                Text(failure.impact).font(.callout)
                Text(failure.nextAction).font(.callout).foregroundStyle(.secondary)
                Button("Ouvrir les détails techniques") {
                    isTechnicalDetailsExpanded = true
                }
                if model.state(for: projectId, executionId: executionId).detail?.retryDeliveryId != nil {
                    Button("Relancer l’exécution") {
                        Task { _ = await model.retry(projectId: projectId, executionId: executionId) }
                    }
                    .disabled(model.state(for: projectId, executionId: executionId).isRetrying)
                    .accessibilityLabel("Relancer l’exécution après correction")
                    .accessibilityIdentifier("execution.retry")
                }
            }
        } label: {
            Label(cancelled ? "Exécution annulée" : "Échec à examiner", systemImage: cancelled ? "minus.circle" : "xmark.octagon")
        }
    }
}
