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
        state.draft?.modules.filter { $0.enabled && $0.moduleId == "jarvis.module.development" } ?? []
    }
    private var flowConfirmed: Bool { state.compositionReview?.githubDevelopmentFlow == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if hasComposition {
                Label(flowConfirmed ? "Workflow du projet" : "Parcours de référence",
                      systemImage: "arrow.triangle.branch").font(.headline)
                Text("Cliquez une carte pour comprendre et régler cette partie du workflow.")
                    .foregroundStyle(.secondary)
                if flowConfirmed {
                    Label("Une issue à la fois ; relecture et merge manuels.", systemImage: "person")
                        .font(.callout)
                } else {
                    Label("Les liens de ce parcours ne sont pas confirmés pour votre brouillon. Vérifiez les règles avancées ou choisissez le modèle GitHub.",
                          systemImage: "exclamationmark.triangle")
                        .font(.callout).foregroundStyle(.orange)
                }
                if let graph = state.compositionGraph {
                    WorkflowCanvasView(
                        presentation: WorkflowCanvasPresentation(graph: graph),
                        onSelectModule: { instanceId in
                            onSelectModule?(instanceId)
                            if onSelectModule == nil { openAdvanced?() }
                        })
                }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) {
                        ForEach(WorkflowStage.allCases) { item in
                            stageCard(item, arrow: "arrow.right").frame(width: 170)
                        }
                    }
                    VStack(spacing: 10) {
                        ForEach(WorkflowStage.allCases) { item in stageCard(item, arrow: "arrow.down") }
                    }
                }
                GroupBox(stage.title) {
                    VStack(alignment: .leading, spacing: 14) {
                        if !flowConfirmed { Text("Dans le modèle proposé :").font(.headline) }
                        Text(stage.explanation)
                        stageSettings
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(6)
                }
                Label(state.draft?.workflowCommandsConfigured == true
                      ? "Préparation et vérifications choisies — commandes encore à exécuter"
                      : "Préparer et vérifier le projet : confirmez les commandes dans les cartes Développement et Vérifications.",
                      systemImage: "checklist")
                    .font(.callout).foregroundStyle(.secondary)
                DisclosureGroup("Changer de modèle") { startingPoint }
            } else {
                GroupBox("Développer une issue GitHub") { startingPoint.padding(6) }
            }
            if let openAdvanced {
                Button("Réglages avancés", action: openAdvanced)
                    .accessibilityIdentifier("workflow.advanced")
            }
        }
        .confirmationDialog("Remplacer le workflow actuel ?", isPresented: Binding(
            get: { state.pendingStartingPointID != nil },
            set: { if !$0 { model.cancelStartingPointReplacement(projectId: project.id) } }
        )) {
            Button("Remplacer le workflow", role: .destructive) {
                if let id = state.pendingStartingPointID {
                    model.chooseStartingPoint(projectId: project.id, startingPointId: id, confirmedReplacement: true)
                }
            }
            Button("Conserver mon brouillon", role: .cancel) {
                model.cancelStartingPointReplacement(projectId: project.id)
            }
        } message: {
            Text("Les modules, règles, paramètres et associations internes seront remplacés. Le label revient à ready-for-agent ; préparation et validations seront à confirmer. Une seule exécution sera autorisée ; les branches et remotes manquants seront complétés. Le nom, les commandes saisies et les références locales de comptes et d’agent sont conservés. Les accès seront à revérifier.")
        }
    }

    private func stageCard(_ item: WorkflowStage, arrow: String) -> some View {
        Button { stage = item } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Image(systemName: item.icon)
                    Spacer()
                    if item != .pullRequest { Image(systemName: arrow) }
                }
                Text(item.title).font(.headline)
                Text(stageStatus(item)).font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 74, alignment: .leading)
            .padding(12)
            .background(stage == item ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.06),
                        in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(item.title), \(stageStatus(item))")
        .accessibilityHint("Afficher l’explication et les réglages")
        .accessibilityAddTraits(stage == item ? .isSelected : [])
        .accessibilityIdentifier("workflow.stage.\(item.rawValue)")
    }

    private var startingPoint: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Une issue ouverte, portant le label choisi et sans bloqueur GitHub ouvert, est développée puis proposée dans une Pull Request. Une issue à la fois ; vous gardez la relecture et le merge.")
            Button(hasComposition ? "Utiliser le modèle GitHub" : "Ajouter GitHub") {
                model.chooseStartingPoint(projectId: project.id, startingPointId: "github-development")
            }
            .buttonStyle(.borderedProminent)
            .disabled(state.draft == nil || state.compositionGuide?.startingPoints.contains { $0.id == "github-development" } != true)
            .accessibilityIdentifier("workflow.choose-github")
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
            get: { state.draft?.modules.first { $0.id == module.id }?.configurationValues[key] ?? "" },
            set: { model.apply(.setModuleConfiguration(module.id, key, $0), projectId: project.id, packages: packages) })
    }

    private func stageStatus(_ item: WorkflowStage) -> String {
        if item == .validation { return state.draft?.workflowCommandsConfigured == true ? "Choix confirmés" : "À confirmer" }
        guard flowConfirmed else { return "Liens à vérifier" }
        return item == .issue ? "Contrôle des bloqueurs configuré" : "Destination définie"
    }

    private var githubCard: some View {
        let github = state.draft?.modules.first { $0.enabled && $0.moduleId == "jarvis.module.github" }
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
