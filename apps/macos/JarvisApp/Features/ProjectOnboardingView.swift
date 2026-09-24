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
                VStack(alignment: .leading, spacing: 20) {
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
                    .pickerStyle(.menu)
                    .controlSize(.large)
                    .frame(maxWidth: 320, alignment: .leading)
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
                }
                .frame(maxWidth: 900, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(24)
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
        VStack(alignment: .leading, spacing: 6) {
            Text(state.draft?.name ?? project.name)
                .font(.largeTitle.weight(.semibold))
            if let remote = state.detail?.bindings.first?.remoteUrl {
                Label(remote, systemImage: "externaldrive.connected.to.line.below")
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            } else if let path = state.detail?.bindings.first?.path {
                Label(
                    "Dépôt local : \(URL(fileURLWithPath: path).lastPathComponent)",
                    systemImage: "folder")
                    .foregroundStyle(.secondary)
            }
            Text("Workflow, Paramétrage et Vérification")
                .foregroundStyle(.secondary)
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
            GroupBox("Vérification") {
                VStack(alignment: .leading, spacing: 12) {
                    if presentation.status == .checking {
                        ProgressView(presentation.title)
                    } else {
                        Label(
                            presentation.title,
                            systemImage: presentation.status == .succeeded
                                ? "checkmark.circle.fill"
                                : presentation.status == .failed
                                    ? "xmark.circle" : "checkmark.circle")
                            .font(.headline)
                    }
                    Text(presentation.detail).foregroundStyle(.secondary)
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
                GroupBox("GitHub") {
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
            }
            if let development = settings.development {
                GroupBox("Développeur") {
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
