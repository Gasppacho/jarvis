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

            HStack(alignment: .top, spacing: 12) {
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

            switch moduleCatalog.state {
            case .failed(let message):
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
            case .idle, .loading:
                ProgressView("Chargement du catalogue…")
            case .loaded:
                EmptyView()
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
                Image(systemName: item.systemImage).font(.title2)
                Text(item.title).font(.headline)
                Text(item.description)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Label(
                    item.isSelected ? "Sélectionné" : "Ajouter",
                    systemImage: item.isSelected ? "checkmark.circle.fill" : "plus.circle")
                    .font(.callout.weight(.medium))
            }
            .frame(maxWidth: .infinity, minHeight: 140, alignment: .leading)
            .padding(16)
            .background(
                item.isSelected ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.06),
                in: RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(item.isSelected ? Color.accentColor : Color.secondary.opacity(0.25)))
        }
        .buttonStyle(.plain)
        .disabled(!item.isAvailable || state.draft == nil)
        .accessibilityAddTraits(item.isSelected ? .isSelected : [])
        .accessibilityIdentifier("workflow.catalogue.\(item.id)")
    }
}
