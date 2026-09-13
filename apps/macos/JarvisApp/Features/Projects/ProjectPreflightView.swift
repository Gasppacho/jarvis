import JarvisAPI
import JarvisCore
import SwiftUI

struct ProjectPreflightView: View {
    let model: ProjectConfigurationModel
    let project: Project
    let packages: [ModulePackage]
    var showsActivation = true
    let repair: (ProjectOnboardingStep) -> Void
    private var state: ProjectConfigurationState { model.state(for: project.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
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
                        if case .current = state.preflight {
                            ForEach(report.checks.filter { $0.status == .passed && ($0.id.hasPrefix("repository:") || $0.id == "runtime") }, id: \.id) { check in
                                Label("\(check.title) : vérifié", systemImage: "checkmark.circle")
                            }
                        }
                        if let draft = state.draft {
                            ForEach(draft.modules.filter { $0.enabled && $0.moduleId == "jarvis.module.development" }) { module in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Commandes choisies — à exécuter").font(.headline)
                                    switch module.configurationValues["preparation"] {
                                    case "none": Text("Installation : aucune")
                                    case "install": Text("Installation : \(draft.commands["install"] ?? "à renseigner")").textSelection(.enabled)
                                    default: Text("Installation : choix à confirmer")
                                    }
                                    ForEach(module.validationOrder, id: \.self) { name in
                                        Text("\(name) : \(draft.commands[name] ?? "à renseigner")").textSelection(.enabled)
                                    }
                                    if module.validationOrder.isEmpty { Text("Vérifications : choix à confirmer") }
                                }
                            }
                        }
                        ForEach(report.checks.filter { $0.status == .failed }, id: \.id) { check in
                            VStack(alignment: .leading, spacing: 5) {
                                Label(check.title, systemImage: "exclamationmark.triangle").font(.headline)
                                Text(check.impact).fixedSize(horizontal: false, vertical: true)
                                Button("Corriger — \(ProjectPreflightState.repairStep(check).title)") {
                                    repair(ProjectPreflightState.repairStep(check))
                                }
                                .accessibilityHint("Ouvrir l’étape permettant de corriger \(check.title)")
                                .accessibilityIdentifier("project.preflight.repair.\(check.id)")
                            }.accessibilityElement(children: .contain)
                        }
                        if let rule = report.rule {
                            Label("Issue ouverte · label \(rule.label) · aucun bloqueur ouvert", systemImage: "tag")
                            Text("Une issue à la fois. Résultat attendu : une PR à relire et fusionner manuellement.")
                        }
                        DisclosureGroup("Détails des contrôles (\(report.checks.count))") {
                            ForEach(report.checks, id: \.id) { check in
                                VStack(alignment: .leading, spacing: 4) {
                                    Label(check.title, systemImage: check.status == .passed ? "checkmark.circle" : "exclamationmark.triangle")
                                    Text(check.impact).font(.caption).foregroundStyle(.secondary)
                                }.padding(.vertical, 4)
                            }
                            Text("Empreinte : \(report.compositionFingerprint)").font(.caption.monospaced()).textSelection(.enabled)
                        }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            GroupBox("Première exécution") {
                VStack(alignment: .leading, spacing: 12) {
                    if let scope = state.pendingScopeDescription { Text(scope) }
                    if let report = state.preflight.report {
                        if let ref = report.rule?.selectedWorkItemRef {
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
                        case .empty: Text("Aucune issue correspondante pour le moment. Vous pouvez surveiller les prochaines issues prêtes.")
                        case .unavailable: Label("La liste des issues n’a pas pu être vérifiée. Corrigez les contrôles ci-dessus, puis réessayez.", systemImage: "exclamationmark.triangle")
                        case .available: Text("\(report.candidateEligibility.items.filter { $0.status == .eligible }.count) issue(s) prête(s) sur \(report.candidateEligibility.items.count) examinée(s).")
                        }
                        ForEach(report.candidateEligibility.items, id: \.workItemRef) { item in
                            VStack(alignment: .leading, spacing: 6) {
                                Text("\(ProjectPreflightState.issueLabel(item.workItemRef)) — \(item.title)").font(.headline)
                                Label(item.status == .eligible ? "Prête" : item.status == .ineligible ? "Non prête" : "Impossible à vérifier", systemImage: item.status == .eligible ? "checkmark.circle" : "pause.circle")
                                Text(item.reason).font(.callout)
                                if !item.blockerRefs.isEmpty {
                                    Text("Bloqueurs ouverts : \(item.blockerRefs.map(ProjectPreflightState.issueLabel).joined(separator: ", "))")
                                }
                                if report.rule?.selectedWorkItemRef != item.workItemRef {
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
