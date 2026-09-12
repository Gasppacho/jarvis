import Foundation
import JarvisCore
import SwiftUI

/// Ticket #200: the nominal view is a readable stepper; identifiers, paths and
/// redacted payload excerpts stay behind Technical details.
struct ProjectExecutionDetailView: View {
    let model: ProjectExecutionDetailModel
    let timeline: ProjectTimelineModel
    let projectId: String
    let executionId: String
    let close: () -> Void

    @State private var isTechnicalDetailsExpanded = false
    @State private var isCancelConfirmationPresented = false

    var body: some View {
        let state = model.state(for: projectId, executionId: executionId)
        let presentation = ProjectExecutionDetailPresentation(
            state, connection: timeline.connectionState)
        VStack(spacing: 0) {
            HStack {
                Button("Back to Timeline", action: close)
                Spacer()
                Label(
                    presentation.connectionLabel,
                    systemImage: presentation.connectionSymbol)
                    .foregroundStyle(connectionColor)
                    .font(.caption.weight(.medium))
                    .accessibilityLabel("Live updates: \(presentation.connectionLabel)")
            }
            .padding(.horizontal, 24)
            .padding(.top, 12)
            Group {
                switch presentation.state {
                case .loading:
                    ProgressView("Loading execution detail…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .failed(let message):
                    ContentUnavailableView {
                        Label("Execution detail unavailable", systemImage: "exclamationmark.triangle.fill")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Retry") {
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
            await model.refresh(projectId: projectId, executionId: executionId)
            await timeline.watchLive(projectId: projectId)
        }
        .onChange(of: timeline.state(for: projectId).executions) { _, _ in
            Task { await model.refresh(projectId: projectId, executionId: executionId) }
        }
        .onChange(of: timeline.state(for: projectId).events) { _, _ in
            Task { await model.refresh(projectId: projectId, executionId: executionId) }
        }
        .confirmationDialog(
            "Cancel this execution?",
            isPresented: $isCancelConfirmationPresented,
            titleVisibility: .visible
        ) {
            Button("Cancel execution", role: .destructive) {
                guard let cancellableExecutionId else { return }
                Task {
                    _ = await model.cancelExecution(
                        projectId: projectId,
                        executionId: executionId,
                        targetExecutionId: cancellableExecutionId)
                }
            }
            Button("Keep running", role: .cancel) {}
        } message: {
            Text("Jarvis keeps the durable final result and workspace policy after cancellation.")
        }
    }

    private func detailContent(
        _ detail: ProjectExecutionDetail,
        staleMessage: String?
    ) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let staleMessage {
                    HStack {
                        Label(staleMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.callout)
                            .foregroundStyle(.orange)
                        Spacer()
                        Button("Retry") {
                            Task {
                                await model.refresh(projectId: projectId, executionId: executionId)
                            }
                        }
                        .accessibilityLabel("Retry loading execution detail")
                    }
                }
                header(detail)
                executionsCard(detail.executions)
                if let failure = detail.failure {
                    failureCard(failure)
                }
                stepper(detail.steps)
                if !detail.agentExcerpts.isEmpty {
                    excerptsCard(detail.agentExcerpts)
                }
                checksCard(detail.checks)
                workspaceCard(detail)
                artifactsCard(detail.artifacts)
                pullRequestCard(detail.pullRequest)
                technicalDetails(
                    detail.technical,
                    workspace: detail.workspace,
                    retryDeliveryId: detail.retryDeliveryId)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)
        }
    }

    private func header(_ detail: ProjectExecutionDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                if let workItem = detail.workItem {
                    Text(workItem.title ?? workItem.ref)
                        .font(.title2.bold())
                        .fixedSize(horizontal: false, vertical: true)
                    if let issueNumber = workItem.issueNumber {
                        Text("#\(issueNumber)")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Text("Execution")
                        .font(.title2.bold())
                }
                Spacer()
                if let currentExecution {
                    statusPill(currentExecution.status)
                }
            }
            if let workItem = detail.workItem {
                Text(workItem.ref)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                if let repositoryId = workItem.repositoryId {
                    Text("Repository: \(repositoryId)")
                        .font(.callout)
                }
            }
            if let correlationId = detail.correlationId {
                Text("Correlation \(correlationId)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            if let lastEvent = detail.lastEvent {
                Label {
                    Text("Last event: \(lastEvent.type) · \(lastEvent.occurredAt, format: .dateTime)")
                } icon: {
                    Image(systemName: "clock")
                }
                .font(.callout)
            }
            HStack(spacing: 8) {
                if let cancellableExecutionId,
                   let execution = detail.executions.first(where: { $0.id == cancellableExecutionId }),
                   execution.status == .running || execution.status == .cancelling {
                    let detailState = model.state(for: projectId, executionId: executionId)
                    let isCancelling = detailState.isCancelling || execution.status == .cancelling
                    Button(
                        isCancelling
                            ? "Cancelling…"
                            : "Cancel") {
                        isCancelConfirmationPresented = true
                    }
                    .disabled(isCancelling)
                    .accessibilityLabel(
                        isCancelling
                            ? "Cancelling execution"
                            : "Cancel execution")
                }
                Spacer()
            }
        }
        .padding(16)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 12))
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
                                Text("Attempt \(execution.attempt) · \(execution.id)")
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
            Label("Executions", systemImage: "clock.arrow.circlepath")
        }
    }

    private func stepper(_ steps: [ProjectExecutionDetail.Step]) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: stepSymbol(step.status))
                            .foregroundStyle(stepColor(step.status))
                            .frame(width: 18)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(step.label).font(.body.weight(.medium))
                            Text(ProjectExecutionDetailPresentation.stepStatusLabel(step.status))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(stepColor(step.status))
                            Text(step.detail)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                            if let occurredAt = step.occurredAt {
                                Text(occurredAt, format: .dateTime)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(
                        "\(step.label): \(ProjectExecutionDetailPresentation.stepStatusLabel(step.status)). \(step.detail)")
                    if index < steps.count - 1 {
                        Rectangle()
                            .fill(.quaternary)
                            .frame(width: 1, height: 18)
                            .padding(.leading, 8)
                            .accessibilityHidden(true)
                    }
                }
            }
        } label: {
            Label("Progress", systemImage: "list.number")
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
                        if excerpt.truncated {
                            Text("Excerpt truncated")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        } label: {
            Label("Recent agent output", systemImage: "text.bubble")
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
                            Text(check.name).font(.body.monospaced())
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
                            Text(output)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        } label: {
            Label("Checks", systemImage: "checkmark.shield")
        }
    }

    private func workspaceCard(_ detail: ProjectExecutionDetail) -> some View {
        GroupBox {
            if let workspace = detail.workspace {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Status: \(workspace.status)")
                    Text("Branch: \(workspace.branch)").font(.caption.monospaced())
                    Text("Information détaillée dans Technical details.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("Information indisponible")
                    .foregroundStyle(.secondary)
            }
        } label: {
            Label("Workspace", systemImage: "folder")
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
            Label("Artifacts", systemImage: "doc.on.doc")
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
                        Link("Open Pull Request", destination: url)
                    } else {
                        Text("URL indisponible")
                            .foregroundStyle(.secondary)
                    }
                    Label(
                        "Manual review required before fusion.",
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
        DisclosureGroup("Technical details", isExpanded: $isTechnicalDetailsExpanded) {
            VStack(alignment: .leading, spacing: 8) {
                labeledIDs("Input event IDs", technical.inputEventIds)
                if let correlationId = technical.correlationId {
                    labeledIDs("Correlation ID", [correlationId])
                }
                labeledIDs("Causation IDs", technical.causationIds)
                labeledIDs("Retry delivery ID", retryDeliveryId.map { [$0] } ?? [])
                if let workspace {
                    Text("Path: \(workspace.path)")
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

    private func statusPill(_ status: ProjectExecutionDetail.ExecutionStatus) -> some View {
        Text(ProjectExecutionDetailPresentation.executionStatusLabel(status))
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(executionColor(status).opacity(0.15), in: Capsule())
            .foregroundStyle(executionColor(status))
    }

    private func stepSymbol(_ status: ProjectExecutionDetail.Step.Status) -> String {
        switch status {
        case .proved: "checkmark.circle.fill"
        case .active: "circle.dotted"
        case .failed: "xmark.octagon.fill"
        case .cancelled: "minus.circle"
        case .unavailable: "questionmark.circle"
        }
    }

    private func stepColor(_ status: ProjectExecutionDetail.Step.Status) -> Color {
        switch status {
        case .proved: .green
        case .active: .accentColor
        case .failed: .red
        case .cancelled: .orange
        case .unavailable: .secondary
        }
    }

    private func checkSymbol(_ status: ProjectExecutionDetail.Check.Status) -> String {
        switch status {
        case .passed: "checkmark.circle.fill"
        case .failed: "xmark.octagon.fill"
        case .unavailable: "questionmark.circle"
        }
    }

    private func checkColor(_ status: ProjectExecutionDetail.Check.Status) -> Color {
        switch status {
        case .passed: .green
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
        GroupBox {
            VStack(alignment: .leading, spacing: 6) {
                Label(failure.message, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                Text(failure.impact).font(.callout)
                Text(failure.nextAction).font(.callout).foregroundStyle(.secondary)
                Button("Open technical details") {
                    isTechnicalDetailsExpanded = true
                }
                if let deliveryId = model.state(for: projectId, executionId: executionId).detail?.retryDeliveryId {
                    Button("Retry execution") {
                        Task { _ = await model.retry(projectId: projectId, executionId: executionId) }
                    }
                    .disabled(model.state(for: projectId, executionId: executionId).isRetrying)
                    .accessibilityLabel("Retry execution delivery \(deliveryId)")
                }
            }
        } label: {
            Label("Failure · \(failure.code)", systemImage: "xmark.octagon")
        }
    }
}
