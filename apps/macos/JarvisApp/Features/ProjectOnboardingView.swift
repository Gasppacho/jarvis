import JarvisCore
import SwiftUI

/// Three-screen Project setup.
struct ProjectOnboardingView: View {
    let projects: ProjectsModel
    let projectConfiguration: ProjectConfigurationModel
    let moduleCatalog: ModuleCatalogModel
    let connections: ConnectionsModel
    let project: Project

    @State private var step: ProjectOnboardingStep
    @State private var isDeleteConfirmationPresented = false
    @State private var isConnectionsPresented = false

    init(
        projects: ProjectsModel,
        projectConfiguration: ProjectConfigurationModel,
        moduleCatalog: ModuleCatalogModel,
        connections: ConnectionsModel,
        project: Project
    ) {
        self.projects = projects
        self.projectConfiguration = projectConfiguration
        self.moduleCatalog = moduleCatalog
        self.connections = connections
        self.project = project
        let savedStep = projects.onboardingNavigation.currentStep(for: project.id)
        _step = State(
            initialValue: savedStep == .connections || savedStep == .review
                ? savedStep : .workflow)
    }

    var body: some View {
        let state = projectConfiguration.state(for: project.id)
        let presentation = ProjectOnboardingPresentation(project: project, configuration: state)
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    header(state)
                    if state.isLoading {
                        ProgressView("Chargement de la configuration…")
                    }
                    if let error = state.errorMessage {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                    }
                    if let message = projects.deletionMessages[project.id] {
                        Label(message, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                            .textSelection(.enabled)
                    }
                    if state.loadFailed {
                        Button("Réessayer le chargement") {
                            Task {
                                await projectConfiguration.refresh(
                                    projectId: project.id, packages: moduleCatalog.packages)
                            }
                        }
                        .disabled(state.isLoading)
                        .accessibilityIdentifier("project.reload")
                    }

                    Picker("Étape de configuration", selection: $step) {
                        ForEach(presentation.steps) { item in
                            Text(item.title)
                                .tag(item.id)
                                .accessibilityIdentifier("project.step.\(item.id.rawValue)")
                        }
                    }
                    .pickerStyle(.segmented)
                    .controlSize(.large)
                    .frame(maxWidth: 560, alignment: .leading)
                    .accessibilityIdentifier("project.step.\(step.rawValue)")

                    switch step {
                    case .workflow:
                        ProjectWorkflowView(
                            model: projectConfiguration,
                            project: project,
                            packages: moduleCatalog.packages,
                            moduleCatalog: moduleCatalog)
                    case .connections:
                        ProjectSettingsView(
                            model: projectConfiguration,
                            projectId: project.id,
                            openConnections: { isConnectionsPresented = true })
                    case .review:
                        ProjectVerificationView(
                            model: projectConfiguration,
                            project: project)
                    case .repository:
                        EmptyView()
                    }
                    if step == .workflow || step == .connections {
                        HStack {
                            Spacer()
                            Button(step == .workflow ? "Continuer vers Paramétrage" : "Continuer vers Vérification") {
                                step = step == .workflow ? .connections : .review
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(state.draft == nil)
                        }
                        .padding(.top, 8)
                    }
                }
                .frame(maxWidth: 1000, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(32)
            }
            Divider()
            HStack(spacing: 16) {
                Text(state.isLoading
                    ? "Chargement du brouillon…"
                    : state.draft == nil ? "Configuration indisponible" : state.saveStatus)
                    .font(.callout)
                    .accessibilityIdentifier("project.save-status")
                Spacer()
                if state.draft == nil {
                    Button("Réessayer le chargement") {
                        Task {
                            await projectConfiguration.refresh(
                                projectId: project.id, packages: moduleCatalog.packages)
                        }
                    }
                    .disabled(state.isLoading)
                    .accessibilityIdentifier("project.reload")
                } else {
                    Button(state.saveFailed ? "Réessayer l’enregistrement" : "Enregistrer") {
                        Task {
                            await projectConfiguration.saveDraft(
                                projectId: project.id, writeToRepository: false)
                        }
                    }
                    .disabled(state.isSaving || (state.isDraftSaved && !state.saveFailed))
                    .keyboardShortcut("s", modifiers: .command)
                    .accessibilityIdentifier("project.save")
                }
                if let deletionLabel = presentation.deletionLabel {
                    Button(deletionLabel, role: .destructive) {
                        isDeleteConfirmationPresented = true
                    }
                    .disabled(state.isSaving || projects.isDeletionInProgress(projectId: project.id))
                    .accessibilityIdentifier("project.delete")
                }
            }
            .padding(16)
            .background(.bar)
        }
        .background(JarvisVisual.canvas)
        .alert(
            project.status == .draft ? "Supprimer ce brouillon ?" : "Supprimer ce projet ?",
            isPresented: $isDeleteConfirmationPresented
        ) {
            Button("Annuler", role: .cancel) {}
            Button("Supprimer", role: .destructive) {
                Task { _ = await projectConfiguration.deleteProject(projectId: project.id) }
            }
        } message: {
            Text("Le projet sera retiré de Jarvis. Aucun fichier du dépôt ne sera modifié.")
        }
        .sheet(isPresented: $isConnectionsPresented, onDismiss: {
            Task {
                await connections.refresh()
                await projectConfiguration.refreshAfterConnectionManagement(
                    projectId: project.id, packages: moduleCatalog.packages)
            }
        }) {
            VStack(spacing: 0) {
                HStack {
                    Spacer()
                    Button("Terminé") { isConnectionsPresented = false }
                        .keyboardShortcut(.cancelAction)
                }
                .padding()
                Divider()
                ConnectionsView(model: connections)
            }
            .frame(minWidth: 720, minHeight: 560)
        }
        .task(id: project.id) {
            await projectConfiguration.refresh(
                projectId: project.id, packages: moduleCatalog.packages)
        }
        .onChange(of: step) { _, next in
            projects.onboardingNavigation.set(next, for: project.id)
        }
    }

    private func header(_ state: ProjectConfigurationState) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(state.draft?.name ?? project.name)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .textCase(.uppercase)
            if let remote = state.detail?.bindings.first?.remoteUrl {
                Label(remote, systemImage: "externaldrive.connected.to.line.below")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            } else if let path = state.detail?.bindings.first?.path {
                Label(
                    "Dépôt local : \(URL(fileURLWithPath: path).lastPathComponent)",
                    systemImage: "folder")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Text(stepTitle)
                .font(.largeTitle.weight(.semibold))
                .tracking(-0.8)
                .padding(.top, 8)
            Text(stepDescription)
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var stepTitle: String {
        switch step {
        case .workflow: "Composez votre workflow."
        case .connections: "Reliez vos outils."
        case .review: "Vérifiez, puis démarrez."
        case .repository: "Choisissez votre dépôt."
        }
    }

    private var stepDescription: String {
        switch step {
        case .workflow: "Sélectionnez les modules qui travailleront pour ce projet. Vous pouvez aussi commencer avec un workflow vide."
        case .connections: "Choisissez le compte GitHub et l’agent seulement si vos modules en ont besoin."
        case .review: "Jarvis contrôle les connexions nécessaires avant d’activer votre projet. Aucun travail ne démarre pendant cette vérification."
        case .repository: "Choisissez un dépôt Git local pour créer votre projet."
        }
    }

}

private struct ProjectVerificationView: View {
    let model: ProjectConfigurationModel
    let project: Project

    var body: some View {
        let state = model.state(for: project.id)
        let presentation = ProjectVerificationPresentation(
            project: project, configuration: state)
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 16) {
                Text("Connexions du projet")
                    .font(.title2.weight(.semibold))
                VStack(alignment: .leading, spacing: 12) {
                    if presentation.status == .checking {
                        ProgressView(presentation.title)
                    } else {
                        JarvisStatusBadge(
                            title: presentation.title,
                            symbol: presentation.status == .succeeded
                                ? "checkmark.circle.fill"
                                : presentation.status == .failed
                                    ? "xmark.circle" : "clock",
                            color: presentation.status == .succeeded ? .green : presentation.status == .failed ? .orange : .accentColor)
                    }
                    Text(presentation.detail).foregroundStyle(.secondary)
                    if !presentation.checks.isEmpty { Divider() }
                    ForEach(presentation.checks) { check in
                        VStack(alignment: .leading, spacing: 3) {
                            Label(
                                check.title,
                                systemImage: check.passed
                                    ? "checkmark.circle.fill" : "xmark.circle.fill")
                                .foregroundStyle(check.passed ? .green : .orange)
                            if !check.detail.isEmpty {
                                Text(check.detail)
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    Button("Vérifier la configuration") {
                        Task { await model.preflight(projectId: project.id) }
                    }
                    .disabled(state.preflight == .loading || state.isSaving || !state.isDraftSaved)
                    .accessibilityIdentifier("project.verification.check")
                    if !state.isDraftSaved {
                        Text("Enregistrez les modifications avant de vérifier.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 6)
            }
            .jarvisSurface()

            Button(presentation.actionTitle) {
                Task { await model.activateWorkflow(projectId: project.id) }
            }
            .buttonStyle(.borderedProminent)
            .disabled(!presentation.canActivate || !state.runtimeAllowsActivation)
            .accessibilityIdentifier("project.verification.activate")
            if !state.isDraftSaved {
                Text("Enregistrez les modifications avant de créer ou d’appliquer le projet.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            if !state.runtimeAllowsActivation {
                Label(
                    "\(state.runtimePresentation.status) : \(state.runtimePresentation.detail)",
                    systemImage: state.runtimePresentation.icon)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            switch state.activation {
            case .activating: ProgressView("Activation en cours…")
            case .succeeded:
                Label("Projet activé", systemImage: "checkmark.seal.fill")
                    .foregroundStyle(.green)
            case .rejected(_, let message), .transportFailure(let message):
                Label(message, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
            case .idle: EmptyView()
            }
        }
    }
}

private struct ProjectSettingsView: View {
    let model: ProjectConfigurationModel
    let projectId: String
    let openConnections: () -> Void

    var body: some View {
        let state = model.state(for: projectId)
        let settings = ProjectSettingsPresentation(configuration: state)
        VStack(alignment: .leading, spacing: 18) {
            if settings.github == nil, settings.development == nil {
                ContentUnavailableView(
                    "Aucun module à paramétrer",
                    systemImage: "slider.horizontal.3",
                    description: Text("Ajoutez un module dans Workflow ou continuez avec ce workflow vide."))
                    .frame(minHeight: 260)
            }
            if let github = settings.github {
                VStack(alignment: .leading, spacing: 16) {
                    Text("GitHub").font(.title2.weight(.semibold))
                    VStack(alignment: .leading, spacing: 14) {
                        repositoryState(
                            "Dépôt Git initialisé", value: github.isGitRepository)
                        repositoryState(
                            "Dépôt GitHub identifié", value: github.isGitHubRepository)
                        if github.accounts.isEmpty {
                            Text("Aucun compte GitHub disponible.")
                                .foregroundStyle(.secondary)
                            Button("Configurer un compte GitHub", action: openConnections)
                                .accessibilityIdentifier("project.settings.github.configure")
                        } else {
                            Picker(
                                "Compte GitHub",
                                selection: Binding(
                                    get: { github.accounts.first(where: \.isSelected)?.id ?? "" },
                                    set: { model.stageGitHubConnection(projectId: projectId, connectionID: $0) }
                                )
                            ) {
                                Text("Choisir un compte").tag("")
                                ForEach(github.accounts) { account in
                                    Text(account.name).tag(account.id)
                                }
                            }
                            .accessibilityIdentifier("project.settings.github.account")
                            Button("Gérer les comptes GitHub", action: openConnections)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 6)
                }
                .jarvisSurface()
            }
            if let development = settings.development {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Développeur").font(.title2.weight(.semibold))
                    VStack(alignment: .leading, spacing: 14) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Label d’issue")
                                .font(.callout.weight(.medium))
                            TextField(
                                "Ex. ready-to-dev",
                                text: Binding(
                                    get: { development.readyLabel },
                                    set: { model.setReadyLabel(projectId: projectId, label: $0) }))
                                .accessibilityIdentifier("project.settings.development.label")
                        }
                        if development.runtimes.isEmpty {
                            Text("Aucune CLI d’agent détectée.")
                                .foregroundStyle(.secondary)
                        } else {
                            Picker(
                                "CLI d’agent",
                                selection: Binding(
                                    get: {
                                        development.runtimes.first(where: \.isSelected)?.id ?? ""
                                    },
                                    set: { model.stageRuntime(projectId: projectId, ref: $0) }
                                )
                            ) {
                                Text("Choisir une CLI").tag("")
                                ForEach(development.runtimes) { runtime in
                                    Text("\(runtime.name) — \(runtime.status)")
                                        .tag(runtime.id)
                                        .disabled(!runtime.isSelectable)
                                }
                            }
                            .accessibilityIdentifier("project.settings.development.runtime")
                            if let selected = development.runtimes.first(where: \.isSelected),
                                selected.isSelectable
                            {
                                Button("Confirmer la CLI sélectionnée") {
                                    model.stageRuntime(projectId: projectId, ref: selected.id)
                                }
                                .disabled(state.isRuntimeBusy || state.isSaving)
                                .accessibilityIdentifier("project.settings.development.confirm-runtime")
                            }
                        }
                        if !state.runtimeAllowsActivation {
                            Label(
                                "\(state.runtimePresentation.status) : \(state.runtimePresentation.detail)",
                                systemImage: state.runtimePresentation.icon)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                        Button("Actualiser les CLI") {
                            Task {
                                await model.refreshRuntimeCandidates(
                                    projectId: projectId,
                                    discover: true,
                                    autoSelectUnique: false)
                            }
                        }
                        .disabled(state.isRuntimeBusy || state.isSaving)
                        .accessibilityIdentifier("project.settings.development.refresh-runtime")
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 6)
                }
                .jarvisSurface()
                .task {
                    await model.refreshRuntimeCandidates(
                        projectId: projectId,
                        discover: true,
                        autoSelectUnique: false)
                }
            }
        }
    }

    private func repositoryState(_ title: String, value: Bool) -> some View {
        Label(title, systemImage: value ? "checkmark.circle.fill" : "xmark.circle")
            .foregroundStyle(value ? .green : .secondary)
            .accessibilityLabel("\(title) : \(value ? "oui" : "non")")
    }
}

struct FirstLaunchView: View {
    let importRepository: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("J")
                    .font(.system(size: 32, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .frame(width: 64, height: 64)
                    .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 18))
                    .accessibilityHidden(true)
                Text("Bienvenue dans Jarvis")
                    .font(.largeTitle.weight(.semibold))
                    .tracking(-0.8)
                Text("Choisissez un dépôt, activez les modules utiles et suivez leur travail depuis ce Mac.")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Choisir un dépôt Git", systemImage: "folder.badge.plus") {
                    importRepository()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .padding(.top, 6)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 160))], spacing: 12) {
                    firstStep("1", "Choisir", "Jarvis utilise votre dépôt local.", symbol: "folder")
                    firstStep("2", "Composer", "Ajoutez GitHub et Développeur selon vos besoins.", symbol: "square.grid.2x2")
                    firstStep("3", "Suivre", "Voyez les issues, le travail et les Pull Requests.", symbol: "chart.bar.xaxis")
                }
                .padding(.top, 24)
            }
            .frame(maxWidth: 720, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(40)
        }
        .background(JarvisVisual.canvas)
    }

    private func firstStep(_ number: String, _ title: String, _ detail: String, symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(Color.accentColor)
            Text("\(number). \(title)").font(.headline)
            Text(detail)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, minHeight: 112, alignment: .topLeading)
        .jarvisSurface()
    }
}
