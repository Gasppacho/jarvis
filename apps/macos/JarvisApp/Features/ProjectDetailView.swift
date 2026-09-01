import AppKit
import JarvisCore
import SwiftUI

/// The selected project: its state, and where its repository resolves on this
/// machine (`bindingStatus` — the one place the absolute path is allowed).
struct ProjectDetailView: View {
    let projects: ProjectsModel
    let project: Project

    @State private var detail: ProjectDetail?
    @State private var loadError: String?

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
                } else if let loadError {
                    Label(loadError, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout)
                        .foregroundStyle(.orange)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)
        }
        .task(id: project.id) { await loadDetail() }
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
                await loadDetail()
            }
        }
    }

    private func loadDetail() async {
        do {
            detail = try await projects.detail(for: project.id)
            loadError = nil
        } catch {
            detail = nil
            loadError = ProjectsModel.describe(error)
        }
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
