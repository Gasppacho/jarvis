import JarvisCore
import SwiftUI

/// One project navigation; the four setup steps stay in its content area.
struct ProjectOnboardingView: View {
    let projects: ProjectsModel
    let projectConfiguration: ProjectConfigurationModel
    let moduleCatalog: ModuleCatalogModel
    let connections: ConnectionsModel
    let project: Project
    let openAdvanced: () -> Void

    private var navigation: ProjectOnboardingNavigationStore { projects.onboardingNavigation }
    @State private var step: ProjectOnboardingStep

    init(
        projects: ProjectsModel,
        projectConfiguration: ProjectConfigurationModel,
        moduleCatalog: ModuleCatalogModel,
        connections: ConnectionsModel,
        project: Project,
        openAdvanced: @escaping () -> Void
    ) {
        self.projects = projects
        self.projectConfiguration = projectConfiguration
        self.moduleCatalog = moduleCatalog
        self.connections = connections
        self.project = project
        self.openAdvanced = openAdvanced
        _step = State(initialValue: projects.onboardingNavigation.currentStep(for: project.id))
    }

    var body: some View {
        let state = projectConfiguration.state(for: project.id)
        let presentation = ProjectOnboardingPresentation(project: project, configuration: state)
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(state.draft?.name ?? project.name).font(.title.bold())
                        if let remote = state.detail?.bindings.first?.remoteUrl {
                            Label(remote, systemImage: "externaldrive.connected.to.line.below")
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        } else if let path = state.detail?.bindings.first?.path {
                            Label("Dépôt local : \(URL(fileURLWithPath: path).lastPathComponent)", systemImage: "folder")
                                .foregroundStyle(.secondary)
                        }
                        Label("\(project.status == .draft ? "Brouillon" : "Configuration à revoir") · \(step.title)", systemImage: "slider.horizontal.3")
                        Text(nextAction).foregroundStyle(.secondary)
                    }
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 12) { stepButtons(presentation) }
                            .fixedSize(horizontal: true, vertical: false)
                        VStack(alignment: .leading, spacing: 8) { stepButtons(presentation) }
                    }
                    if state.isLoading {
                        ProgressView("Chargement de la configuration…")
                    }
                    if let error = state.errorMessage {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                    }
                    if state.loadFailed && state.draft != nil {
                        Button("Réessayer le chargement") {
                            Task { await projectConfiguration.refresh(projectId: project.id, packages: moduleCatalog.packages) }
                        }
                        .disabled(state.isLoading)
                        .accessibilityIdentifier("project.reload")
                    }
                    activeStep
                }
                .frame(maxWidth: 900, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(24)
            }
            Divider()
            HStack(spacing: 16) {
                Text(state.isLoading ? "Chargement du brouillon…" : state.draft == nil ? "Configuration indisponible" : state.saveStatus)
                    .font(.callout)
                    .accessibilityIdentifier("project.save-status")
                Spacer()
                if state.draft == nil {
                    Button("Réessayer le chargement") {
                        Task { await projectConfiguration.refresh(projectId: project.id, packages: moduleCatalog.packages) }
                    }
                    .disabled(state.isLoading)
                    .accessibilityIdentifier("project.reload")
                } else {
                    Button(state.saveFailed ? "Réessayer l’enregistrement" : "Enregistrer") {
                        Task { await projectConfiguration.saveDraft(projectId: project.id, writeToRepository: false) }
                    }
                    .disabled(state.isSaving || (state.isDraftSaved && !state.saveFailed))
                    .accessibilityIdentifier("project.save")
                }
                if let nextStep {
                    Button("Continuer vers \(nextStep.title)") {
                        Task {
                            if !state.isDraftSaved {
                                guard await projectConfiguration.saveDraft(projectId: project.id, writeToRepository: false) != nil else { return }
                            }
                            step = nextStep
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(state.draft == nil || state.isSaving)
                    .accessibilityIdentifier("project.continue")
                }
            }
            .padding(16)
            .background(.bar)
        }
        .onChange(of: step) { _, value in navigation.set(value, for: project.id) }
        .task(id: project.id) {
            await connections.refresh()
            await projectConfiguration.refresh(
                projectId: project.id, packages: moduleCatalog.packages)
        }
    }

    private func stepButtons(_ presentation: ProjectOnboardingPresentation) -> some View {
        ForEach(presentation.steps) { item in
            Button { step = item.id } label: {
                HStack(spacing: 8) {
                    Image(systemName: icon(for: item.status))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.title).fontWeight(step == item.id ? .semibold : .regular)
                        Text(item.status.rawValue).font(.caption).foregroundStyle(.secondary)
                    }
                    if step == item.id { Image(systemName: "chevron.down").font(.caption) }
                }
                .padding(8)
                .background(step == item.id ? Color.accentColor.opacity(0.12) : Color.clear,
                            in: RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(item.accessibilityLabel)
            .accessibilityAddTraits(step == item.id ? .isSelected : [])
            .accessibilityIdentifier("project.step.\(item.id.rawValue)")
        }
    }

    private var nextStep: ProjectOnboardingStep? {
        switch step {
        case .repository: .workflow
        case .workflow: .connections
        case .connections: .review
        case .review: nil
        }
    }

    private var nextAction: String {
        switch step {
        case .repository: "Confirmez le dépôt et le nom de votre projet."
        case .workflow: "Choisissez ce que Jarvis développera et les vérifications à exécuter."
        case .connections: "Autorisez un compte GitHub et choisissez l’agent de ce projet."
        case .review: "Vérifiez la configuration, puis choisissez la portée du premier démarrage."
        }
    }

    @ViewBuilder
    private var activeStep: some View {
        switch step {
        case .repository:
            repositoryStep
        case .workflow:
            ProjectWorkflowView(model: projectConfiguration, project: project,
                                packages: moduleCatalog.packages, openAdvanced: openAdvanced)
        case .connections:
            connectionsStep
            runtimeCard
        case .review:
            review
        }
    }

    private var repositoryStep: some View {
        let state = projectConfiguration.state(for: project.id)
        return GroupBox("Dépôt") {
            VStack(alignment: .leading, spacing: 16) {
                Text("Nom du projet").font(.callout.weight(.medium))
                TextField("Nom du projet", text: Binding(
                    get: { projectConfiguration.state(for: project.id).draft?.name ?? project.name },
                    set: { name in projectConfiguration.editDraft(projectId: project.id) { $0.name = name } }))
                    .textFieldStyle(.roundedBorder)
                    .disabled(state.draft == nil)
                    .accessibilityIdentifier("project.name")
                ForEach(state.detail?.bindings ?? []) { binding in
                    if let remote = binding.remoteUrl {
                        LabeledContent("Dépôt distant", value: remote).textSelection(.enabled)
                    } else {
                        Label("Dépôt distant non identifié : vérifiez son accès local.", systemImage: "exclamationmark.triangle")
                    }
                    if let repository = state.draft?.repositories.first(where: { $0.id == binding.repositoryId }) {
                        LabeledContent("Branche de base", value: repository.defaultBranch)
                    }
                    Label(binding.accessible ? "Dossier accessible" : "Accès au dossier requis",
                          systemImage: binding.accessible ? "folder.badge.checkmark" : "folder.badge.questionmark")
                    Button("Choisir à nouveau le dossier") {
                        presentRepositoryPicker(binding: binding, project: project, projects: projects,
                                                configuration: projectConfiguration, packages: moduleCatalog.packages)
                    }
                    .accessibilityIdentifier("project.repository-access")
                    DisclosureGroup("Détails du dossier") {
                        Text(binding.path).textSelection(.enabled)
                    }
                }
                if let message = projects.repositoryGrantMessages[project.id] {
                    Label(message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                }
                Text("Le workflow démarre uniquement après votre vérification et votre activation. L’accès au dossier reste local à ce Mac.")
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var connectionsStep: some View {
        GroupBox("Compte GitHub") {
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
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func refreshConnections() async {
        await connections.refresh()
        await projectConfiguration.refresh(projectId: project.id, packages: moduleCatalog.packages)
    }

    private var runtimeCard: some View {
        let runtime = projectConfiguration.state(for: project.id).runtimePresentation
        return GroupBox(runtime.title) {
            VStack(alignment: .leading, spacing: 12) {
                Label(runtime.status, systemImage: runtime.icon)
                    .font(.headline)
                if runtime.isBusy { ProgressView().accessibilityLabel(runtime.status) }
                Text(runtime.impact)
                Text(runtime.detail).foregroundStyle(.secondary)
                if let checkedAt = runtime.checkedAt {
                    Text("Dernier contrôle : \(checkedAt.formatted(date: .abbreviated, time: .standard))")
                        .font(.caption)
                } else {
                    Text("Dernier contrôle : aucun").font(.caption)
                }
                Text(runtime.approval).font(.callout)
                ForEach(runtime.candidates) { candidate in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(candidate.name).font(.headline)
                        Text(candidate.subtitle)
                        Label(candidate.bound ? "Choisi pour ce projet" : candidate.status,
                              systemImage: candidate.bound ? "checkmark.circle" : "info.circle")
                        Text(candidate.detail).font(.callout).foregroundStyle(.secondary)
                        Button("Choisir") {
                            Task { await projectConfiguration.chooseRuntime(projectId: project.id, ref: candidate.id) }
                        }
                        .disabled(!candidate.selectable || projectConfiguration.state(for: project.id).isSaving)
                        .accessibilityLabel("Choisir \(candidate.name), \(candidate.subtitle)")
                        .accessibilityHint(runtime.approval)
                        DisclosureGroup("Détails techniques") {
                            Text(candidate.id).font(.caption.monospaced())
                        }
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
                }
                Button("Découvrir les runtimes") {
                    Task { await projectConfiguration.refreshRuntimeCandidates(projectId: project.id, discover: true) }
                }
                .disabled(runtime.isBusy)
                Button("Vérifier le runtime") {
                    Task { await projectConfiguration.checkRuntime(projectId: project.id) }
                }
                .disabled(!runtime.canCheck)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var review: some View {
        ProjectPreflightView(model: projectConfiguration, project: project, packages: moduleCatalog.packages) { destination in
            step = destination
        }
    }

    private func icon(for status: ProjectOnboardingStepStatus) -> String {
        switch status {
        case .needsAction: "circle"
        case .inProgress: "clock"
        case .readyForReview: "eye"
        case .complete: "checkmark.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        case .stale: "arrow.clockwise.circle"
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
            Button(presentation.emptyState?.primaryAction ?? "Ajouter un projet") {
                importRepository()
            }
            .buttonStyle(.borderedProminent)
        }
    }
}
