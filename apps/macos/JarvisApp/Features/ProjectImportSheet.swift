import JarvisCore
import SwiftUI

/// Read-only inspection and explicit import, followed by the chosen project.
struct ProjectImportSheet: View {
    let projects: ProjectsModel
    let chooseAnotherFolder: () -> Void
    let openProject: (Project, Bool) -> Void

    var body: some View {
        Group {
            switch projects.importState {
            case .idle:
                // Unreachable while the sheet is open: the model is `.idle`
                // only when nothing is on screen.
                EmptyView()

            case .inspecting:
                VStack(spacing: 12) {
                    ProgressView()
                    VStack(spacing: 4) {
                        Text("Inspection du dépôt…")
                            .font(.headline)
                        Text("Lecture seule : aucun fichier ne sera modifié.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(width: 360, height: 120)

            case .confirm(let inspection):
                confirm(inspection)

            case .existing(let project):
                VStack(alignment: .leading, spacing: 16) {
                    Label("Ce dépôt est déjà dans Jarvis", systemImage: "folder.badge.checkmark")
                        .font(.headline)
                    Text(project.name).font(.title3)
                    Text("Retrouvez sa configuration et son travail en cours.")
                        .foregroundStyle(.secondary)
                    HStack {
                        Button("Annuler") { projects.cancelImport() }
                            .keyboardShortcut(.cancelAction)
                        Spacer()
                        Button("Ouvrir ce projet") {
                            projects.cancelImport()
                            openProject(project, false)
                        }
                        .keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier("project.open-existing")
                    }
                }
                .padding(24)
                .frame(width: 480)

            case .saving:
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Création du brouillon…")
                        .foregroundStyle(.secondary)
                }
                .frame(width: 360, height: 120)

            case .failed(let message):
                VStack(alignment: .leading, spacing: 12) {
                    Label("L’import n’a pas abouti", systemImage: "exclamationmark.triangle.fill")
                        .font(.headline)
                        .foregroundStyle(.red)
                    Text(message)
                        .font(.callout)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    HStack {
                        Button("Annuler") { projects.cancelImport() }
                            .keyboardShortcut(.cancelAction)
                        Spacer()
                        Button("Choisir un autre dossier") {
                            projects.cancelImport()
                            chooseAnotherFolder()
                        }
                            .keyboardShortcut(.defaultAction)
                    }
                }
                .padding(24)
                .frame(width: 440)
            }
        }
    }

    private func confirm(_ inspection: RepositoryInspection) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Ajouter un projet")
                .font(.title2.weight(.semibold))

            Text("Vérifiez le dépôt puis donnez un nom à votre projet. Aucun workflow ne démarre à l’import.")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 6) {
                Text("Nom du projet").font(.callout.weight(.medium))
                TextField("Nom du projet", text: Binding(
                    get: { projects.importName }, set: { projects.importName = $0 }))
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("project.import-name")
                    .accessibilityLabel("Nom du projet")
                if let error = projects.importNameError {
                    Text(error).font(.callout).foregroundStyle(.red)
                        .accessibilityIdentifier("project.import-name-error")
                }
            }

            GroupBox("Dépôt détecté") {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                    row("Dépôt Git", "Oui")
                    if let remote = inspection.remoteUrl {
                        row("Dépôt distant", remote)
                    }
                    if let provider = inspection.provider {
                        row("Hébergeur", provider)
                    }
                    if let branch = inspection.defaultBranch {
                        row("Branche de base", branch)
                    }
                    if let packageManager = inspection.packageManager {
                        row("Gestionnaire de paquets", packageManager)
                    }
                }
                .font(.callout)
            }

            HStack {
                Spacer()
                Button("Annuler") { projects.cancelImport() }
                    .keyboardShortcut(.cancelAction)
                Button("Créer le brouillon") {
                    Task {
                        if let project = await projects.confirmImport() { openProject(project, true) }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(projects.importNameError != nil)
                .accessibilityIdentifier("project.confirm-import")
            }
        }
        .padding(24)
        .frame(width: 480)
    }

    private func row(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            Text(value)
                .lineLimit(label == "Dépôt distant" ? nil : 1)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 280, alignment: .leading)
                .textSelection(.enabled)
        }
    }
}
