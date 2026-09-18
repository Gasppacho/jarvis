import JarvisAPI
import JarvisCore
import SwiftUI

struct ProjectPreflightView: View {
    let model: ProjectConfigurationModel
    let project: Project
    let packages: [ModulePackage]
    var showsActivation = true
    let repair: (ProjectPreflightRepairTarget) -> Void
    private var state: ProjectConfigurationState { model.state(for: project.id) }
    private var observesOnly: Bool {
        state.draft?.modules.contains { $0.enabled && $0.moduleId == "jarvis.module.development" } == false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            GroupBox("Avant de démarrer") {
                VStack(alignment: .leading, spacing: 4) {
                    if case .current(let report) = state.preflight {
                        Label(
                            "Accès : \(report.checks.contains { $0.status == .failed && [.connections, .repository].contains(ProjectPreflightState.repairStep($0)) } ? "à corriger" : "vérifiés")",
                            systemImage: "person.crop.circle")
                        Label(
                            report.candidateEligibility.status == .unavailable
                                ? "Déclenchement et portée : accès GitHub non vérifiable"
                                : report.configuredWorkItemRef.map { "Déclenchement et portée : essai limité à \(ProjectPreflightState.issueLabel($0))" } ?? "Déclenchement et portée : surveillance des issues prêtes",
                            systemImage: "scope")
                    } else {
                        Label("Accès : à vérifier", systemImage: "person.crop.circle")
                        Label("Déclenchement et portée : à vérifier", systemImage: "scope")
                    }
                    Label(
                        observesOnly
                            ? "Préparation et vérifications : aucune en observation seule"
                            : "Préparation et vérifications : gérées automatiquement par Development",
                        systemImage: "terminal")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            GroupBox("Vérifier la configuration") {
                VStack(alignment: .leading, spacing: 12) {
                    Label(state.preflight.title, systemImage: state.preflight.canActivate ? "checkmark.seal.fill" : "checklist")
                        .font(.headline)
                    Text("Ce contrôle lit les accès et la configuration. Il ne lance ni agent ni commande de validation.")
                        .foregroundStyle(.secondary)
                    if state.preflight == .loading { ProgressView("Vérification en cours…") }
                    if case .failed(let message) = state.preflight {
                        Label(message, systemImage: "network.slash").foregroundStyle(.orange)
                    }
                    Button("Vérifier la configuration") {
                        Task { await model.preflight(projectId: project.id) }
                    }
                    .disabled(state.preflight == .loading || state.isSaving || !state.isDraftSaved)
                    .accessibilityIdentifier("project.preflight.check")
                    if !state.isDraftSaved { Text("Enregistrez le brouillon avant de vérifier.").foregroundStyle(.secondary) }
                    if let report = state.preflight.report {
                        if let date = state.preflightReceivedAt {
                            Text("Dernier contrôle reçu : \(date.formatted(date: .abbreviated, time: .standard))").font(.caption)
                        }
                        if case .current = state.preflight, report.valid && report.configurationReady {
                            Label("Configuration vérifiée", systemImage: "checkmark.circle")
                            Text("Les vérifications automatiques seront exécutées lors du premier démarrage.")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                        ForEach(ProjectPreflightState.repairGroups(report)) { group in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(group.step.title).font(.headline)
                                if let check = group.checks.first {
                                    Label(ProjectPreflightState.userFacingTitle(check), systemImage: "exclamationmark.triangle")
                                    Text(ProjectPreflightState.userFacingImpact(check))
                                        .font(.callout)
                                    if group.checks.count > 1 {
                                        Text("Même correction pour plusieurs contrôles concernés.")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Button("Corriger") { repair(ProjectPreflightState.repairTarget(group.checks[0])) }
                                    .accessibilityHint("Ouvrir l’étape permettant de corriger ce contrôle")
                                    .accessibilityIdentifier("project.preflight.repair.\(group.id)")
                            }
                            .accessibilityElement(children: .contain)
                        }
                        if let trigger = report.trigger {
                            Label("Issue ouverte · label \(trigger.readyLabel) · aucun bloqueur ouvert", systemImage: "tag")
                            Text("Une issue à la fois. Résultat attendu : une PR à relire et fusionner manuellement.")
                        }
                        DisclosureGroup("Détails techniques des contrôles (\(report.checks.count))") {
                            ForEach(report.checks, id: \.id) { check in
                                VStack(alignment: .leading, spacing: 4) {
                                    Label(check.title, systemImage: check.status == .passed ? "checkmark.circle" : "exclamationmark.triangle")
                                    Text(check.impact).font(.caption).foregroundStyle(.secondary)
                                    Text("Identifiant : \(check.id)").font(.caption2.monospaced()).textSelection(.enabled)
                                    Text("Étape : \(ProjectPreflightState.repairStep(check).title)").font(.caption2).foregroundStyle(.secondary)
                                }.padding(.vertical, 4)
                            }
                            Text("Empreinte : \(report.compositionFingerprint)").font(.caption.monospaced()).textSelection(.enabled)
                        }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            GroupBox(observesOnly ? "Observation des issues" : "Première exécution") {
                VStack(alignment: .leading, spacing: 12) {
                    if observesOnly {
                        Text("GitHub observe les issues du dépôt. Aucun agent ne démarre et aucune branche ou Pull Request n’est créée sans Développement.")
                    } else {
                    if let scope = state.pendingScopeDescription { Text(scope) }
                    if let report = state.preflight.report {
                        if let ref = report.configuredWorkItemRef {
                            Label("Essai limité à \(ProjectPreflightState.issueLabel(ref))", systemImage: "scope").font(.headline)
                            Text("Les autres issues ne seront pas démarrées. Le bouton final lance cet essai après vérification.")
                            if state.canRestoreTrial {
                                Button("Choisir la surveillance des issues prêtes") {
                                    Task { await model.scopeWorkflow(projectId: project.id, workItemRef: nil, packages: packages) }
                                }
                                .disabled(!scopeEnabled)
                                .accessibilityIdentifier("project.preflight.scope.all")
                            }
                        } else {
                            Text("Choisissez une issue pour un essai limité, ou activez la surveillance avec le bouton final.")
                        }
                        switch report.candidateEligibility.status {
                        case .empty: Label(report.candidateStatusLabel, systemImage: "tray")
                        case .unavailable: Label("\(report.candidateStatusLabel). Corrigez les contrôles d’accès puis réessayez.", systemImage: "exclamationmark.triangle")
                        case .available: Label(report.candidateStatusLabel, systemImage: "checkmark.circle")
                        }
                        ForEach(report.candidateEligibility.items, id: \.workItemRef) { item in
                            VStack(alignment: .leading, spacing: 6) {
                                Text("\(ProjectPreflightState.issueLabel(item.workItemRef)) — \(item.title)").font(.headline)
                                Label(item.status == .eligible ? "Prête" : item.status == .ineligible ? "Non prête" : "Impossible à vérifier", systemImage: item.status == .eligible ? "checkmark.circle" : "pause.circle")
                                Text(item.reason).font(.callout)
                                if !item.blockerRefs.isEmpty {
                                    Text("Bloqueurs ouverts : \(item.blockerRefs.map(ProjectPreflightState.issueLabel).joined(separator: ", "))")
                                }
                                if report.configuredWorkItemRef != item.workItemRef {
                                    Button("Choisir \(ProjectPreflightState.issueLabel(item.workItemRef)) pour l’essai") {
                                        Task { await model.scopeWorkflow(projectId: project.id, workItemRef: item.workItemRef, packages: packages) }
                                    }
                                    .disabled(!scopeEnabled || item.status != .eligible)
                                    .accessibilityIdentifier("project.preflight.scope.\(item.workItemRef)")
                                }
                            }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                                .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                        }
                    } else {
                        Text("Vérifiez la configuration pour voir les issues et choisir la portée du démarrage.")
                    }
                    Text("Une issue prête peut démarrer dès l’activation. La relecture et la fusion restent humaines.").font(.callout)
                    }
                    switch state.activation {
                    case .activating: ProgressView("Activation en cours…")
                    case .rejected(_, let message): Label("Activation refusée : \(message)", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                    case .transportFailure(let message): Label("Activation non confirmée : \(message)", systemImage: "network.slash").foregroundStyle(.orange)
                    case .succeeded: Label("Workflow activé", systemImage: "bolt.circle.fill")
                    case .idle: EmptyView()
                    }
                    if showsActivation { ProjectPreflightActivationButton(model: model, projectId: project.id) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
    private var scopeEnabled: Bool {
        guard case .current = state.preflight else { return false }
        return state.isDraftSaved && !state.isSaving && state.activation != .activating
    }
}

struct ProjectPreflightActivationButton: View {
    let model: ProjectConfigurationModel
    let projectId: String
    var body: some View {
        let state = model.state(for: projectId)
        Button(state.preflight.activationTitle) { Task { await model.activateWorkflow(projectId: projectId) } }
            .buttonStyle(.borderedProminent)
            .disabled(!state.preflight.canStartWorkflow || state.activation == .activating || state.activation == .succeeded || !state.isDraftSaved || state.isSaving || !state.runtimeAllowsActivation)
            .accessibilityIdentifier("project.preflight.activate")
            .accessibilityHint("Autoriser le démarrage selon la portée vérifiée. Aucun merge automatique.")
    }
}
