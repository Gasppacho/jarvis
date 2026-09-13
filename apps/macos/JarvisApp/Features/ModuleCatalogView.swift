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
                ProgressView("Chargement des modules…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                ContentUnavailableView {
                    Label("Catalogue indisponible", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Réessayer") { Task { await moduleCatalog.refresh() } }
                        .accessibilityIdentifier("catalogue.retry")
                }
            case .loaded:
                catalogue
            }
        }
        .navigationTitle("Catalogue")
    }

    private var catalogue: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                Text("Catalogue").font(.title2.bold())
                Text("Les modules disponibles composent vos workflows. Pour commencer, choisissez un projet puis l’étape Workflow.")
                    .foregroundStyle(.secondary)
                ForEach(moduleCatalog.packages) { package in
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(package.displayName)
                                .font(.title2.bold())
                            Spacer()
                            Text(package.version)
                                .font(.callout.monospaced())
                                .foregroundStyle(.secondary)
                        }
                        Text(description(for: package))
                            .foregroundStyle(.secondary)

                        DisclosureGroup("Détails techniques") {
                            Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 8) {
                                ForEach(package.presentationFields) { field in
                                    row(field.label, field.value)
                                }
                            }
                            .font(.callout)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)
        }
    }

    private func description(for package: ModulePackage) -> String {
        switch package.id {
        case "jarvis.module.github": "Observe les issues GitHub et réalise les actions demandées sur les Pull Requests."
        case "jarvis.module.automation-rules": "Transforme les événements qui correspondent aux règles du projet en demandes de travail."
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
