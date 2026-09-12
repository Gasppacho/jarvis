import JarvisCore
import SwiftUI

/// The calm default surface for a Draft. Existing expert controls stay under
/// Advanced so the first path does not require internal Jarvis vocabulary.
struct ProjectOnboardingView: View {
    let projectConfiguration: ProjectConfigurationModel
    let moduleCatalog: ModuleCatalogModel
    let connections: ConnectionsModel
    let project: Project
    let openAdvanced: () -> Void

    private let navigation = ProjectOnboardingNavigationStore()
    @State private var step: ProjectOnboardingStep

    init(
        projectConfiguration: ProjectConfigurationModel,
        moduleCatalog: ModuleCatalogModel,
        connections: ConnectionsModel,
        project: Project,
        openAdvanced: @escaping () -> Void
    ) {
        self.projectConfiguration = projectConfiguration
        self.moduleCatalog = moduleCatalog
        self.connections = connections
        self.project = project
        self.openAdvanced = openAdvanced
        _step = State(initialValue: navigation.currentStep(for: project.id))
    }

    var body: some View {
        let presentation = ProjectOnboardingPresentation(project: project)
        NavigationSplitView {
            List(selection: $step) {
                ForEach(presentation.steps) { item in
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title)
                            Text(item.status.rawValue)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: icon(for: item.status))
                    }
                    .accessibilityLabel(item.accessibilityLabel)
                    .tag(item.id)
                }
            }
            .navigationTitle("Setup")
        } detail: {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(project.name).font(.title2.bold())
                    Text("Draft project")
                        .font(.callout.weight(.medium))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 3)
                        .background(.quaternary, in: Capsule())
                    activeStep
                    saveDraftAction
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(24)
            }
        }
        .id(project.id)
        .onChange(of: step) { _, value in navigation.set(value, for: project.id) }
        .task(id: project.id) {
            await connections.refresh()
            await projectConfiguration.refresh(
                projectId: project.id, packages: moduleCatalog.packages)
        }
    }

    @ViewBuilder
    private var activeStep: some View {
        switch step {
        case .repository:
            GroupBox("Repository") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Imported as a Draft. Jarvis will not start a workflow until you validate and activate it.")
                    Text("The repository access is kept locally on this Mac.")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        case .workflow:
            GroupBox("Workflow") {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Choose the workflow details when you are ready. Your Draft is saved and can be resumed at any time.")
                    advancedControls
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        case .connections:
            connectionsStep
        case .review:
            review
        }
    }

    private var advancedControls: some View {
        Button("Advanced") {
            openAdvanced()
        }
    }

    private var connectionsStep: some View {
        GroupBox("Connections") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Choisissez explicitement le compte GitHub utilisable par ce projet. Ce choix ne le rend pas disponible aux autres projets.")
                switch connections.discoveryState {
                case .searching:
                    Label("Recherche des comptes", systemImage: "magnifyingglass")
                case .none:
                    Text(ConnectionsModel.emptyDiscoveryMessage)
                        .foregroundStyle(.secondary)
                    Button("Réessayer") {
                        Task { await refreshConnections() }
                    }
                    Link("Aide de connexion", destination: URL(string: "https://cli.github.com/manual/gh_auth_login")!)
                case .unavailable:
                    Label(
                        connections.errorMessage ?? "Impossible de vérifier les comptes GitHub.",
                        systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                case .accounts:
                    ForEach(connections.connections) { connection in
                        let presentation = connections.presentation(for: connection)
                        VStack(alignment: .leading, spacing: 6) {
                            Text(connection.accountLabel).font(.headline)
                            Text("GitHub · \(presentation.status)")
                                .font(.callout.weight(.medium))
                            Text(presentation.diagnostic)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                            if projectConfiguration.hasLocalBinding(
                                projectId: project.id, connectionID: connection.id
                            ) {
                                Text("Binding du projet : ce compte n’est pas rendu disponible aux autres projets.")
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                            }
                            if presentation.isSelectable {
                                Button(presentation.action) {
                                    Task {
                                        _ = await projectConfiguration.bindGitHubConnection(
                                            projectId: project.id, connectionID: connection.id)
                                    }
                                }
                                .disabled(projectConfiguration.state(for: project.id).isSaving)
                            } else if presentation.status == "Accès requis" {
                                Link(
                                    presentation.action,
                                    destination: URL(string: "https://cli.github.com/manual/gh_auth_login")!)
                            }
                        }
                        .padding(12)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
                    }
                }
                Button("Actualiser les comptes") {
                    Task { await refreshConnections() }
                }
                .disabled(connections.isRefreshing)
                Button("Continuer vers Review") { step = .review }
                    .disabled(!hasProjectConnectionBinding)
                Button("Advanced") { openAdvanced() }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var hasProjectConnectionBinding: Bool {
        connections.connections.contains {
            projectConfiguration.hasLocalBinding(projectId: project.id, connectionID: $0.id)
        }
    }

    private func refreshConnections() async {
        await connections.refresh()
        await projectConfiguration.refresh(projectId: project.id, packages: moduleCatalog.packages)
    }

    private var saveDraftAction: some View {
        Button("Save Draft") {
            Task { await projectConfiguration.saveDraft(projectId: project.id, writeToRepository: false) }
        }
        .disabled(projectConfiguration.state(for: project.id).draft == nil)
    }

    private var review: some View {
        let configuration = projectConfiguration.state(for: project.id)
        let presentation = ProjectDetailPresentation(
            project: project,
            detail: configuration.detail,
            state: configuration,
            packages: moduleCatalog.packages,
            capabilityGuidance: moduleCatalog.capabilityGuidance)
        return GroupBox("Review") {
            VStack(alignment: .leading, spacing: 10) {
                Text("Review is available for every Draft. Activation stays unavailable until the current Engine validation succeeds.")
                if let message = configuration.errorMessage {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
                Button("Activate workflow") {
                    Task {
                        await projectConfiguration.perform(.activate, projectId: project.id)
                    }
                }
                .disabled(!presentation.activation.isEnabled)
                .accessibilityHint(presentation.activation.explanation)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func icon(for status: ProjectOnboardingStepStatus) -> String {
        switch status {
        case .needsAction: "circle"
        case .inProgress: "clock"
        case .readyForReview: "eye"
        case .complete: "checkmark.circle.fill"
        }
    }
}

struct FirstLaunchView: View {
    let importRepository: () -> Void

    var body: some View {
        let presentation = ProjectOnboardingPresentation(project: nil)
        ContentUnavailableView {
            Label(presentation.emptyState?.title ?? "Jarvis", systemImage: "sparkles")
        } description: {
            Text(presentation.emptyState?.description ?? "")
        } actions: {
            Button(presentation.emptyState?.primaryAction ?? "Importer un repository") {
                importRepository()
            }
            .buttonStyle(.borderedProminent)
        }
    }
}
