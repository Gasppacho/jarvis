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
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(6)
                }
                if !development.isEmpty { Label("Le parcours est prêt : Development préparera et vérifiera le travail après activation.",
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
            case .readyLabel: break
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
                if let openAdvanced { openAdvanced() } else { stage = .development }
            case let id? where id.hasPrefix("workflow.validation."):
                if let openAdvanced { openAdvanced() } else { stage = .validation }
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
            Text("GitHub et Développement remplaceront la composition actuelle. Le nom et les réglages du projet sont conservés.")
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
            }) == true else { return hasDevelopment ? "Aucune source" : "Absent" }
            if !hasDevelopment { return "Observation seule" }
            return guidedReadyLabelValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "À configurer" : "Configuré"
        case .development:
            return hasDevelopment ? "Configuré" : "Absent"
        case .validation:
            return hasDevelopment ? "Prévu" : "Sans développement"
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
            Text("Ajoute GitHub et Développement. Vous confirmerez ensuite les accès et l’agent avant toute exécution.")
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
        if hasDevelopment && !hasGitHub { return "Développement sans source" }
        return hasRecommendedFlow ? "Développer une issue GitHub" : "Observer les issues GitHub"
    }

    private var workflowDescription: String {
        if hasDevelopment && !hasGitHub {
            return "Development est configuré, mais aucune source de Work Item ne peut le déclencher automatiquement."
        }
        return hasRecommendedFlow
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
            if development.isEmpty { Text("Ajoutez Développement au workflow.") }
            Text("La préparation du worktree et les vérifications du projet sont choisies automatiquement par Development. L’agent sera choisi à l’étape Accès et agent.")
                .font(.callout).foregroundStyle(.secondary)
        case .validation:
            Text("Vérifications automatiques").font(.headline)
            Text("Development vérifie le travail après le passage de l’agent. Aucune commande n’est à saisir ou à confirmer dans ce parcours.")
                .font(.callout)
        case .pullRequest:
            Text(flowConfirmed
                 ? "Après des validations réussies, Development crée le commit et pousse la branche. GitHub crée ensuite la PR à partir de sa demande. Vous relisez et fusionnez vous-même."
                 : hasDevelopment
                    ? "Confirmez les réglages du parcours pour vérifier la demande de Pull Request."
                    : "Ajoutez Développement pour préparer une Pull Request après les validations.")
            if flowConfirmed {
                Label("Aucune demande de merge dans ce workflow", systemImage: "person.crop.circle.badge.checkmark")
            }
            Text("Les vérifications automatiques doivent réussir avant le commit et la Pull Request. Le contrôle de configuration porte ici sur les accès, le label et les liens du workflow.")
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

    private var guidedReadyLabel: Binding<String> {
        Binding(
            get: { guidedReadyLabelValue },
            set: { model.setGuidedReadyLabel(projectId: project.id, label: $0) })
    }

    private var guidedReadyLabelValue: String {
        development.first?.configurationValue(for: "readyLabel") ?? ""
    }

    private var githubCard: some View {
        return GroupBox {
            if state.draft?.modules.contains(where: { $0.moduleId == "jarvis.module.github" }) == true {
                VStack(alignment: .leading, spacing: 12) {
                    repositorySummary
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
                Text("Ajoutez GitHub au workflow pour observer les issues du dépôt.")
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
    case readyLabel(UUID)
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
        case .validation: "Contrôle automatique"
        case .pullRequest: "À relire par vous"
        }
    }
    var explanation: String {
        switch self {
        case .issue: "GitHub transmet les observations vérifiées ; Development reçoit ensuite une demande pour l’issue éligible."
        case .development: "Development prépare un worktree isolé, puis confie l’issue à votre agent."
        case .validation: "Development vérifie le travail avant tout commit et push."
        case .pullRequest: "Une PR vous permet de relire le résultat avant de le fusionner."
        }
    }
}
