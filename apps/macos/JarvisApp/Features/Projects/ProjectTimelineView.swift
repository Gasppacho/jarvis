import JarvisCore
import SwiftUI

/// Ticket #61/#62: the Project's durable truth — Events and Executions from
/// ticket #59, read as one chronological reading grouped by correlation —
/// kept live by subscribing to the Engine's live channel
/// (`ProjectTimelineModel.watchLive`). A dropped connection, a sequence gap
/// or a new Engine Session discards whatever was accumulated incrementally
/// and reloads the REST snapshot rather than patching over a hole
/// (apps/macos/CONTEXT.md: Live Update is ephemeral, durable truth is
/// queryable).
struct ProjectTimelineView: View {
    let timeline: ProjectTimelineModel
    let projectId: String
    var onOpenDetail: ((String) -> Void)? = nil

    var body: some View {
        // Read once per render: `presentation` rebuilds the id dictionary,
        // row maps and group sort from scratch on every access — findings-
        // review #61-4.
        let presentation = presentation
        VStack(spacing: 0) {
            // findings-review #62-5: the connection badge shows in every
            // state — `.loading`, `.failed`, `.empty`, the list: the
            // screen's live status is independent of whether the durable
            // content is empty, loading or failed, so a stale view can never
            // pass for a current one.
            HStack(spacing: 8) {
                Spacer()
                connectionStateBadge
            }
            .padding(.horizontal, 24)
            .padding(.top, 12)
            Group {
                switch presentation.status {
                case .loading:
                    ProgressView("Chargement de l’historique…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .failed(let message):
                    ContentUnavailableView {
                        Label("Historique indisponible", systemImage: "exclamationmark.triangle.fill")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Réessayer") { Task { await timeline.refresh(projectId: projectId) } }
                    }
                case .empty:
                    ContentUnavailableView {
                        Label("Aucune activité pour l’instant", systemImage: "clock")
                    } description: {
                        Text("Les événements et les exécutions apparaîtront ici quand le projet aura démarré.")
                    } actions: {
                        Button("Actualiser") { Task { await timeline.refresh(projectId: projectId) } }
                    }
                case .loaded, .refreshing:
                    // `.refreshing` renders the same previous, complete snapshot
                    // as `.loaded`, plus a subdued in-place cue — never the
                    // full-pane spinner, which would blank a long Timeline and
                    // lose scroll position on every "Refresh Timeline" click
                    // (findings-review #61-2).
                    timelineList(presentation)
                case .stale(let message):
                    // findings-review #62-4: a failed reload over an already
                    // loaded Timeline renders the last snapshot with the
                    // failure alongside it — never the full-pane failure,
                    // which would lose the content.
                    timelineList(presentation, staleMessage: message)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        // Follows the tab actually being shown, in both directions: it never
        // fires for a Project whose Timeline tab is never opened, and it
        // refires whenever the shown Project changes while this tab stays
        // open (findings-review #61-1). Moved here from `ProjectDetailView`,
        // which fired on every sidebar click regardless of the selected tab.
        // Cancelled by SwiftUI on Project switch or when this screen
        // disappears — `ProjectTimelineModel.watchLive` closes the stream in
        // that same cancellation (`EngineEventStream.connect`'s
        // `onTermination`), so leaving the screen leaves no retained
        // connection or background work.
        .task(id: projectId) {
            await timeline.watchLive(projectId: projectId)
        }
    }

    /// The durable rows. `staleMessage` is set only by the `.stale` status:
    /// the last good snapshot, with the failed reload surfaced above it
    /// (findings-review #62-4).
    private func timelineList(
        _ presentation: ProjectTimelinePresentation, staleMessage: String? = nil
    ) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let staleMessage {
                    Label(staleMessage, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                HStack(spacing: 8) {
                    Button("Actualiser l’historique", systemImage: "arrow.clockwise") {
                        Task { await timeline.refresh(projectId: projectId) }
                    }
                    .disabled(presentation.status == .refreshing)
                    if presentation.status == .refreshing {
                        ProgressView().controlSize(.small)
                        Text("Actualisation…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                ForEach(presentation.groups) { group in
                    groupCard(group)
                }
            }
            .frame(maxWidth: 1040, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)
        }
    }

    /// Ticket #62: live vs. reconnecting vs. failed, so a stale view never
    /// passes for a current one. Shown in the screen's chrome in every state
    /// (findings-review #62-5) — durable content keeps showing regardless of
    /// the badge: a Timeline that cannot go live still shows correct content
    /// from the last snapshot.
    private var connectionStateBadge: some View {
        let (label, symbol, color): (String, String, Color) =
            switch timeline.connectionState {
            case .live: ("En direct", "dot.radiowaves.left.and.right", .green)
            case .reconnecting: ("Reconnexion…", "arrow.triangle.2.circlepath", .orange)
            case .failed: ("Déconnecté", "exclamationmark.triangle.fill", .red)
        }
        return Label(label, systemImage: symbol)
            .font(.caption.weight(.medium))
            .foregroundStyle(color)
            .accessibilityLabel("Mises à jour : \(label)")
    }

    private var presentation: ProjectTimelinePresentation {
        let state = timeline.state(for: projectId)
        return ProjectTimelinePresentation(
            events: state.events,
            executions: state.executions,
            isLoading: state.isLoading,
            errorMessage: state.errorMessage,
            pendingCancellationIDs: state.pendingCancellationIDs,
            cancellationErrorMessages: state.cancellationErrorMessages)
    }

    private func groupCard(_ group: ProjectTimelinePresentation.Group) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                // Correlation IDs are available on demand, while ordinary
                // history remains readable without exposing engine identifiers.
                if let correlationId = group.correlationId {
                    DisclosureGroup("Détails techniques") {
                        LabeledContent("ID de corrélation") {
                            Text(correlationId)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                        }
                    }
                    .font(.caption)
                }
                ForEach(group.rows) { row in
                    rowView(row)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func rowView(_ row: ProjectTimelinePresentation.Row) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: symbol(for: row.kind))
                    .font(.title3)
                    .foregroundStyle(color(for: row))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            rowTitle(row)
                            Spacer(minLength: 8)
                            if let executionStatus = row.executionStatus {
                                statusLabel(executionStatus)
                            }
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            rowTitle(row)
                            if let executionStatus = row.executionStatus {
                                statusLabel(executionStatus)
                            }
                        }
                    }
                    Text("Module · \(row.moduleInstance)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let subject = row.subject {
                        Text("Sujet · \(subject)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let attempt = row.attempt {
                        Text("Tentative \(attempt)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    if let completedAt = row.completedAt {
                        Text("Terminée \(completedAt, format: .dateTime)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    if let causingEvent = row.causingEvent {
                        Text("Déclenchée par · \(causingEvent.type)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    if let parentEvent = row.parentEvent {
                        Text("Liée à · \(parentEvent.type)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Text("Survenu le \(row.occurredAt, format: .dateTime)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    if let cancellationErrorMessage = row.cancellationErrorMessage {
                        Label(cancellationErrorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(row.accessibilityLabel)
            }
            if row.executionStatus == .running || (row.executionStatus != nil && onOpenDetail != nil) {
                HStack(spacing: 8) {
                    Spacer()
                    if row.executionStatus == .running {
                        Button(role: .destructive) {
                            Task {
                                _ = await timeline.cancelExecution(
                                    projectId: projectId,
                                    executionId: String(row.id.dropFirst("execution:".count)))
                            }
                        } label: {
                            Label(
                                row.isCancellationPending ? "Annulation…" : "Annuler",
                                systemImage: "stop.circle")
                        }
                        .disabled(row.isCancellationPending)
                        .accessibilityLabel(
                            row.isCancellationPending
                                ? "Annulation de \(row.title) pour \(row.moduleInstance)"
                                : "Annuler \(row.title) pour \(row.moduleInstance)")
                    }
                    if row.executionStatus != nil, let onOpenDetail {
                        Button {
                            onOpenDetail(String(row.id.dropFirst("execution:".count)))
                        } label: {
                            Label("Ouvrir le suivi", systemImage: "arrow.right")
                        }
                        .accessibilityLabel("Ouvrir le suivi de \(row.title)")
                    }
                }
                .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 8)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func rowTitle(_ row: ProjectTimelinePresentation.Row) -> some View {
        Text(row.title)
            .font(.body.weight(.medium))
            .fixedSize(horizontal: false, vertical: true)
    }

    private func symbol(for kind: ProjectTimelinePresentation.Row.Kind) -> String {
        switch kind {
        case .request: "arrow.right.circle"
        case .fact: "checkmark.circle"
        case .execution: "gearshape"
        }
    }

    private func color(for row: ProjectTimelinePresentation.Row) -> Color {
        switch row.kind {
        case .request: .blue
        case .fact: .green
        case .execution: executionColor(row.executionStatus)
        }
    }

    private func executionColor(_ status: TimelineExecution.Status?) -> Color {
        guard let status else { return .secondary }
        switch status {
        case .failed, .timedOut: return .red
        case .cancelled, .cancelling: return .orange
        case .completed: return .green
        case .running: return .accentColor
        case .queued: return .secondary
        }
    }

    private func statusLabel(_ status: TimelineExecution.Status) -> some View {
        Label(statusText(status), systemImage: statusSymbol(status))
            .font(.caption.weight(.medium))
            .foregroundStyle(executionColor(status))
    }

    private func statusText(_ status: TimelineExecution.Status) -> String {
        switch status {
        case .queued: "En attente"
        case .running: "En cours"
        case .cancelling: "Annulation en cours"
        case .completed: "Terminée"
        case .failed: "Échouée"
        case .cancelled: "Annulée"
        case .timedOut: "Délai dépassé"
        }
    }

    private func statusSymbol(_ status: TimelineExecution.Status) -> String {
        let detailStatus: ProjectExecutionDetail.ExecutionStatus = switch status {
        case .queued: .queued
        case .running: .running
        case .cancelling: .cancelling
        case .completed: .completed
        case .failed: .failed
        case .cancelled: .cancelled
        case .timedOut: .timedOut
        }
        return projectExecutionStatusSymbol(detailStatus)
}
}
