import AppKit
import JarvisCore
import SwiftUI

/// The single project sidebar and its guided or advanced content.
struct RootView: View {
    let projects: ProjectsModel
    let projectConfiguration: ProjectConfigurationModel
    let moduleCatalog: ModuleCatalogModel
    let timeline: ProjectTimelineModel
    let overview: ProjectOverviewModel
    let projectGraph: ProjectGraphModel
    let executionDetail: ProjectExecutionDetailModel
    let deadLetters: ProjectDeadLettersModel
    let connections: ConnectionsModel

    private let selectionPolicy = ProjectSelectionReconciliationPolicy()
    @State private var selection: SidebarSelection?
    @State private var pendingImport: Bool = false

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 200, ideal: 230, max: 280)
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
                set: {
                    guard !$0 else { return }
                    switch projects.importState {
                    case .inspecting, .confirm, .existing, .failed:
                        projects.cancelImport()
                    case .idle, .saving:
                        break
                    }
                }
            )
        ) {
            ProjectImportSheet(projects: projects, chooseAnotherFolder: presentFolderPicker) { project, newlyImported in
                selection = .project(project.id)
                Task {
                    if !newlyImported {
                        await projects.refresh()
                    }
                }
            }
        }
        .onChange(of: projects.importState) { _, newState in
            if case .idle = newState { pendingImport = false }
            if case .inspecting = newState, !pendingImport { pendingImport = true }
        }
        .onChange(of: projects.projects.map(\.id)) { _, projectIds in
            if let projectId = selectedProjectID {
                let reconciled = selectionPolicy.reconciledProjectID(
                    selectedProjectID: projectId,
                    availableProjectIDs: projectIds)
                if reconciled == nil { selection = nil }
            } else if selection == nil, let firstProject = projects.projects.first {
                let previous = projects.onboardingNavigation.lastProjectID
                selection = .project(previous.flatMap { projectIds.contains($0) ? $0 : nil } ?? firstProject.id)
            }
        }
        .onChange(of: selectedProjectID) { _, id in
            if let id { projects.onboardingNavigation.lastProjectID = id }
        }
    }

    private var sidebar: some View {
        List(selection: Binding(
            get: {
                switch selection {
                case .projectAdvanced(let id), .projectGuide(let id): return .project(id)
                default: return selection
                }
            },
            set: { selection = $0 }
        )) {
            Section("Projets") {
                Button(action: presentFolderPicker) {
                    Label("Ajouter un projet", systemImage: "plus.circle")
                }
                .disabled(projects.isRefreshing || !importStateAllowsNewPicker)
                .accessibilityIdentifier("project.add")
                .keyboardShortcut("n", modifiers: .command)
                ForEach(projects.projects) { project in
                    ProjectRow(project: project, isSelected: selectedProjectID == project.id).tag(SidebarSelection.project(project.id))
                }
                if projects.projects.isEmpty {
                    ContentUnavailableView {
                        Label("Aucun projet", systemImage: "tray")
                    } description: {
                        Text("Ajoutez un dépôt pour configurer votre premier projet.")
                    }
                }
            }
            Section("Bibliothèque") {
                Label("Catalogue", systemImage: "shippingbox")
                    .tag(SidebarSelection.moduleCatalog)
                Label("Comptes et connexions", systemImage: "link")
                    .tag(SidebarSelection.connections)
            }
        }
        .overlay(alignment: .top) {
            VStack(spacing: 0) {
                if let errorMessage = projects.errorMessage {
                    warning(errorMessage)
                }
                if let deletionNotice = projects.deletionNotice {
                    warning(deletionNotice)
                }
            }
        }
        .navigationTitle("Jarvis")
        .toolbar {
            ToolbarItem {
                Button {
                    presentFolderPicker()
                } label: {
                    Label("Ajouter un projet", systemImage: "folder.badge.plus")
                }
                .disabled(projects.isRefreshing || !importStateAllowsNewPicker)
            }
        }
    }

    private func warning(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle.fill")
            .font(.callout)
            .foregroundStyle(.orange)
            .padding(12)
            .background(.bar)
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
        case .connections:
            ConnectionsView(model: connections)
        case .project(let projectId), .projectGuide(let projectId):
            if let project = projects.projects.first(where: { $0.id == projectId }) {
                if project.status == .draft || selection == .projectGuide(project.id) {
                    ProjectOnboardingView(
                        projects: projects,
                        projectConfiguration: projectConfiguration,
                        moduleCatalog: moduleCatalog,
                        connections: connections,
                        overview: overview,
                        project: project,
                        openAdvanced: { selection = .projectAdvanced(project.id) })
                        .id(project.id)
                } else {
                    ProjectDetailView(
                        projects: projects,
                        projectConfiguration: projectConfiguration,
                        moduleCatalog: moduleCatalog,
                        overview: overview,
                        timeline: timeline,
                        executionDetail: executionDetail,
                        projectGraph: projectGraph,
                        deadLetters: deadLetters,
                        connections: connections,
                        project: project)
                }
            } else {
                ContentUnavailableView(
                    "Projet indisponible", systemImage: "folder.badge.questionmark",
                    description: Text("Actualisez la liste des projets puis réessayez."))
            }
        case .projectAdvanced(let projectId):
            if let project = projects.projects.first(where: { $0.id == projectId }) {
                VStack(alignment: .leading, spacing: 0) {
                    Button {
                        selection = .projectGuide(project.id)
                    } label: {
                        Label("Revenir à la configuration guidée", systemImage: "arrow.left")
                    }
                    .padding(16)
                    .accessibilityIdentifier("project.return-to-guide")
                    Divider()
                    ProjectDetailView(
                        projects: projects,
                        projectConfiguration: projectConfiguration,
                        moduleCatalog: moduleCatalog,
                        overview: overview,
                        timeline: timeline,
                        executionDetail: executionDetail,
                        projectGraph: projectGraph,
                        deadLetters: deadLetters,
                        connections: connections,
                        project: project)
                }
                .id(project.id)
            } else {
                ContentUnavailableView(
                    "Projet indisponible", systemImage: "folder.badge.questionmark",
                    description: Text("Actualisez la liste des projets puis réessayez."))
            }
        case nil:
            if projects.projects.isEmpty {
                FirstLaunchView(importRepository: presentFolderPicker)
            } else {
                ContentUnavailableView(
                    "Choisissez un projet", systemImage: "sidebar.left",
                    description: Text("Retrouvez vos projets et la bibliothèque dans la barre latérale."))
            }
        }
    }

    private var selectedProjectID: String? {
        switch selection {
        case .project(let projectID), .projectGuide(let projectID), .projectAdvanced(let projectID): projectID
        case .moduleCatalog, .connections, nil: nil
        }
    }

    /// UX étape 1: the native folder picker. Discovery itself is the engine's
    /// read-only inspection — the panel only yields the path.
    private func presentFolderPicker() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Choisir ce dossier"
        panel.message = "Choisissez le dossier de votre dépôt Git."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await projects.inspect(at: url) }
    }
}

private enum SidebarSelection: Hashable {
    case moduleCatalog
    case connections
    case project(String)
    case projectGuide(String)
    case projectAdvanced(String)
}

private struct ProjectRow: View {
    let project: Project
    let isSelected: Bool

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(project.name)
                Text(project.status == .draft ? "Configuration à terminer" : "Projet")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Text(statusTitle)
                .font(.caption.weight(.medium))
                .foregroundStyle(isSelected ? Color.primary : statusColor)
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .background((isSelected ? Color.primary : statusColor).opacity(0.15), in: Capsule())
        }
    }

    private var statusTitle: String {
        switch project.status {
        case .draft: "Brouillon"
        case .valid: "Vérifié"
        case .active: "Actif"
        case .paused: "En pause"
        case .invalid: "À corriger"
        case .degraded: "Attention requise"
        case .archived: "Archivé"
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
