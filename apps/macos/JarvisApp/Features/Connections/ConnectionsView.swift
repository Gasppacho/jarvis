import JarvisCore
import SwiftUI

public struct ConnectionsView: View {
    let model: ConnectionsModel
    @State private var accountReference = ""

    public init(model: ConnectionsModel) {
        self.model = model
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Text("Connections").font(.title2.bold())
                Spacer()
                if model.isRefreshing { ProgressView().controlSize(.small) }
            }

            Text("Register a GitHub connection with the opaque gh account reference already configured in gh. No token is requested.")
                .font(.callout)
                .foregroundStyle(.secondary)

            HStack {
                TextField("gh://Account", text: $accountReference)
                    .textFieldStyle(.roundedBorder)
                Button("Register") {
                    Task {
                        if await model.register(accountReference: accountReference) {
                            accountReference = ""
                        }
                    }
                }
                .disabled(
                    accountReference.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || model.isRegistering)
            }

            if let errorMessage = model.errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.orange)
            }

            if model.connections.isEmpty && !model.isRefreshing {
                ContentUnavailableView {
                    Label("No connections", systemImage: "link.badge.plus")
                } description: {
                    Text("Register an authenticated gh account to make it available to Projects.")
                }
            } else {
                List(model.connections) { connection in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(connection.accountLabel).font(.headline)
                            Text(connection.provider)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(connection.status)
                            .font(.callout.weight(.medium))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(.quaternary, in: Capsule())
                        Button("Validate") {
                            Task { await model.validate(connectionID: connection.id) }
                        }
                        .disabled(model.isValidating(connectionID: connection.id))
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(24)
        .task { await model.refresh() }
    }
}
