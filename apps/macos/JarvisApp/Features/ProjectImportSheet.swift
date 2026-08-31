import JarvisCore
import SwiftUI

/// Wizard étapes 1–2 as the import flow stands in ticket 02: what discovery
/// found, and the engine's proposed configuration, with one confirmation
/// before anything is saved. Slots and modules are the wizard's later steps
/// (tickets 03+), not part of the draft import.
struct ProjectImportSheet: View {
    let projects: ProjectsModel

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
                    Text("Inspecting the repository…")
                        .foregroundStyle(.secondary)
                }
                .frame(width: 360, height: 120)

            case .confirm(let inspection):
                confirm(inspection)

            case .saving:
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Importing the project…")
                        .foregroundStyle(.secondary)
                }
                .frame(width: 360, height: 120)

            case .failed(let message):
                VStack(alignment: .leading, spacing: 12) {
                    Label("The import could not be completed", systemImage: "exclamationmark.triangle.fill")
                        .font(.headline)
                        .foregroundStyle(.red)
                    Text(message)
                        .font(.callout)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    HStack {
                        Spacer()
                        Button("Close") { projects.cancelImport() }
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
            Text("Import a repository")
                .font(.title3.bold())

            let suggestedName = inspection.suggested?.metadata?.name ?? ""
            if suggestedName.isEmpty {
                Text("Jarvis inspected the folder and proposes this draft.")
                    .foregroundStyle(.secondary)
            } else {
                Text("Jarvis inspected the folder and proposes “\(suggestedName)” as a draft project.")
                    .foregroundStyle(.secondary)
            }

            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                if inspection.isGitRepository {
                    row("Git repository", "yes")
                    if let remote = inspection.remoteUrl {
                        row("Remote", remote)
                    }
                    if let provider = inspection.provider {
                        row("Provider", provider)
                    }
                    if let branch = inspection.defaultBranch {
                        row("Default branch", branch)
                    }
                } else {
                    row("Git repository", "not found")
                }
                if let packageManager = inspection.packageManager {
                    row("Package manager", packageManager)
                }
            }
            .font(.callout)

            if let commands = inspection.suggested?.commands, !commands.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Proposed commands")
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(.secondary)
                    ForEach(commands.sorted { $0.key < $1.key }, id: \.key) { name, command in
                        Text("\(name): \(command)")
                            .font(.callout.monospaced())
                    }
                }
            }

            if let branchPattern = inspection.suggested?.git?.branchPattern {
                Text("Branches: \(branchPattern)")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            HStack {
                Spacer()
                Button("Cancel") { projects.cancelImport() }
                    .keyboardShortcut(.cancelAction)
                Button("Save as draft project") {
                    Task { await projects.confirmImport() }
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 480)
    }

    private func row(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            Text(value)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}
