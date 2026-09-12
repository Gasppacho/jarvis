import JarvisCore
import SwiftUI

struct ProjectPreflightView: View {
    let model: ProjectConfigurationModel
    let project: Project
    let packages: [ModulePackage]
    let repair: (ProjectOnboardingStep) -> Void
    private var state: ProjectConfigurationState { model.state(for: project.id) }

    var body: some View {
        GroupBox("Review") {
            VStack(alignment: .leading, spacing: 12) {
                Label(state.preflight.title, systemImage: state.preflight.canActivate ? "checkmark.seal.fill" : "checklist")
                    .font(.headline)
                if state.preflight == .loading { ProgressView("Vérification Engine en cours…") }
                if case .failed(let message) = state.preflight {
                    Label(message, systemImage: "network.slash").foregroundStyle(.orange)
                }
                Button(state.preflight == .unchecked ? "Vérifier que le workflow est prêt" : "Relancer le préflight") {
                    Task { await model.preflight(projectId: project.id) }
                }
                .disabled(state.preflight == .loading || state.isSaving || !state.isDraftSaved)
                if !state.isDraftSaved { Text("Enregistrez le brouillon, puis relancez le préflight.").foregroundStyle(.secondary) }
                if let scope = state.pendingScopeDescription { Text(scope) }
                if let report = state.preflight.report {
                    ForEach(report.checks, id: \.id) { check in
                        VStack(alignment: .leading, spacing: 5) {
                            Label(check.title, systemImage: check.status == .passed ? "checkmark.circle" : "exclamationmark.triangle")
                            Text(check.impact).font(.callout).fixedSize(horizontal: false, vertical: true)
                            if check.status == .failed {
                                Button("Corriger — \(check.repairStep.rawValue)") { repair(ProjectPreflightState.repairStep(check)) }
                                    .accessibilityHint("Ouvrir le contrôle permettant de corriger \(check.title)")
                            }
                        }.accessibilityElement(children: .contain)
                    }
                    if let rule = report.rule {
                        Text("Règle : \(rule.label) · Une issue à la fois").font(.headline)
                        Text(rule.selectedWorkItemRef.map { "Essai limité à \($0)" } ?? "Surveillance de toutes les issues éligibles")
                        if state.canRestoreTrial {
                            Button("Surveiller toutes les issues éligibles") {
                                Task { await model.scopeWorkflow(projectId: project.id, workItemRef: nil, packages: packages) }
                            }.disabled(!scopeEnabled)
                        }
                    }
                    if report.candidateEligibility.status == .empty {
                        Text("Aucune issue correspondante pour le moment")
                    } else if report.candidateEligibility.status == .unavailable {
                        Label("Impossible de vérifier l’éligibilité", systemImage: "exclamationmark.triangle")
                    }
                    ForEach(report.candidateEligibility.items, id: \.workItemRef) { item in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(item.title).font(.headline)
                            Text(item.workItemRef).font(.caption).textSelection(.enabled)
                            Label(item.status == .eligible ? "Éligible" : item.status == .ineligible ? "Non éligible" : "Impossible à vérifier", systemImage: item.status == .eligible ? "checkmark.circle" : "pause.circle")
                            Text("\(item.openDependencyCount) dépendance(s) ouverte(s). \(item.reason)")
                            ForEach(item.blockerRefs, id: \.self) { ref in Text(ref).font(.callout).textSelection(.enabled) }
                            Button("Essayer avec cette issue uniquement") {
                                Task { await model.scopeWorkflow(projectId: project.id, workItemRef: item.workItemRef, packages: packages) }
                            }.disabled(!scopeEnabled)
                        }.padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                    }
                    DisclosureGroup("Advanced") {
                        Text(report.compositionFingerprint).font(.caption.monospaced()).textSelection(.enabled)
                        Text("Préflight Engine v1 · Aucun travail lancé par cette vérification.")
                    }
                }
                Text("Activate workflow autorise le polling et l’admission. Une issue déjà éligible peut démarrer immédiatement. Revue et fusion de la PR restent manuelles.")
                    .font(.callout).fixedSize(horizontal: false, vertical: true)
                switch state.activation {
                case .activating: ProgressView("Activation en cours…")
                case .rejected(_, let message): Label("Activation rejetée : \(message)", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                case .transportFailure(let message): Label("Erreur de transport à l’activation : \(message)", systemImage: "network.slash").foregroundStyle(.orange)
                case .succeeded: Label("Workflow activé", systemImage: "bolt.circle.fill")
                case .idle: EmptyView()
                }
                Button("Activate workflow") { Task { await model.activateWorkflow(projectId: project.id) } }
                    .disabled(!state.preflight.canActivate || state.activation == .activating || state.activation == .succeeded || !state.isDraftSaved || !state.runtimeAllowsActivation)
                if let message = state.errorMessage { Text(message).foregroundStyle(.orange) }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private var scopeEnabled: Bool {
        guard case .current = state.preflight else { return false }
        return state.isDraftSaved && !state.isSaving && state.activation != .activating
    }
}
