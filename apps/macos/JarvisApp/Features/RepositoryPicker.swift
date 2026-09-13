import AppKit
import JarvisCore

@MainActor
func presentRepositoryPicker(
    binding: ProjectBinding,
    project: Project,
    projects: ProjectsModel,
    configuration: ProjectConfigurationModel,
    packages: [ModulePackage]
) {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.prompt = "Autoriser ce dossier"
    panel.message = "Choisissez le dépôt de \(project.name)."
    guard panel.runModal() == .OK, let url = panel.url else { return }
    Task {
        if await projects.reauthorize(
            projectId: project.id, repositoryId: binding.repositoryId,
            replacing: binding.bookmarkRef, with: url
        ) {
            await configuration.refreshAfterRepositoryBindingChange(
                projectId: project.id, packages: packages)
        }
    }
}
