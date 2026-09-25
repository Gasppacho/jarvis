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
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Choisissez vos modules")
                    .font(.title2.weight(.semibold))
                Text("Chaque module apporte une capacité au projet. Cliquez sur une carte pour l’ajouter ou la retirer.")
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
                columns: [GridItem(.adaptive(minimum: 260), alignment: .top)],
                alignment: .leading,
                spacing: 16
            ) {
                ForEach(catalogue.items) { item in
                    moduleCard(item)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Aperçu du workflow")
                    .font(.title2.weight(.semibold))
                Text("Jarvis relie automatiquement les modules sélectionnés selon leurs événements.")
                    .foregroundStyle(.secondary)
            }

            if state.draft?.modules.isEmpty != false {
                ContentUnavailableView(
                    "Workflow vide",
                    systemImage: "square.dashed",
                    description: Text("Vous pouvez enregistrer et créer un projet sans module."))
                    .frame(maxWidth: .infinity, minHeight: 180)
                    .jarvisSurface()
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
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top) {
                    Image(systemName: item.systemImage)
                        .font(.title2)
                        .foregroundStyle(Color.accentColor)
                        .frame(width: 42, height: 42)
                        .background(Color.accentColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                    Spacer()
                    if item.isSelected {
                        JarvisStatusBadge(title: "Sélectionné", symbol: "checkmark", color: .green)
                    }
                }
                Text(item.title)
                    .font(.title3.weight(.semibold))
                Text(item.description)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Label(item.isSelected ? "Retirer du projet" : "Ajouter au projet",
                      systemImage: item.isSelected ? "minus.circle" : "plus.circle")
                    .font(.callout.weight(.medium))
                    .foregroundStyle(Color.accentColor)
            }
            .frame(maxWidth: .infinity, minHeight: 158, alignment: .leading)
            .jarvisSurface(highlighted: item.isSelected)
        }
        .buttonStyle(.plain)
        .disabled(!item.isAvailable || state.draft == nil)
        .accessibilityAddTraits(item.isSelected ? .isSelected : [])
        .accessibilityIdentifier("workflow.catalogue.\(item.id)")
    }
}
