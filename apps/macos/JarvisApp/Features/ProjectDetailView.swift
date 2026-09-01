import AppKit
import JarvisCore
import SwiftUI

/// The selected project: its state, and where its repository resolves on this
/// machine (`bindingStatus` — the one place the absolute path is allowed).
struct ProjectDetailView: View {
    let projects: ProjectsModel
    let project: Project

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 12) {
                    Text(project.name)
                        .font(.title2.bold())
                    Text(project.status.rawValue)
                        .font(.callout.weight(.medium))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 3)
                        .background(.quaternary, in: Capsule())
                }

                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                    row("ID", project.id)
                    row("Modules", "\(project.moduleCount)")
                    if let active = project.activeExecutions {
                        row("Active executions", "\(active)")
                    }
                }
                .font(.callout)

                if let detail {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Repository")
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(.secondary)
                        ForEach(detail.bindings) { binding in
                            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 4) {
                                row(binding.repositoryId, binding.path)
                                row("Access", binding.accessible ? "reachable" : "not reachable")
                            }
                            .font(.callout)
                            if !binding.accessible
                                || projects.repositoryGrantMessages[project.id] != nil
                            {
                                HStack {
                                    Label(
                                        "The repository is unavailable.",
                                        systemImage: "folder.badge.questionmark"
                                    )
                                    .foregroundStyle(.orange)
                                    Button("Choose repository…") {
                                        chooseRepository(for: binding)
                                    }
                                }
                                .font(.callout)
                            }
                        }
                        if let message = projects.repositoryGrantMessages[project.id] {
                            Label(message, systemImage: "exclamationmark.triangle.fill")
                                .font(.callout)
                                .foregroundStyle(.orange)
                        }
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        Text("Configured modules")
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(.secondary)
                        ForEach(detail.modules) { module in
                            VStack(alignment: .leading, spacing: 8) {
                                HStack {
                                    Text(module.instanceId).font(.headline)
                                    Spacer()
                                    Text(module.enabled ? "Enabled" : "Disabled")
                                        .font(.caption.weight(.medium))
                                        .foregroundStyle(module.enabled ? .green : .secondary)
                                }
                                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                                    ForEach(module.presentationFields) { field in
                                        row(field.label, field.value)
                                    }
                                }
                                .font(.callout)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14)
                            .background(
                                .quaternary.opacity(0.5),
                                in: RoundedRectangle(cornerRadius: 10))
                        }
                    }

                    if !detail.projectSlots.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Project slots")
                                .font(.callout.weight(.semibold))
                                .foregroundStyle(.secondary)
                            ForEach(detail.projectSlots, id: \.self) { slot in
                                let binding = projects.localBindings[project.id]?.slots.first {
                                    $0.slotId == slot
                                }
                                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                                    row(slot, binding.map { "\($0.kind): \($0.ref)" } ?? "Unbound")
                                }
                            }
                            Text(
                                "Unbound slots are unresolved local capabilities. Connection, MCP, and runtime candidate registries are not implemented yet."
                            )
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                    }
                } else if let loadError = projects.configurationErrorMessages[project.id] {
                    Label(loadError, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout)
                        .foregroundStyle(.orange)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)
        }
        .task(id: project.id) { await projects.refreshConfiguration(projectId: project.id) }
    }

    private func chooseRepository(for binding: ProjectBinding) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Restore Access"
        panel.message = "Choose the repository for \(project.name)."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            if await projects.reauthorize(
                projectId: project.id,
                repositoryId: binding.repositoryId,
                replacing: binding.bookmarkRef,
                with: url
            ) {
                await projects.refreshConfiguration(projectId: project.id)
            }
        }
    }

    private var detail: ProjectDetail? {
        projects.configurationDetails[project.id]
    }

    private func row(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            Text(value)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
        }
    }
}
