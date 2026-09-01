import AppKit
import JarvisCore
import SwiftUI

/// The ready shell: the project sidebar (UX "wizard étape 1") and the project
/// detail. `NavigationSplitView` because the sidebar list is the navigation.
struct RootView: View {
    let projects: ProjectsModel
    let moduleCatalog: ModuleCatalogModel

    @State private var selection: SidebarSelection?
    @State private var pendingImport: Bool = false

    var body: some View {
        NavigationSplitView {
            sidebar
        } detail: {
            detail
        }
        .task {
            await projects.refresh()
            await moduleCatalog.refresh()
        }
        // The import flow's position lives in the model, not here: a snapshot
        // passed into `.sheet(isPresented:)` would go stale on import.
        .sheet(
            isPresented: Binding(
                get: { pendingImport },
                set: { if !$0 { projects.cancelImport() } }
            )
        ) {
            ProjectImportSheet(projects: projects)
        }
        .onChange(of: projects.importState) { _, newState in
            if case .idle = newState { pendingImport = false }
            if case .inspecting = newState, !pendingImport { pendingImport = true }
        }
    }

    private var sidebar: some View {
        List(selection: $selection) {
            Section("Modules") {
                Label("Module Catalog", systemImage: "shippingbox")
                    .tag(SidebarSelection.moduleCatalog)
            }
            Section("Projects") {
                ForEach(projects.projects) { project in
                    ProjectRow(project: project).tag(SidebarSelection.project(project.id))
                }
                if projects.projects.isEmpty {
                    ContentUnavailableView {
                        Label("No projects yet", systemImage: "tray")
                    } description: {
                        Text("Add a repository to import it as a draft project.")
                    }
                }
            }
        }
        .overlay(alignment: .top) {
            if let errorMessage = projects.errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .padding(12)
                    .background(.bar)
            }
        }
        .navigationTitle("Jarvis")
        .toolbar {
            ToolbarItem {
                Button {
                    presentFolderPicker()
                } label: {
                    Label("Add a repository…", systemImage: "folder.badge.plus")
                }
                .disabled(projects.isRefreshing || !importStateAllowsNewPicker)
            }
        }
    }

    private var importStateAllowsNewPicker: Bool {
        if case .idle = projects.importState { return true }
        return false
    }

    @ViewBuilder
    private var detail: some View {
        switch selection {
        case .moduleCatalog:
            ModuleCatalogView(moduleCatalog: moduleCatalog)
        case .project(let projectId):
            if let project = projects.projects.first(where: { $0.id == projectId }) {
                ProjectDetailView(
                    projects: projects,
                    moduleCatalog: moduleCatalog,
                    project: project)
            } else {
                ContentUnavailableView(
                    "Project unavailable", systemImage: "folder.badge.questionmark",
                    description: Text("Refresh the project list and try again."))
            }
        case nil:
            ContentUnavailableView(
                "No selection", systemImage: "sidebar.left",
                description: Text("Pick the module catalogue or a project in the sidebar."))
        }
    }

    /// UX étape 1: the native folder picker. Discovery itself is the engine's
    /// read-only inspection — the panel only yields the path.
    private func presentFolderPicker() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Import"
        panel.message = "Pick the folder that contains the repository."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await projects.inspect(at: url) }
    }
}

private enum SidebarSelection: Hashable {
    case moduleCatalog
    case project(String)
}

private struct ProjectRow: View {
    let project: Project

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(project.name)
                Text(project.id)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Text(project.status.rawValue)
                .font(.caption.weight(.medium))
                .foregroundStyle(statusColor)
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .background(statusColor.opacity(0.15), in: Capsule())
        }
    }

    private var statusColor: Color {
        switch project.status {
        case .draft: .blue
        case .valid, .active: .green
        case .paused: .orange
        case .invalid, .degraded: .red
        case .archived: .secondary
        }
    }
}
