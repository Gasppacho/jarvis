import JarvisCore
import SwiftUI

/// Read-only discovery of official bundled Module Packages. Module Instances,
/// project activation and configuration editing belong to the project flow.
struct ModuleCatalogView: View {
    let moduleCatalog: ModuleCatalogModel

    var body: some View {
        Group {
            switch moduleCatalog.state {
            case .idle, .loading:
                ProgressView("Chargement du catalogue…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                ContentUnavailableView {
                    Label("Catalogue indisponible", systemImage: "exclamationmark.triangle.fill")
                } description: {
                    Text(message)
                } actions: {
                    Button("Réessayer") { Task { await moduleCatalog.refresh() } }
                        .accessibilityIdentifier("catalogue.retry")
                }
            case .loaded:
                if moduleCatalog.packages.isEmpty {
                    emptyCatalogue
                } else {
                    catalogue
                }
            }
        }
        .navigationTitle("Catalogue des modules")
    }

    private var emptyCatalogue: some View {
        ContentUnavailableView {
            Label("Aucun module disponible", systemImage: "square.stack.3d.up")
        } description: {
            Text("Le catalogue ne contient aucun module pour le moment.")
        } actions: {
            Button("Actualiser") { Task { await moduleCatalog.refresh() } }
        }
    }

    private var catalogue: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Modules disponibles")
                        .font(.largeTitle.weight(.semibold))
                    Text("Les modules composent le workflow d’un projet. Choisissez un projet, puis ouvrez l’étape Workflow pour les sélectionner.")
                        .foregroundStyle(.secondary)
                }

                ForEach(moduleCatalog.packages) { package in
                    GroupBox {
                        VStack(alignment: .leading, spacing: 14) {
                            Text(description(for: package))
                                .foregroundStyle(.secondary)

                            DisclosureGroup("Détails techniques") {
                                Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 8) {
                                    ForEach(package.presentationFields) { field in
                                        row(field.label, field.value)
                                    }
                                }
                                .font(.callout)
                                .padding(.top, 8)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    } label: {
                        HStack(alignment: .firstTextBaseline) {
                            Text(package.displayName)
                                .font(.headline)
                            Spacer()
                            Text("Version \(package.version)")
                                .font(.callout.monospaced())
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .frame(maxWidth: 900, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .top)
            .padding(28)
        }
    }

    private func description(for package: ModulePackage) -> String {
        switch package.id {
        case "jarvis.module.github": "Observe les issues GitHub et réalise les actions demandées sur les Pull Requests."
        case "jarvis.module.development": "Développe une issue dans un dossier Git isolé, vérifie le résultat et pousse les modifications."
        case "jarvis.module.change-request-review": "Examine une révision de Pull Request et conserve un verdict local."
        default: package.description
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        GridRow(alignment: .top) {
            Text(label).foregroundStyle(.secondary)
            Text(value)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
