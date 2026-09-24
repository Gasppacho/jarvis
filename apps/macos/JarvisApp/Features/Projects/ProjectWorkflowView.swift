import JarvisCore
import SwiftUI

/// The editable catalogue and the Engine-derived, read-only workflow canvas.
struct ProjectWorkflowView: View {
    let model: ProjectConfigurationModel
    let project: Project
    let packages: [ModulePackage]
    let moduleCatalog: ModuleCatalogModel

    private var state: ProjectConfigurationState { model.state(for: project.id) }
    private var catalogue: WorkflowCatalogPresentation {
        WorkflowCatalogPresentation(
            availableModuleIDs: packages.map(\.moduleId),
            selectedModuleIDs: state.draft?.modules.map(\.moduleId) ?? [])
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Catalogue").font(.title2.bold())
                Text("Sélectionnez les modules du projet. Chaque module peut être ajouté une seule fois.")
                    .foregroundStyle(.secondary)
            }

            switch moduleCatalog.state {
            case .failed(let message):
                VStack(alignment: .leading, spacing: 8) {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                    Button("Réessayer le catalogue") {
                        Task { await moduleCatalog.refresh() }
                    }
                }
            case .idle, .loading:
                ProgressView("Chargement du catalogue…")
            case .loaded:
                EmptyView()
            }

            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 320), alignment: .top)],
                alignment: .leading,
                spacing: 12
            ) {
                ForEach(catalogue.items) { item in
                    moduleCard(item)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Workflow").font(.title2.bold())
                Text("Le canvas est construit depuis les événements émis et consommés par les modules.")
                    .foregroundStyle(.secondary)
            }

            if state.draft?.modules.isEmpty != false {
                ContentUnavailableView(
                    "Workflow vide",
                    systemImage: "square.dashed",
                    description: Text("Vous pouvez enregistrer et créer un projet sans module."))
                    .frame(maxWidth: .infinity, minHeight: 220)
            } else if let graph = state.compositionGraph {
                WorkflowCanvasView(presentation: WorkflowCanvasPresentation(graph: graph))
            } else {
                ProgressView("Construction du workflow…")
                    .frame(maxWidth: .infinity, minHeight: 220)
            }

        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func moduleCard(_ item: WorkflowCatalogPresentation.Item) -> some View {
        Button {
            if let module = state.draft?.modules.first(where: { $0.moduleId == item.id }) {
                model.removeModule(projectId: project.id, moduleId: module.id)
            } else if let package = packages.first(where: { $0.moduleId == item.id }) {
                model.addModule(projectId: project.id, package: package)
            }
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                Label(item.title, systemImage: item.systemImage)
                    .font(.headline)
                Text(item.description)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Label(
                    item.isSelected ? "Sélectionné" : "Ajouter",
                    systemImage: item.isSelected ? "checkmark.circle.fill" : "plus.circle")
                    .font(.callout.weight(.medium))
            }
            .frame(maxWidth: .infinity, minHeight: 132, alignment: .leading)
            .padding(12)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .disabled(!item.isAvailable || state.draft == nil)
        .accessibilityAddTraits(item.isSelected ? .isSelected : [])
        .accessibilityIdentifier("workflow.catalogue.\(item.id)")
    }
}
