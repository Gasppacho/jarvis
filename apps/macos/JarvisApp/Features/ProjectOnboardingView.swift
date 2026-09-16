import JarvisCore
import SwiftUI

/// One project navigation; the four setup steps stay in its content area.
struct ProjectOnboardingView: View {
    let projects: ProjectsModel
    let projectConfiguration: ProjectConfigurationModel
    let moduleCatalog: ModuleCatalogModel
    let connections: ConnectionsModel
    let overview: ProjectOverviewModel?
    let project: Project
    let openAdvanced: () -> Void
    var openSupervision: (() -> Void)? = nil

    private var navigation: ProjectOnboardingNavigationStore { projects.onboardingNavigation }
    @State private var step: ProjectOnboardingStep
    @State private var editingGitHub = false
    @State private var editingRuntime = false
    @State private var repairTarget: ProjectPreflightRepairTarget?
    @FocusState private var focusedControl: OnboardingFocus?

    init(
        projects: ProjectsModel,
        projectConfiguration: ProjectConfigurationModel,
        moduleCatalog: ModuleCatalogModel,
        connections: ConnectionsModel,
        overview: ProjectOverviewModel? = nil,
        project: Project,
        openAdvanced: @escaping () -> Void,
        openSupervision: (() -> Void)? = nil
    ) {
        self.projects = projects
        self.projectConfiguration = projectConfiguration
        self.moduleCatalog = moduleCatalog
        self.connections = connections
        self.overview = overview
        self.project = project
        self.openAdvanced = openAdvanced
        self.openSupervision = openSupervision
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
                    ProjectMigrationView(
                        model: projectConfiguration,
                        project: project,
                        packages: moduleCatalog.packages,
                        onOpenSupervision: openSupervision)
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
                    .keyboardShortcut("s", modifiers: .command)
                    .accessibilityIdentifier("project.save")
                }
                if let nextStep {
                    Button(state.isDraftSaved ? "Continuer vers \(nextStep.title)" : "Enregistrer et continuer vers \(nextStep.title)") {
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
                } else if step == .review {
                    ProjectPreflightActivationButton(model: projectConfiguration, projectId: project.id)
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
                                packages: moduleCatalog.packages, moduleCatalog: moduleCatalog,
                                connections: connections,
                                overview: overview,
                                openConnections: { step = .connections },
                                repairTarget: repairTarget,
                                openAdvanced: openAdvanced)
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
                    .accessibilityLabel("Nom du projet")
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
                    .focused($focusedControl, equals: .repositoryAccess)
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
        .onAppear { focus(.repositoryAccess, for: "project.repository-access") }
    }

    private var connectionsStep: some View {
        let state = projectConfiguration.state(for: project.id)
        let selected = connections.connections.filter { projectConfiguration.hasLocalBinding(projectId: project.id, connectionID: $0.id) }
        return GroupBox("Compte GitHub") {
            VStack(alignment: .leading, spacing: 12) {
                if state.resourceChoices.isEmpty {
                    Text("Choisissez d’abord un workflow pour définir les accès nécessaires.")
                    Button("Choisir le workflow") { step = .workflow }
                }
                switch connections.discoveryState {
                case .searching:
                    ProgressView("Recherche des comptes…")
                case .none:
                    Text(ConnectionsModel.emptyDiscoveryMessage).foregroundStyle(.secondary)
                    Link("Aide de connexion GitHub", destination: URL(string: "https://cli.github.com/manual/gh_auth_login")!)
                case .unavailable:
                    Label(connections.errorMessage ?? "Impossible de vérifier les comptes GitHub.",
                          systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                case .accounts:
                    ForEach(editingGitHub || selected.isEmpty ? connections.connections : selected) { connection in
                        let bound = projectConfiguration.hasLocalBinding(projectId: project.id, connectionID: connection.id)
                        let presentation = connections.presentation(for: connection, isBound: bound)
                        VStack(alignment: .leading, spacing: 6) {
                            Text(connection.accountLabel).font(.headline)
                            Label(presentation.status, systemImage: bound && presentation.isSelectable ? "checkmark.circle" : "info.circle")
                            Text(presentation.diagnostic).font(.callout).foregroundStyle(.secondary)
                            if presentation.isSelectable && !bound {
                                Button("Utiliser pour ce projet") {
                                    Task {
                                        if await projectConfiguration.bindGitHubConnection(projectId: project.id, connectionID: connection.id) != nil {
                                            editingGitHub = false
                                        }
                                    }
                                }
                                .disabled(state.isSaving || !state.resourceChoices.contains { choice in
                                    choice.candidates.contains { $0.kind == .connection && $0.ref == connection.id }
                                })
                                .accessibilityLabel("Utiliser le compte GitHub \(connection.accountLabel) pour ce projet")
                                .accessibilityIdentifier("project.github.choose.\(connection.id)")
                            } else if !presentation.isSelectable {
                                Link("Reconnecter GitHub", destination: URL(string: "https://cli.github.com/manual/gh_auth_login")!)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if !selected.isEmpty {
                        Button(editingGitHub ? "Conserver le compte choisi" : "Modifier") { editingGitHub.toggle() }
                            .accessibilityLabel("Modifier le compte GitHub de ce projet")
                            .accessibilityIdentifier("project.github.modify")
                        accountAccess
                        Button("Vérifier l’accès au dépôt") {
                            Task {
                                if !state.isDraftSaved {
                                    guard await projectConfiguration.saveDraft(projectId: project.id, writeToRepository: false) != nil else { return }
                                }
                                await projectConfiguration.preflight(projectId: project.id)
                            }
                        }
                        .disabled(state.isSaving || state.preflight == .loading)
                        .accessibilityIdentifier("project.github.check")
                    }
                }
                Button("Actualiser les comptes") { Task { await refreshConnections() } }
                    .disabled(connections.isRefreshing || state.isSaving)
                    .focused($focusedControl, equals: .githubRefresh)
                    .accessibilityIdentifier("project.github.refresh")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onAppear { focus(.githubRefresh, for: "project.github.refresh") }
    }

    @ViewBuilder
    private var accountAccess: some View {
        let state = projectConfiguration.state(for: project.id)
        switch state.preflight {
        case .current(let report):
            let checks = report.checks.filter { $0.id.hasPrefix("repository:") }
            if checks.isEmpty { Text("Accès au dépôt non vérifié : vérifiez aussi le workflow.").foregroundStyle(.secondary) }
            ForEach(checks, id: \.id) { check in
                Label(check.status == .passed ? "\(check.title) : dépôt accessible" : "\(check.title) : accès à corriger",
                      systemImage: check.status == .passed ? "checkmark.circle" : "exclamationmark.triangle")
                if check.status == .failed { Text(check.impact).font(.callout).foregroundStyle(.orange) }
            }
            if !checks.isEmpty, let date = state.preflightReceivedAt {
                Text("Dernier contrôle reçu : \(date.formatted(date: .abbreviated, time: .standard))").font(.caption)
            }
        case .loading:
            ProgressView("Vérification des accès…")
        case .stale:
            Text("Le dernier contrôle est périmé. Vérifiez à nouveau les accès.").foregroundStyle(.secondary)
        case .failed(let message):
            Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
        case .unchecked:
            Text("Accès au dépôt : pas encore vérifié.").foregroundStyle(.secondary)
        }
    }

    private func refreshConnections() async {
        await connections.refresh()
        await projectConfiguration.refresh(projectId: project.id, packages: moduleCatalog.packages)
    }

    private var runtimeCard: some View {
        let state = projectConfiguration.state(for: project.id)
        let runtime = state.runtimePresentation
        let selected = runtime.candidates.filter(\.bound)
        return GroupBox(runtime.title) {
            VStack(alignment: .leading, spacing: 12) {
                Label(runtime.status, systemImage: runtime.icon).font(.headline)
                if runtime.isBusy { ProgressView().accessibilityLabel(runtime.status) }
                if runtime.requiresWorkflow {
                    Button("Choisir le workflow") { step = .workflow }
                } else {
                    ForEach(editingRuntime || selected.isEmpty ? runtime.candidates : selected) { candidate in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(candidate.name).font(.headline)
                            Text(candidate.subtitle).font(.callout).foregroundStyle(.secondary)
                            if candidate.bound {
                                Label("Utilisé par ce projet", systemImage: "checkmark.circle")
                                Text(runtime.modelLabel).font(.callout)
                            }
                            if !candidate.bound || candidate.needsAttention {
                                Label(candidate.status, systemImage: "info.circle")
                                Text(candidate.detail).font(.callout).foregroundStyle(.secondary)
                            }
                            if !candidate.bound || editingRuntime {
                                Button(candidate.bound ? "Confirmer à nouveau les accès" : "Utiliser pour ce projet") {
                                    Task {
                                        await projectConfiguration.chooseRuntime(projectId: project.id, ref: candidate.id)
                                        if projectConfiguration.state(for: project.id).runtimePresentation.candidates.contains(where: { $0.id == candidate.id && $0.bound }) {
                                            editingRuntime = false
                                        }
                                    }
                                }
                                .disabled(!candidate.selectable || state.isSaving)
                                .accessibilityLabel(candidate.bound ? "Confirmer à nouveau les accès de \(candidate.name) pour ce projet" : "Utiliser \(candidate.name), \(candidate.subtitle), pour ce projet")
                                .accessibilityHint(runtime.approval)
                                .accessibilityIdentifier("project.runtime.choose.\(candidate.id)")
                            }
                        }
                    }
                    if !selected.isEmpty {
                        Text(runtime.detail).font(.callout).foregroundStyle(.secondary)
                        if let checkedAt = runtime.checkedAt {
                            Text("Dernier contrôle : \(checkedAt.formatted(date: .abbreviated, time: .standard))").font(.caption)
                        } else { Text("Agent à vérifier pour ce projet.").font(.caption) }
                        HStack {
                            Button(editingRuntime ? "Conserver l’agent choisi" : "Modifier") { editingRuntime.toggle() }
                                .accessibilityLabel("Modifier l’agent de ce projet")
                                .accessibilityIdentifier("project.runtime.modify")
                            Button("Vérifier l’agent") {
                                Task { await projectConfiguration.checkRuntime(projectId: project.id) }
                            }
                            .disabled(!runtime.canCheck || state.isSaving)
                            .accessibilityIdentifier("project.runtime.check")
                        }
                    } else if runtime.candidates.isEmpty {
                        Text(runtime.detail).foregroundStyle(.secondary)
                    }
                    if selected.isEmpty || editingRuntime { Text(runtime.approval).font(.callout).foregroundStyle(.secondary) }
                }
                if case .current(let report) = state.preflight {
                    ForEach(report.checks.filter { $0.id.hasPrefix("tool:") && $0.status == .failed }, id: \.id) { check in
                        Label("Outil manquant ou inaccessible — \(check.title)", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                        Text(check.impact).font(.callout)
                    }
                }
                HStack {
                    Button("Rechercher Codex") {
                        Task { await projectConfiguration.refreshRuntimeCandidates(projectId: project.id, discover: true) }
                    }
                    .disabled(runtime.isBusy || state.isSaving)
                    .focused($focusedControl, equals: .runtimeRefresh)
                    .accessibilityIdentifier("project.runtime.refresh")
                    Link("Aide Codex", destination: URL(string: "https://developers.openai.com/codex/cli")!)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onAppear { focus(.runtimeRefresh, for: "project.runtime.refresh") }
    }

    private var review: some View {
        ProjectPreflightView(model: projectConfiguration, project: project, packages: moduleCatalog.packages, showsActivation: false) { target in
            repairTarget = target
            step = target.step
        }
    }

    private func focus(_ control: OnboardingFocus, for controlID: String) {
        guard repairTarget?.controlID == controlID else { return }
        Task { @MainActor in
            await Task.yield()
            focusedControl = control
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

private enum OnboardingFocus: Hashable {
    case repositoryAccess
    case githubRefresh
    case runtimeRefresh
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
