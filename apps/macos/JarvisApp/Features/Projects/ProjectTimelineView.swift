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
                    ProgressView("Loading Timeline…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .failed(let message):
                    ContentUnavailableView {
                        Label("Timeline unavailable", systemImage: "exclamationmark.triangle.fill")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Retry") { Task { await timeline.refresh(projectId: projectId) } }
                    }
                case .empty:
                    ContentUnavailableView {
                        Label("Nothing has happened yet", systemImage: "clock")
                    } description: {
                        Text("Events and Executions will appear here once this Project runs.")
                    } actions: {
                        Button("Refresh") { Task { await timeline.refresh(projectId: projectId) } }
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
                        .foregroundStyle(.red)
                }
                HStack(spacing: 8) {
                    Button("Refresh Timeline") {
                        Task { await timeline.refresh(projectId: projectId) }
                    }
                    .disabled(presentation.status == .refreshing)
                    if presentation.status == .refreshing {
                        ProgressView().controlSize(.small)
                        Text("Refreshing…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                ForEach(presentation.groups) { group in
                    groupCard(group)
                }
            }
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
            case .live: ("Live", "dot.radiowaves.left.and.right", .green)
            case .reconnecting: ("Reconnecting…", "arrow.triangle.2.circlepath", .orange)
            case .failed: ("Not connected", "exclamationmark.triangle.fill", .red)
            }
        return Label(label, systemImage: symbol)
            .font(.caption.weight(.medium))
            .foregroundStyle(color)
            .accessibilityLabel("Live updates: \(label)")
    }

    private var presentation: ProjectTimelinePresentation {
        let state = timeline.state(for: projectId)
        return ProjectTimelinePresentation(
            events: state.events,
            executions: state.executions,
            isLoading: state.isLoading,
            errorMessage: state.errorMessage)
    }

    private func groupCard(_ group: ProjectTimelinePresentation.Group) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            // Nil for an orphan Execution's single-row chain: `group.id` is
            // then only a synthesized internal key, never a real
            // correlation id the engine reported — findings-review #61-5.
            if let correlationId = group.correlationId {
                Text("Correlation \(correlationId)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            ForEach(group.rows) { row in
                rowView(row)
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 10))
    }

    private func rowView(_ row: ProjectTimelinePresentation.Row) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol(for: row.kind))
                .foregroundStyle(color(for: row))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(row.title).font(.body.weight(.medium))
                    if let executionStatus = row.executionStatus {
                        statusPill(executionStatus)
                    }
                }
                Text(row.moduleInstance)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let subject = row.subject {
                    Text(subject)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let attempt = row.attempt {
                    Text("Attempt \(attempt)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if let completedAt = row.completedAt {
                    Text("Completed \(completedAt, format: .dateTime)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if let causingEvent = row.causingEvent {
                    Text("Caused by \(causingEvent.type)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if let parentEvent = row.parentEvent {
                    Text("Caused by \(parentEvent.type)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Text(row.occurredAt, format: .dateTime)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(row.accessibilityLabel)
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
        case .running, .queued: return .secondary
        }
    }

    private func statusPill(_ status: TimelineExecution.Status) -> some View {
        Text(status.displayLabel)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(executionColor(status).opacity(0.15), in: Capsule())
            .foregroundStyle(executionColor(status))
    }
}
