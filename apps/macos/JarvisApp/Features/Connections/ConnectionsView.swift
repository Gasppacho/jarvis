import JarvisCore
import SwiftUI

public struct ConnectionsView: View {
    let model: ConnectionsModel

    public init(model: ConnectionsModel) {
        self.model = model
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Text("Connections").font(.title2.bold())
                Spacer()
                Button("Actualiser les comptes") {
                    Task { await model.refresh() }
                }
                .disabled(model.isRefreshing)
            }

            GroupBox("GitHub") {
                content
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(24)
        .task { await model.refresh() }
    }

    @ViewBuilder
    private var content: some View {
        switch model.discoveryState {
        case .searching:
            Label("Recherche des comptes", systemImage: "magnifyingglass")
                .padding(.vertical, 4)
        case .none:
            ContentUnavailableView {
                Label("Aucun compte découvert", systemImage: "person.crop.circle.badge.questionmark")
            } description: {
                Text(ConnectionsModel.emptyDiscoveryMessage)
            } actions: {
                Button("Réessayer") { Task { await model.refresh() } }
                Link("Aide de connexion", destination: URL(string: "https://cli.github.com/manual/gh_auth_login")!)
            }
        case .unavailable:
            Label(
                model.errorMessage ?? "Impossible de vérifier les comptes GitHub.",
                systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
        case .accounts:
            VStack(alignment: .leading, spacing: 12) {
                ForEach(model.connections) { connection in
                    let presentation = model.presentation(for: connection)
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(connection.accountLabel).font(.headline)
                            Spacer()
                            Text(presentation.status)
                                .font(.callout.weight(.medium))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(.quaternary, in: Capsule())
                        }
                        Text("GitHub")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(presentation.diagnostic)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        if presentation.status == "Accès requis" {
                            Link(
                                presentation.action,
                                destination: URL(string: "https://cli.github.com/manual/gh_auth_login")!)
                        }
                        DisclosureGroup("Advanced") {
                            Text("Identifiant de support : \(connection.id)")
                                .font(.caption)
                                .textSelection(.enabled)
                        }
                    }
                    .padding(12)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}
