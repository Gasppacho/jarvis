import JarvisCore
import SwiftUI

public struct ConnectionsView: View {
    let model: ConnectionsModel

    @State private var accountReference = ""

    public init(model: ConnectionsModel) {
        self.model = model
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .center, spacing: 16) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Comptes et connexions")
                            .font(.largeTitle.weight(.semibold))
                        Text("Les comptes sont disponibles sur ce Mac. Chaque projet choisit explicitement ceux qu’il peut utiliser.")
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 12)
                    Button {
                        Task { await model.refresh() }
                    } label: {
                        Label("Actualiser", systemImage: "arrow.clockwise")
                    }
                    .disabled(model.isRefreshing)
                    .accessibilityIdentifier("connections.refresh")
                }

                GroupBox("GitHub") {
                    discovery
                }

                GroupBox("Ajouter un compte") {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Saisissez une référence GitHub prise en charge, par exemple gh://Account.")
                            .foregroundStyle(.secondary)
                        HStack(spacing: 12) {
                            TextField("Référence du compte", text: $accountReference)
                                .textFieldStyle(.roundedBorder)
                                .accessibilityIdentifier("connections.account-reference")
                            Button {
                                let reference = accountReference
                                Task {
                                    if await model.register(accountReference: reference) {
                                        accountReference = ""
                                    }
                                }
                            } label: {
                                if model.isRegistering {
                                    Label("Ajout en cours…", systemImage: "hourglass")
                                } else {
                                    Label("Ajouter", systemImage: "plus")
                                }
                            }
                            .disabled(model.isRegistering || accountReference.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("connections.register")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                if let errorMessage = model.errorMessage {
                    GroupBox {
                        VStack(alignment: .leading, spacing: 8) {
                            Label("L’opération n’a pas abouti", systemImage: "exclamationmark.triangle.fill")
                                .font(.headline)
                            Text(errorMessage)
                                .textSelection(.enabled)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .accessibilityIdentifier("connections.error")
                }
            }
            .frame(maxWidth: 900, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .top)
            .padding(28)
        }
        .navigationTitle("Comptes et connexions")
        .task { await model.refresh() }
    }

    @ViewBuilder
    private var discovery: some View {
        switch model.discoveryState {
        case .searching:
            ProgressView("Recherche des comptes GitHub…")
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 8)
        case .none:
            ContentUnavailableView {
                Label("Aucun compte découvert", systemImage: "person.crop.circle.badge.questionmark")
            } description: {
                Text("Connectez un compte avec GitHub CLI sur ce Mac, puis actualisez la liste.")
            } actions: {
                Button("Actualiser les comptes") { Task { await model.refresh() } }
                Link(
                    "Aide de connexion GitHub",
                    destination: URL(string: "https://cli.github.com/manual/gh_auth_login")!)
            }
        case .unavailable:
            ContentUnavailableView {
                Label("Comptes indisponibles", systemImage: "exclamationmark.triangle.fill")
            } description: {
                Text("Jarvis n’a pas pu charger les comptes GitHub. Réessayez après avoir vérifié que le moteur est disponible.")
            } actions: {
                Button("Réessayer") { Task { await model.refresh() } }
                    .accessibilityIdentifier("connections.retry")
            }
        case .accounts:
            VStack(alignment: .leading, spacing: 12) {
                ForEach(model.connections) { connection in
                    accountCard(connection)
                }
            }
        }
    }

    private func accountCard(_ connection: Connection) -> some View {
        let presentation = model.presentation(for: connection)
        let needsAuthentication = connection.status == "unauthenticated" || connection.status == "revoked"

        return GroupBox {
            VStack(alignment: .leading, spacing: 12) {
                Text(presentation.diagnostic)
                    .foregroundStyle(.secondary)

                HStack(spacing: 12) {
                    if needsAuthentication {
                        Link(
                            "Autoriser GitHub CLI",
                            destination: URL(string: "https://cli.github.com/manual/gh_auth_login")!)
                    }
                    Button {
                        Task { await model.validate(connectionID: connection.id) }
                    } label: {
                        if model.isValidating(connectionID: connection.id) {
                            Label("Vérification…", systemImage: "hourglass")
                        } else {
                            Label("Vérifier l’accès", systemImage: "checkmark.shield")
                        }
                    }
                    .disabled(model.isValidating(connectionID: connection.id))
                    .accessibilityIdentifier("connections.validate.\(connection.id)")
                }

                DisclosureGroup("Détails techniques") {
                    LabeledContent("Identifiant de support", value: connection.id)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                }
                .font(.callout)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            HStack(spacing: 10) {
                Label(connection.accountLabel, systemImage: "person.crop.circle")
                    .font(.headline)
                Spacer()
                Label(
                    presentation.status,
                    systemImage: presentation.isSelectable ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .font(.callout.weight(.medium))
                    .padding(.horizontal, 9)
                    .padding(.vertical, 4)
                    .background(.quaternary, in: Capsule())
            }
        }
        .accessibilityElement(children: .contain)
    }
}
