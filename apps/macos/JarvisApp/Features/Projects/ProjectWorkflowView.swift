import JarvisCore
import SwiftUI

/// The guide and Advanced share these edits. The diagram only projects Engine choices.
struct ProjectWorkflowView: View {
    let model: ProjectConfigurationModel
    let project: Project
    let packages: [ModulePackage]
    var connections: ConnectionsModel? = nil
    var overview: ProjectOverviewModel? = nil
    var openAdvanced: (() -> Void)? = nil
    var onSelectModule: ((String) -> Void)? = nil
    @State private var stage = WorkflowStage.issue
    @State private var editingGitHub = false
    @State private var intervalError: String?

    private var state: ProjectConfigurationState { model.state(for: project.id) }
    private var hasComposition: Bool {
        state.draft.map { !$0.modules.isEmpty || !$0.slotRequirements.isEmpty } ?? false
    }
    private var development: [ProjectModuleDraft] {
        state.draft?.modules.filter { $0.moduleId == "jarvis.module.development" } ?? []
    }
    private var flowConfirmed: Bool { state.compositionReview?.githubDevelopmentFlow == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            startingPoint
            if hasComposition {
                Label("Modules du projet",
                      systemImage: "arrow.triangle.branch").font(.headline)
                Text("Cliquez une carte pour comprendre et régler cette partie du workflow.")
                    .foregroundStyle(.secondary)
                if flowConfirmed {
                    Label("Une issue à la fois ; relecture et merge manuels.", systemImage: "person")
                        .font(.callout)
                }
                if let graph = state.compositionGraph {
                    WorkflowCanvasView(
                        presentation: WorkflowCanvasPresentation(graph: graph),
                        onSelectModule: { instanceId in
                            stage = state.draft?.modules.first(where: { $0.instanceId == instanceId })?.moduleId == "jarvis.module.github" ? .issue : .development
                        })
                }
                GroupBox(stage == .issue ? "GitHub" : "Développement") {
                    VStack(alignment: .leading, spacing: 14) {
                        if let module = state.draft?.modules.first(where: {
                            $0.moduleId == (stage == .issue ? "jarvis.module.github" : "jarvis.module.development")
                        }) {
                            HStack {
                                Toggle("Module activé", isOn: Binding(
                                    get: { module.enabled },
                                    set: { model.apply(.setModuleEnabled(module.id, $0), projectId: project.id, packages: packages) }))
                                Spacer()
                                Button("Retirer du brouillon", role: .destructive) {
                                    model.removeModule(projectId: project.id, moduleId: module.id)
                                    stage = state.draft?.modules.contains(where: { $0.moduleId == "jarvis.module.github" }) == true ? .issue : .development
                                }
                            }
                        }
                        stageSettings
                        if stage == .development {
                            Button("Choisir les vérifications") { stage = .validation }
                        } else if stage == .validation {
                            Button("Revenir aux réglages de Développement") { stage = .development }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(6)
                }
                if !development.isEmpty { Label(state.draft?.workflowCommandsConfigured == true
                      ? "Préparation et vérifications choisies — commandes encore à exécuter"
                      : "Préparer et vérifier le projet : confirmez les commandes dans les cartes Développement et Vérifications.",
                      systemImage: "checklist")
                    .font(.callout).foregroundStyle(.secondary) }
            }
            if let openAdvanced {
                Button("Réglages avancés", action: openAdvanced)
                    .accessibilityIdentifier("workflow.advanced")
            }
        }
        .onAppear {
            if state.draft?.modules.contains(where: { $0.moduleId == "jarvis.module.github" }) != true,
               !development.isEmpty { stage = .development }
        }
    }

    private var startingPoint: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Ajoutez GitHub pour observer les issues, puis Développement pour les traiter et proposer une Pull Request. Chaque ajout reste un brouillon.")
            HStack {
                Button("Ajouter GitHub") {
                    guard let package = packages.first(where: { $0.moduleId == "jarvis.module.github" }) else { return }
                    model.addModule(projectId: project.id, package: package)
                    stage = .issue
                }
                .buttonStyle(.borderedProminent)
                .disabled(state.draft == nil || state.draft?.modules.contains(where: { $0.moduleId == "jarvis.module.github" }) == true)
                .accessibilityIdentifier("workflow.choose-github")
                Button("Ajouter Développement") {
                    guard let package = packages.first(where: { $0.moduleId == "jarvis.module.development" }) else { return }
                    model.addModule(projectId: project.id, package: package)
                    stage = .development
                }
                .buttonStyle(.bordered)
                .disabled(state.draft == nil || state.draft?.modules.contains(where: { $0.moduleId == "jarvis.module.development" }) == true)
                .accessibilityIdentifier("workflow.add-development")
            }
            Text("Vous pourrez enregistrer et reprendre un brouillon incomplet.")
                .font(.callout).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var stageSettings: some View {
        switch stage {
        case .issue:
            githubCard
        case .development:
            Text("Préparer une copie de travail isolée").font(.headline)
            developmentRuntimeCard
            repositoryBranchControl
            ForEach(development) { module in
                TextField("Label de départ", text: configuration(module, "readyLabel"))
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Label de départ des issues")
                    .accessibilityIdentifier("workflow.development.ready-label")
                Text("Le label est propre à ce projet. Les nouveaux projets utilisent ready-to-dev.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            commandField("install", title: "Commande d’installation")
            ForEach(development) { module in
                Picker("Confirmer la préparation", selection: configuration(module, "preparation")) {
                    Text("Choisir une préparation").tag("")
                    Text("Exécuter la commande d’installation").tag("install")
                        .disabled(state.draft?.commands["install"]?.isEmpty != false)
                    Text("Aucune préparation nécessaire").tag("none")
                }
                .accessibilityIdentifier("workflow.preparation")
            }
            if development.isEmpty { Text("Ajoutez Development au workflow ou choisissez le modèle proposé.") }
            Text("Vérifiez la commande proposée avant de la confirmer. Avec un lockfile, conservez l’installation gelée. L’agent sera choisi à l’étape Accès et agent.")
                .font(.callout).foregroundStyle(.secondary)
        case .validation:
            Text("Préparer et vérifier le projet").font(.headline)
            Text("Cochez explicitement chaque vérification à exécuter. Si verify couvre déjà lint, typecheck et test, choisissez uniquement verify.")
                .font(.callout)
            ForEach(development) { module in
                Text("Sélection : \(module.validationOrder.isEmpty ? "aucune" : module.validationOrder.joined(separator: " → "))")
                    .font(.callout)
                validationRow(module, "verify")
                DisclosureGroup("Autres vérifications") {
                    ForEach(["lint", "typecheck", "test", "build"], id: \.self) { name in
                        validationRow(module, name)
                    }
                }
            }
            if development.isEmpty { Text("Ajoutez Development au workflow ou choisissez le modèle proposé.") }
            Text("Modifier une commande demande de la confirmer à nouveau. Les autres choix sont conservés.")
                .font(.callout).foregroundStyle(.secondary)
        case .pullRequest:
            Text(flowConfirmed
                 ? "Après des validations réussies, Development crée le commit et pousse la branche. GitHub crée ensuite la PR à partir de sa demande. Vous relisez et fusionnez vous-même."
                 : "Le modèle proposé crée un commit et pousse une branche après validation, puis demande à GitHub de créer une PR. Les destinations et l’absence de merge automatique restent à confirmer pour votre composition.")
            if flowConfirmed {
                Label("Aucune demande de merge dans ce workflow", systemImage: "person.crop.circle.badge.checkmark")
            }
            ForEach(development) { module in
                Text("Vérifications choisies : \(module.validationOrder.isEmpty ? "aucune" : module.validationOrder.joined(separator: " → "))")
            }
            Text("L’étape Vérification contrôle les accès et les liens entre ces événements avant d’autoriser le démarrage.")
                .font(.callout).foregroundStyle(.secondary)
        }
    }

    private var developmentRuntimeCard: some View {
        let runtime = state.runtimePresentation
        return GroupBox("Agent Codex") {
            VStack(alignment: .leading, spacing: 8) {
                Label(runtime.status, systemImage: runtime.icon)
                if runtime.requiresWorkflow {
                    Text("Choisissez d’abord le workflow GitHub Development.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(runtime.candidates) { candidate in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(candidate.name)
                                Text(candidate.subtitle).font(.caption).foregroundStyle(.secondary)
                                if candidate.bound { Text(runtime.modelLabel).font(.caption) }
                            }
                            Spacer()
                            if candidate.bound {
                                Label("Utilisé par ce projet", systemImage: "checkmark.circle")
                                    .font(.caption)
                            } else {
                                Button("Utiliser pour ce projet") {
                                    Task { await model.chooseRuntime(projectId: project.id, ref: candidate.id) }
                                }
                                .disabled(!candidate.selectable || state.isSaving)
                            }
                        }
                        if candidate.needsAttention {
                            Text(candidate.detail).font(.caption).foregroundStyle(.orange)
                        }
                    }
                    if runtime.candidates.isEmpty { Text(runtime.detail).foregroundStyle(.secondary) }
                    HStack {
                        Button("Rechercher Codex") {
                            Task { await model.refreshRuntimeCandidates(projectId: project.id, discover: true) }
                        }
                        .disabled(runtime.isBusy || state.isSaving)
                        Button("Vérifier l’agent") {
                            Task { await model.checkRuntime(projectId: project.id) }
                        }
                        .disabled(!runtime.canCheck || state.isSaving)
                    }
                }
                Text(runtime.approval).font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
    }

    private var repositoryBranchControl: some View {
        ForEach(state.draft?.repositories ?? [], id: \.id) { repository in
            VStack(alignment: .leading, spacing: 4) {
                Text("Branche cible").font(.callout.weight(.medium))
                TextField("Branche cible", text: Binding(
                    get: { state.draft?.repositories.first(where: { $0.id == repository.id })?.defaultBranch ?? "" },
                    set: { model.setRepositoryDefaultBranch(projectId: project.id, repositoryID: repository.id, branch: $0) }))
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Branche cible pour \(repository.id)")
                    .accessibilityIdentifier("workflow.development.branch.\(repository.id)")
                Text("Détectée pour \(repository.id); modifiable avant l’enregistrement.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func validationRow(_ module: ProjectModuleDraft, _ name: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            commandField(name, title: name)
            Toggle("Confirmer cette vérification", isOn: Binding(
                get: { state.draft?.modules.first { $0.id == module.id }?.validationOrder.contains(name) ?? false },
                set: { model.selectValidationCommand(projectId: project.id, moduleID: module.id, name: name, selected: $0) }))
                .disabled(state.draft?.commands[name]?.isEmpty != false)
                .accessibilityLabel("Exécuter \(name)")
                .accessibilityIdentifier("workflow.validation.\(name)")
        }
    }

    private func commandField(_ name: String, title: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.callout.weight(.medium))
            TextField(title, text: Binding(
                get: { state.draft?.commands[name] ?? "" },
                set: { model.setCommand(projectId: project.id, name: name, command: $0) }))
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("workflow.command.\(name)")
                .accessibilityLabel(title)
        }
    }

    private func configuration(_ module: ProjectModuleDraft, _ key: String) -> Binding<String> {
        Binding(
            get: { state.draft?.modules.first { $0.id == module.id }?.configurationValue(for: key) ?? "" },
            set: { model.apply(.setModuleConfiguration(module.id, key, $0), projectId: project.id, packages: packages) })
    }

    private var githubCard: some View {
        let github = state.draft?.modules.first { $0.moduleId == "jarvis.module.github" }
        return GroupBox {
            if let github {
                VStack(alignment: .leading, spacing: 12) {
                    repositorySummary
                    intervalControl(github)
                    accountControl
                    if let polling = overview?.state(for: project.id).overview?.polling,
                       let date = polling.lastPollAt {
                        Label("Dernier contrôle : \(date.formatted(date: .abbreviated, time: .shortened)), \(pollingLabel(polling.state))",
                              systemImage: "clock")
                            .font(.callout)
                    }
                    Text("GitHub fournit les observations d’issues au projet. Les réglages techniques restent disponibles dans Réglages avancés.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text("Ajoutez GitHub au workflow pour choisir le dépôt, le compte et la fréquence.")
            }
        } label: {
            Label("GitHub", systemImage: "chevron.left.forwardslash.chevron.right")
                .accessibilityLabel("Carte GitHub")
        }
        .accessibilityElement(children: .contain)
    }

    private var repositorySummary: some View {
        let repository = state.draft?.repositories.first
        let binding = repository.flatMap { item in
            state.detail?.bindings.first { $0.repositoryId == item.id }
        }
        return VStack(alignment: .leading, spacing: 4) {
            LabeledContent("Dépôt", value: binding?.remoteUrl ?? repository?.id ?? "Dépôt non détecté")
            if let repository { Text("Référence locale : \(repository.id)").font(.caption).foregroundStyle(.secondary) }
        }
    }

    private func intervalControl(_ module: ProjectModuleDraft) -> some View {
        let value = module.configurationValues["pollIntervalSeconds"] ?? "60"
        let historical = Int(value) == GitHubPollingFrequency.historicalSeconds
        return VStack(alignment: .leading, spacing: 4) {
            Text("Fréquence de vérification").font(.callout.weight(.medium))
            TextField("Minutes (1 à 60)", text: Binding(
                get: { GitHubPollingFrequency.display(seconds: Int(value)) },
                set: { text in
                    guard let seconds = GitHubPollingFrequency.seconds(fromMinutes: text) else {
                        intervalError = "La fréquence doit être comprise entre 1 et 60 minutes."
                        return
                    }
                    intervalError = nil
                    model.apply(.setModuleConfiguration(module.id, "pollIntervalSeconds", String(seconds)),
                                projectId: project.id, packages: packages)
                }))
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("workflow.github.interval")
                .accessibilityLabel("Fréquence de vérification en minutes")
            if historical {
                Text("Historique conservé : 15 secondes. Saisissez 1 à 60 pour choisir une nouvelle fréquence.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let intervalError { Text(intervalError).font(.caption).foregroundStyle(.red) }
        }
    }

    @ViewBuilder
    private var accountControl: some View {
        if let connections {
            let selected = connections.connections.filter {
                model.hasLocalBinding(projectId: project.id, connectionID: $0.id)
            }
            if selected.count != 1 || editingGitHub {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Compte GitHub").font(.callout.weight(.medium))
                    ForEach(connections.connections) { connection in
                        let presentation = connections.presentation(for: connection,
                                                                     isBound: selected.contains(connection))
                        HStack {
                            Label(connection.accountLabel, systemImage: presentation.isSelectable ? "person.crop.circle" : "exclamationmark.circle")
                            Spacer()
                            if presentation.isSelectable {
                                Button("Vérifier et utiliser") {
                                    Task {
                                        await connections.validate(connectionID: connection.id)
                                        guard let refreshed = connections.connections.first(where: { $0.id == connection.id }),
                                              connections.presentation(for: refreshed).isSelectable
                                        else { return }
                                        if await model.bindGitHubConnection(projectId: project.id, connectionID: connection.id) != nil {
                                            editingGitHub = false
                                        }
                                    }
                                }
                                .disabled(!state.resourceChoices.contains { $0.candidates.contains { $0.ref == connection.id } }
                                          || state.isSaving || connections.isValidating(connectionID: connection.id))
                                .accessibilityIdentifier("workflow.github.account.\(connection.id)")
                            } else {
                                Text(presentation.status).foregroundStyle(.secondary)
                            }
                        }
                    }
                    if connections.connections.isEmpty {
                        Text(connections.errorMessage ?? ConnectionsModel.emptyDiscoveryMessage)
                            .font(.callout).foregroundStyle(.secondary)
                    }
                }
            } else if let connection = selected.first {
                let presentation = connections.presentation(for: connection, isBound: true)
                VStack(alignment: .leading, spacing: 6) {
                    LabeledContent("Compte GitHub", value: connection.accountLabel)
                    Label(presentation.status, systemImage: presentation.isSelectable ? "checkmark.circle" : "exclamationmark.circle")
                    Text(presentation.diagnostic).font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Button("Vérifier l’accès") { Task { await connections.validate(connectionID: connection.id) } }
                            .disabled(connections.isValidating(connectionID: connection.id))
                            .accessibilityIdentifier("workflow.github.verify")
                        Button("Modifier") { editingGitHub = true }
                            .accessibilityIdentifier("workflow.github.modify")
                    }
                }
            }
        }
    }

    private func pollingLabel(_ state: ProjectOverview.PollingState) -> String {
        switch state {
        case .live: "accès actif"
        case .reconnecting: "reconnexion"
        case .failed: "accès à corriger"
        case .paused: "en pause"
        case .unavailable: "indisponible"
        }
    }
}

private enum WorkflowStage: String, CaseIterable, Identifiable {
    case issue, development, validation, pullRequest
    var id: String { rawValue }
    var title: String {
        switch self {
        case .issue: "Issue prête"
        case .development: "Développement"
        case .validation: "Vérifications"
        case .pullRequest: "Pull Request"
        }
    }
    var icon: String {
        switch self {
        case .issue: "tag"
        case .development: "hammer"
        case .validation: "checklist"
        case .pullRequest: "arrow.triangle.pull"
        }
    }
    var explanation: String {
        switch self {
        case .issue: "GitHub transmet les observations vérifiées ; Development reçoit ensuite une demande pour l’issue éligible."
        case .development: "Development prépare un worktree isolé, puis confie l’issue à votre agent."
        case .validation: "Development exécute les commandes choisies avant tout commit et push."
        case .pullRequest: "Une PR vous permet de relire le résultat avant de le fusionner."
        }
    }
}
