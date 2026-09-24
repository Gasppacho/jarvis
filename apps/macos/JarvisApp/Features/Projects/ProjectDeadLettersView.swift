import JarvisCore
import SwiftUI

struct ProjectDeadLettersView: View {
    let model: ProjectDeadLettersModel
    let projectId: String

    var body: some View {
        let state = model.state(for: projectId)
        Group {
            switch stateView(for: state) {
            case .loading:
                ProgressView("Chargement des livraisons en échec…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .error(let message):
                ContentUnavailableView {
                    Label("Livraisons en échec indisponibles", systemImage: "exclamationmark.triangle.fill")
                } description: {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Jarvis n’a pas pu charger les échecs définitifs de livraison.")
                        DisclosureGroup("Détails de l’erreur") {
                            Text(message)
                                .textSelection(.enabled)
                                .padding(.top, 6)
                        }
                    }
                } actions: {
                    Button("Réessayer") { Task { await model.refresh(projectId: projectId) } }
                }
            case .empty:
                ContentUnavailableView {
                    Label("Aucune livraison en échec", systemImage: "checkmark.circle")
                } description: {
                    Text("Les événements de ce projet ont tous été livrés ou restent en cours de traitement.")
                } actions: {
                    Button("Actualiser") { Task { await model.refresh(projectId: projectId) } }
                }
            case .list:
                list(state)
            }
        }
        .task(id: projectId) {
            await model.refresh(projectId: projectId)
        }
        .navigationTitle("Livraisons en échec")
    }

    private enum StateView {
        case loading
        case error(String)
        case empty
        case list
    }

    private func stateView(for state: ProjectDeadLettersState) -> StateView {
        if state.deadLetters.isEmpty, state.isLoading { return .loading }
        if state.deadLetters.isEmpty, let errorMessage = state.errorMessage {
            return .error(errorMessage)
        }
        if state.deadLetters.isEmpty { return .empty }
        return .list
    }

    private func list(_ state: ProjectDeadLettersState) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .center, spacing: 16) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Livraisons en échec")
                            .font(.largeTitle.weight(.semibold))
                        Text("Événements qui n’ont pas pu être livrés après leurs tentatives prévues.")
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button {
                        Task { await model.refresh(projectId: projectId) }
                    } label: {
                        Label("Actualiser", systemImage: "arrow.clockwise")
                    }
                    .disabled(state.isLoading)
                    .accessibilityIdentifier("dead-letters.refresh")
                }

                if let errorMessage = state.errorMessage {
                    GroupBox {
                        VStack(alignment: .leading, spacing: 8) {
                            Label("Actualisation incomplète", systemImage: "exclamationmark.triangle.fill")
                                .font(.headline)
                            Text("Les données précédentes restent affichées. Réessayez pour obtenir l’état actuel.")
                                .foregroundStyle(.secondary)
                            DisclosureGroup("Détails de l’erreur") {
                                Text(errorMessage)
                                    .textSelection(.enabled)
                                    .padding(.top, 6)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                ForEach(state.deadLetters) { deadLetter in
                    row(deadLetter, state: state)
                }
            }
            .frame(maxWidth: 900, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .top)
            .padding(28)
        }
    }

    private func row(_ deadLetter: DeadLetter, state: ProjectDeadLettersState) -> some View {
        let isReplaying = state.replayingDeliveryIDs.contains(deadLetter.deliveryId)

        return GroupBox {
            VStack(alignment: .leading, spacing: 12) {
                Text(deadLetter.message ?? "Le module n’a fourni aucun détail sur cet échec.")
                    .frame(maxWidth: .infinity, alignment: .leading)

                Label(
                    "Échec le \(deadLetter.createdAt.formatted(date: .abbreviated, time: .shortened))",
                    systemImage: "clock")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                DisclosureGroup("Détails techniques") {
                    Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 8) {
                        LabeledContent("Module destinataire", value: deadLetter.moduleInstanceId)
                        LabeledContent("Identifiant de livraison", value: deadLetter.deliveryId)
                        LabeledContent("Événement", value: deadLetter.eventId)
                        LabeledContent("Code", value: deadLetter.code)
                        LabeledContent("Tentatives", value: String(deadLetter.attempts))
                    }
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .padding(.top, 8)
                }

                if let replayError = state.replayErrorMessages[deadLetter.deliveryId] {
                    Label("La reprise a échoué", systemImage: "exclamationmark.triangle.fill")
                        .font(.callout.weight(.semibold))
                    Text(replayError)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            HStack(spacing: 12) {
                Label("Échec définitif de livraison", systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                    .font(.headline)
                Spacer()
                Button {
                    Task {
                        await model.replay(
                            projectId: projectId, deliveryId: deadLetter.deliveryId)
                    }
                } label: {
                    if isReplaying {
                        Label("Reprise…", systemImage: "hourglass")
                    } else {
                        Label("Rejouer", systemImage: "arrow.clockwise")
                    }
                }
                .disabled(isReplaying)
                .accessibilityIdentifier("dead-letters.replay.\(deadLetter.deliveryId)")
            }
        }
        .accessibilityElement(children: .contain)
    }
}
