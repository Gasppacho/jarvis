import JarvisCore
import SwiftUI

/// The guide and Advanced share these edits. The diagram only projects Engine choices.
struct ProjectWorkflowView: View {
    let model: ProjectConfigurationModel
    let project: Project
    let packages: [ModulePackage]
    let moduleCatalog: ModuleCatalogModel
    var connections: ConnectionsModel? = nil
    var overview: ProjectOverviewModel? = nil
    var openConnections: (() -> Void)? = nil
    var repairTarget: ProjectPreflightRepairTarget? = nil
    var openAdvanced: (() -> Void)? = nil
    var onSelectModule: ((String) -> Void)? = nil
    @State private var stage = WorkflowStage.issue
    @State private var showingRecommendedReplacement = false
    @State private var branchInputs: [String: String] = [:]
    @State private var branchErrors: [String: String] = [:]
    @State private var intervalInputs: [UUID: String] = [:]
    @State private var intervalError: String?
    @FocusState private var focusedInput: WorkflowInputFocus?

    private var state: ProjectConfigurationState { model.state(for: project.id) }
    private var hasComposition: Bool {
        state.draft.map { !$0.modules.isEmpty || !$0.slotRequirements.isEmpty } ?? false
    }
    private var development: [ProjectModuleDraft] {
        state.draft?.modules.filter { $0.enabled && $0.moduleId == "jarvis.module.development" } ?? []
    }
    private var hasGitHub: Bool {
        state.draft?.modules.contains { $0.enabled && $0.moduleId == "jarvis.module.github" } == true
    }
    private var hasDevelopment: Bool { !development.isEmpty }
    private var hasRecommendedFlow: Bool { hasGitHub && hasDevelopment }
    private var canChooseRecommendedFlow: Bool {
        packageIsAvailable("jarvis.module.github")
            && packageIsAvailable("jarvis.module.development")
            && state.draft != nil
            && state.compositionGuide?.startingPoints.contains { $0.id == "github-development" } == true
    }
    private var flowConfirmed: Bool {
        hasRecommendedFlow && state.compositionReview?.githubDevelopmentFlow == true
    }
    private var catalogIsAvailable: Bool {
        if case .loaded = moduleCatalog.state { return true }
        return false
    }
    private func packageIsAvailable(_ moduleID: String) -> Bool {
        catalogIsAvailable && packages.contains { $0.moduleId == moduleID }
    }
    private var missingPackagesMessage: String? {
        guard catalogIsAvailable else { return nil }
        let missing = ["jarvis.module.github", "jarvis.module.development"]
            .filter { moduleID in !packages.contains { package in package.moduleId == moduleID } }
        guard !missing.isEmpty else { return nil }
        let names = missing.map { $0 == "jarvis.module.github" ? "GitHub" : "Développement" }
        return "Catalogue disponible, mais modules manquants : \(names.joined(separator: " et "))."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            catalogAvailability
            if !hasRecommendedFlow {
                startingPoint
            } else if hasComposition {
                DisclosureGroup("Ajouter un module") { startingPoint }
            }
            if hasComposition {
                Text(workflowTitle).font(.title2.bold())
                Text(workflowDescription)
                    .foregroundStyle(.secondary)
            } else {
                Text("Aperçu du parcours recommandé").font(.title2.bold())
                Text("Ajoutez GitHub et Développement pour configurer ce parcours.")
                    .foregroundStyle(.secondary)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { stageButtons(horizontal: true) }
                    .fixedSize(horizontal: true, vertical: false)
                VStack(alignment: .leading, spacing: 8) { stageButtons(horizontal: false) }
            }
            if hasComposition {
                if flowConfirmed {
                    Label("Une issue à la fois ; relecture et merge manuels.", systemImage: "person")
                        .font(.callout)
                }
                GroupBox(stage.title) {
                    VStack(alignment: .leading, spacing: 14) {
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
                accessSummary
            }
            DisclosureGroup("Réglages avancés et composition des modules") {
                VStack(alignment: .leading, spacing: 12) {
                    if let graph = state.compositionGraph {
                        WorkflowCanvasView(
                            presentation: WorkflowCanvasPresentation(graph: graph),
                            onSelectModule: { instanceId in
                                stage = state.draft?.modules.first(where: { $0.instanceId == instanceId })?.moduleId == "jarvis.module.github" ? .issue : .development
                            })
                    }
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
                    if let openAdvanced {
                        Button("Ouvrir les réglages avancés", action: openAdvanced)
                            .accessibilityIdentifier("workflow.advanced")
                    }
                }
            }
        }
        .onAppear {
            if state.draft?.modules.contains(where: { $0.moduleId == "jarvis.module.github" }) != true,
               !development.isEmpty { stage = .development }
        }
        .onChange(of: focusedInput) { previous, _ in
            switch previous {
            case .branch(let repositoryID): commitBranch(repositoryID: repositoryID)
            case .interval(let moduleID):
                guard let module = state.draft?.modules.first(where: { $0.id == moduleID }) else { return }
                commitInterval(module)
            case .readyLabel, .preparation, .validation:
                break
            case nil: break
            }
        }
        .task(id: repairTarget?.controlID) {
            await Task.yield()
            switch repairTarget?.controlID {
            case "workflow.development.ready-label":
                stage = .issue
                if let module = development.first { focusedInput = .readyLabel(module.id) }
            case "workflow.preparation":
                stage = .development
                if let module = development.first { focusedInput = .preparation(module.id) }
            case let id? where id.hasPrefix("workflow.validation."):
                stage = .validation
                if let module = development.first {
                    focusedInput = .validation(module.id, String(id.dropFirst("workflow.validation.".count)))
                }
            case "workflow.choose-recommended": stage = .issue
            default: break
            }
        }
        .confirmationDialog(
            "Remplacer le brouillon actuel ?",
            isPresented: $showingRecommendedReplacement
        ) {
            Button("Préparer le parcours recommandé", role: .destructive) {
                model.chooseStartingPoint(
                    projectId: project.id,
                    startingPointId: "github-development",
                    confirmedReplacement: true)
                stage = .issue
            }
            Button("Conserver le brouillon", role: .cancel) {
                model.cancelStartingPointReplacement(projectId: project.id)
            }
        } message: {
            Text("GitHub et Développement remplaceront la composition actuelle. Le nom et les commandes du projet sont conservés.")
        }
    }

    private func stageButtons(horizontal: Bool) -> some View {
        ForEach(WorkflowStage.allCases) { item in
            if horizontal && item != .issue {
                Image(systemName: "arrow.right").foregroundStyle(.secondary).accessibilityHidden(true)
            }
            Button { stage = item } label: {
                VStack(alignment: .leading, spacing: 8) {
                    Image(systemName: item.icon).font(.title2)
                    Text(item.title).font(.headline)
                    Text(item.subtitle).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Label(stageStatus(item), systemImage: stageIcon(item))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(width: 130, alignment: .leading)
                .padding(16)
                .background(stage == item ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.06),
                            in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(stage == item ? Color.accentColor : Color.secondary.opacity(0.2)))
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(stage == item ? .isSelected : [])
            .accessibilityHint(item.explanation)
            .accessibilityIdentifier("workflow.stage.\(item.rawValue)")
        }
    }

    private func stageStatus(_ item: WorkflowStage) -> String {
        guard hasComposition else {
            switch item {
            case .issue, .development: return "Absent"
            case .validation: return "Sans développement"
            case .pullRequest: return "Non prévu"
            }
        }
        switch item {
        case .issue:
            guard state.draft?.modules.contains(where: {
                $0.enabled && $0.moduleId == "jarvis.module.github"
            }) == true else { return "Absent" }
            if !hasDevelopment { return "Observation seule" }
            return guidedReadyLabelValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "À configurer" : "Configuré"
        case .development:
            return hasDevelopment ? (state.draft?.workflowCommandsConfigured == true ? "Configuré" : "À configurer") : "Absent"
        case .validation:
            guard let module = development.first else { return "Sans développement" }
            return module.validationOrder.isEmpty ? "À configurer" : "Configuré"
        case .pullRequest: return flowConfirmed ? "Prévu" : "Non prévu"
        }
    }

    private func stageIcon(_ item: WorkflowStage) -> String {
        stageStatus(item) == "Configuré" || stageStatus(item) == "Prévu" ? "checkmark.circle" : "circle"
    }

    private var startingPoint: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Choisissez le parcours qui correspond à votre besoin. Chaque ajout reste un brouillon.")
            Button("Préparer le parcours recommandé GitHub → Développement → PR") {
                chooseRecommendedFlow()
            }
            .buttonStyle(.borderedProminent)
            .disabled(!canChooseRecommendedFlow)
            .accessibilityHint(catalogActionHint(requires: ["jarvis.module.github", "jarvis.module.development"]))
            .accessibilityIdentifier("workflow.choose-recommended")
            Text("Ajoute GitHub et Développement. Vous confirmerez ensuite les commandes et les accès avant toute exécution.")
                .font(.callout).foregroundStyle(.secondary)
            HStack {
                Button("Observer uniquement les issues") {
                    guard let package = packages.first(where: { $0.moduleId == "jarvis.module.github" }) else { return }
                    model.addModule(projectId: project.id, package: package)
                    stage = .issue
                }
                .buttonStyle(.bordered)
                .disabled(!packageIsAvailable("jarvis.module.github") || state.draft == nil || state.draft?.modules.contains(where: { $0.moduleId == "jarvis.module.github" }) == true)
                .accessibilityHint(catalogActionHint(requires: ["jarvis.module.github"]))
                .accessibilityIdentifier("workflow.choose-github")
                Button("Ajouter Développement") {
                    guard let package = packages.first(where: { $0.moduleId == "jarvis.module.development" }) else { return }
                    model.addModule(projectId: project.id, package: package)
                    stage = .development
                }
                .buttonStyle(.bordered)
                .disabled(!packageIsAvailable("jarvis.module.development") || state.draft == nil || state.draft?.modules.contains(where: { $0.moduleId == "jarvis.module.development" }) == true)
                .accessibilityHint(catalogActionHint(requires: ["jarvis.module.development"]))
                .accessibilityIdentifier("workflow.add-development")
            }
            Text("Vous pourrez enregistrer et reprendre un brouillon incomplet.")
                .font(.callout).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var workflowTitle: String {
        hasRecommendedFlow ? "Développer une issue GitHub" : "Observer les issues GitHub"
    }

    private var workflowDescription: String {
        hasRecommendedFlow
            ? "Confiez une issue prête à votre agent. Jarvis prépare une Pull Request que vous pourrez relire."
            : "Jarvis observe les issues prêtes. Ajoutez Développement pour préparer un parcours de modification et de Pull Request."
    }

    private func chooseRecommendedFlow() {
        model.chooseStartingPoint(projectId: project.id, startingPointId: "github-development")
        showingRecommendedReplacement = state.pendingStartingPointID == "github-development"
        if !showingRecommendedReplacement { stage = .issue }
    }

    @ViewBuilder
    private var catalogAvailability: some View {
        switch moduleCatalog.state {
        case .idle, .loading:
            ProgressView("Chargement du catalogue de modules…")
        case .failed(let message):
            catalogFailure(message)
        case .loaded:
            if let missingPackagesMessage { catalogIncomplete(missingPackagesMessage) }
        }
    }

    private func catalogFailure(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Catalogue de modules indisponible : ajout impossible.", systemImage: "exclamationmark.triangle.fill")
                .font(.callout)
                .foregroundStyle(.red)
            Text(message).font(.callout)
            Button("Réessayer") { Task { await moduleCatalog.refresh() } }
                .disabled(moduleCatalog.state == .loading)
                .accessibilityIdentifier("workflow.catalogue.retry")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func catalogIncomplete(_ message: String) -> some View {
        Label(message, systemImage: "shippingbox")
            .font(.callout)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func catalogActionHint(requires moduleIDs: [String]) -> String {
        guard catalogIsAvailable else {
            return "Le catalogue est indisponible. Réessayez son chargement."
        }
        let missing = moduleIDs.filter { !packageIsAvailable($0) }
        guard !missing.isEmpty else { return "" }
        let names = missing.map { $0 == "jarvis.module.github" ? "GitHub" : "Développement" }
        return "Module manquant : \(names.joined(separator: " et "))."
    }

    @ViewBuilder
    private var stageSettings: some View {
        switch stage {
        case .issue:
            ForEach(development) { module in
                Text("Quand une issue porte le label").font(.callout.weight(.medium))
                TextField("Label de départ", text: guidedReadyLabel)
                    .textFieldStyle(.roundedBorder)
                    .focused($focusedInput, equals: .readyLabel(module.id))
                    .accessibilityLabel("Label de départ des issues")
                    .accessibilityIdentifier("workflow.development.ready-label")
            }
            Text("Les issues fermées ou bloquées ne démarrent pas. Les autres attendent leur tour.")
                .font(.callout).foregroundStyle(.secondary)
            githubCard
        case .development:
            Text("Préparer une copie de travail isolée").font(.headline)
            repositoryBranchControl
            commandField("install", title: "Commande d’installation")
            ForEach(development) { module in
                Picker("Confirmer la préparation", selection: configuration(module, "preparation")) {
                    Text("Choisir une préparation").tag("")
                    Text("Exécuter la commande d’installation").tag("install")
                        .disabled(state.draft?.commands["install"]?.isEmpty != false)
                    Text("Aucune préparation nécessaire").tag("none")
                }
                .focused($focusedInput, equals: .preparation(module.id))
                .accessibilityIdentifier("workflow.preparation")
            }
            if development.isEmpty { Text("Ajoutez Développement au workflow.") }
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
            if development.isEmpty { Text("Ajoutez Développement au workflow.") }
            Text("Modifier une commande demande de la confirmer à nouveau. Les autres choix sont conservés.")
                .font(.callout).foregroundStyle(.secondary)
        case .pullRequest:
            Text(flowConfirmed
                 ? "Après des validations réussies, Development crée le commit et pousse la branche. GitHub crée ensuite la PR à partir de sa demande. Vous relisez et fusionnez vous-même."
                 : hasDevelopment
                    ? "Confirmez les réglages du parcours pour vérifier la demande de Pull Request."
                    : "Ajoutez Développement pour préparer une Pull Request après les validations.")
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

    private var repositoryBranchControl: some View {
        ForEach(state.draft?.repositories ?? [], id: \.id) { repository in
            VStack(alignment: .leading, spacing: 4) {
                Text("Branche cible").font(.callout.weight(.medium))
                TextField("Branche cible", text: Binding(
                    get: { branchInputs[repository.id] ?? state.draft?.repositories.first(where: { $0.id == repository.id })?.defaultBranch ?? "" },
                    set: { branchInputs[repository.id] = $0; branchErrors[repository.id] = nil }))
                    .textFieldStyle(.roundedBorder)
                    .focused($focusedInput, equals: .branch(repository.id))
                    .onSubmit { commitBranch(repositoryID: repository.id) }
                    .accessibilityLabel("Branche cible pour \(repository.id)")
                    .accessibilityIdentifier("workflow.development.branch.\(repository.id)")
                Text("Détectée pour \(repository.id); modifiable avant l’enregistrement.")
                    .font(.caption).foregroundStyle(.secondary)
                if let error = branchErrors[repository.id] {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            }
        }
    }

    private func validationRow(_ module: ProjectModuleDraft, _ name: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            commandField(name, title: name)
            Toggle("Confirmer cette vérification", isOn: Binding(
                get: { state.draft?.modules.first { $0.id == module.id }?.validationOrder.contains(name) ?? false },
                set: { model.selectValidationCommand(projectId: project.id, moduleID: module.id, name: name, selected: $0) }))
                .focused($focusedInput, equals: .validation(module.id, name))
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

    private var guidedReadyLabel: Binding<String> {
        Binding(
            get: { guidedReadyLabelValue },
            set: { model.setGuidedReadyLabel(projectId: project.id, label: $0) })
    }

    private var guidedReadyLabelValue: String {
        development.first?.configurationValue(for: "readyLabel")
            ?? state.draft?.modules.first { $0.enabled && $0.moduleId == "jarvis.module.github" }?.configurationValue(for: "readyLabel")
            ?? ""
    }

    private var githubCard: some View {
        let github = state.draft?.modules.first { $0.moduleId == "jarvis.module.github" }
        return GroupBox {
            if let github {
                VStack(alignment: .leading, spacing: 12) {
                    repositorySummary
                    intervalControl(github)
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
                Text("Ajoutez GitHub au workflow pour choisir le dépôt et la fréquence.")
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
            HStack {
                TextField("Minutes (1 à 60)", text: Binding(
                    get: { intervalInputs[module.id] ?? GitHubPollingFrequency.display(seconds: Int(value)) },
                    set: { intervalInputs[module.id] = $0; intervalError = nil }))
                    .textFieldStyle(.roundedBorder)
                    .focused($focusedInput, equals: .interval(module.id))
                    .onSubmit { commitInterval(module) }
                    .accessibilityIdentifier("workflow.github.interval")
                    .accessibilityLabel("Fréquence de vérification en minutes")
                Stepper(value: Binding(
                    get: { min(60, max(1, (Int(value) ?? 60) / 60)) },
                    set: { minutes in
                        intervalInputs[module.id] = String(minutes)
                        intervalError = nil
                        model.apply(.setModuleConfiguration(module.id, "pollIntervalSeconds", String(minutes * 60)),
                                    projectId: project.id, packages: packages)
                    }), in: 1...60) {
                    Text("Ajuster la fréquence")
                }
                .accessibilityIdentifier("workflow.github.interval.stepper")
                .accessibilityLabel("Ajuster la fréquence de vérification en minutes")
            }
            if historical {
                Text("Historique conservé : 15 secondes. Saisissez 1 à 60 pour choisir une nouvelle fréquence.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let intervalError { Text(intervalError).font(.caption).foregroundStyle(.red) }
        }
    }

    private func commitBranch(repositoryID: String) {
        let defaultBranch = state.draft?.repositories.first(where: { $0.id == repositoryID })?.defaultBranch ?? ""
        let branch = (branchInputs[repositoryID] ?? defaultBranch)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !branch.isEmpty else {
            branchErrors[repositoryID] = "La branche cible est requise."
            return
        }
        branchInputs[repositoryID] = branch
        branchErrors[repositoryID] = nil
        model.setRepositoryDefaultBranch(projectId: project.id, repositoryID: repositoryID, branch: branch)
    }

    private func commitInterval(_ module: ProjectModuleDraft) {
        let text = intervalInputs[module.id] ?? GitHubPollingFrequency.display(
            seconds: Int(module.configurationValues["pollIntervalSeconds"] ?? "60"))
        guard let seconds = GitHubPollingFrequency.seconds(fromMinutes: text) else {
            intervalError = "La fréquence doit être comprise entre 1 et 60 minutes."
            return
        }
        intervalInputs[module.id] = String(seconds / 60)
        intervalError = nil
        model.apply(.setModuleConfiguration(module.id, "pollIntervalSeconds", String(seconds)),
                    projectId: project.id, packages: packages)
    }

    private var accessSummary: some View {
        let ready = !state.resourceChoices.isEmpty && state.resourceChoices.allSatisfy { $0.status == .bound }
        return GroupBox("Accès et agent") {
            VStack(alignment: .leading, spacing: 8) {
                Label(ready ? "Accès configurés" : "Accès à choisir", systemImage: ready ? "checkmark.circle" : "person.crop.circle.badge.questionmark")
                Text("Choisissez le compte GitHub et l’agent Codex dans l’étape Accès et agent.")
                    .font(.callout).foregroundStyle(.secondary)
                Button("Ouvrir Accès et agent") { openConnections?() }
                    .disabled(openConnections == nil)
                    .accessibilityIdentifier("workflow.open-connections")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
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

private enum WorkflowInputFocus: Hashable {
    case branch(String)
    case interval(UUID)
    case readyLabel(UUID)
    case preparation(UUID)
    case validation(UUID, String)
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
    var subtitle: String {
        switch self {
        case .issue: "Label et aucun bloqueur"
        case .development: "Copie de travail isolée"
        case .validation: "Commandes du projet"
        case .pullRequest: "À relire par vous"
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
