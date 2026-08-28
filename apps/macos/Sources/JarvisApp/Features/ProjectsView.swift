import AppKit
import JarvisCore
import SwiftUI

/// Step 1 of the project wizard: choose a folder, import it as a draft.
struct ProjectsView: View {
    let session: EngineSessionModel

    private var projects: ProjectsModel { session.projects }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Projects").font(.title2.weight(.semibold))
                Spacer()
                Button {
                    Task { await chooseRepository() }
                } label: {
                    Label("Import Repository…", systemImage: "folder.badge.plus")
                }
                .disabled(projects.isImporting || !session.isReady)
            }

            if let message = projects.errorMessage {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if projects.projects.isEmpty {
                ContentUnavailableView(
                    "No projects yet",
                    systemImage: "shippingbox",
                    description: Text("Import a local Git repository to create your first project.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(projects.projects) { project in
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(project.name).font(.body.weight(.medium))
                            Text(project.id).font(.caption).foregroundStyle(.secondary).monospaced()
                        }
                        Spacer()
                        Text("\(project.moduleCount) modules")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        StatusBadge(status: project.status)
                    }
                    .padding(.vertical, 4)
                }
                .listStyle(.inset)
            }
        }
        .padding(24)
        .task { await projects.refresh() }
    }

    /// The user grants access to a folder through the native panel; Jarvis
    /// never browses the filesystem on its own.
    @MainActor
    private func chooseRepository() async {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Import"
        panel.message = "Choose the Git repository Jarvis should work in."

        guard panel.runModal() == .OK, let url = panel.url else { return }
        await projects.importRepository(at: url.path(percentEncoded: false))
    }
}

private struct StatusBadge: View {
    let status: String

    var body: some View {
        Text(status)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.18), in: Capsule())
            .foregroundStyle(color)
    }

    private var color: Color {
        switch status {
        case "active": return .green
        case "draft": return .secondary
        case "invalid", "degraded": return .orange
        default: return .blue
        }
    }
}
