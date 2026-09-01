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
                ProgressView("Loading Module Packages…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                ContentUnavailableView {
                    Label("Module catalogue unavailable", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                }
            case .loaded:
                catalogue
            }
        }
        .navigationTitle("Module Catalog")
    }

    private var catalogue: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
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
                        Text(package.description)
                            .foregroundStyle(.secondary)

                        Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 8) {
                            ForEach(package.presentationFields) { field in
                                row(field.label, field.value)
                            }
                        }
                        .font(.callout)
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

    private func row(_ label: String, _ value: String) -> some View {
        GridRow(alignment: .top) {
            Text(label).foregroundStyle(.secondary)
            Text(value)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
