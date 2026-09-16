import AppKit
import JarvisCore
import SwiftUI
import UniformTypeIdentifiers

struct ProjectMigrationView: View {
    let model: ProjectConfigurationModel
    let project: Project
    let packages: [ModulePackage]
    var onOpenSupervision: (() -> Void)? = nil

    @State private var writeToRepository = true
    @State private var showingConversionConfirmation = false
    @State private var showingReconfigurationConfirmation = false

    private var state: ProjectConfigurationState { model.state(for: project.id) }
    private var isFixed: Bool {
        state.draft?.isFixedComposition == true
            || state.detail?.portableConfiguration?.compositionMode == .fixed_hyphen_modules
    }
    private var hasSavedComposition: Bool {
        guard let configuration = state.detail?.portableConfiguration else { return false }
        return !configuration.modules.isEmpty || !configuration.slots.additionalProperties.isEmpty
    }
    private var canReconfigure: Bool {
        guard let preview = state.migration.preview,
            (state.detail?.project.status ?? project.status) == .paused
        else { return false }
        return !preview.requiresPauseBeforeMigration
    }

    var body: some View {
        Group {
            if hasSavedComposition && !isFixed {
                content
            }
        }
        .confirmationDialog(
            "Convertir cette configuration ?",
            isPresented: $showingConversionConfirmation
        ) {
            Button("Convertir", role: .destructive) {
                Task {
                    await model.applyMigration(
                        projectId: project.id,
                        writeToRepository: writeToRepository,
                        packages: packages)
                }
            }
            Button("Annuler", role: .cancel) {}
        } message: {
            Text("Jarvis remplacera la composition historique par GitHub et Development, conservera les accès et l’historique, créera le backup et restera en pause. Aucun travail ne démarrera.")
        }
        .confirmationDialog(
            "Reconstruire avec les modules fixes ?",
            isPresented: $showingReconfigurationConfirmation
        ) {
            Button("Préparer le brouillon", role: .destructive) {
                model.prepareFixedReconfiguration(projectId: project.id)
            }
            Button("Annuler", role: .cancel) {}
        } message: {
            Text("Le brouillon remplacera les règles et les éléments incompatibles. Le nom, les commandes, les accès et l’historique restent conservés ; préparation, validations, agent et portée devront être confirmés. Rien ne sera sauvegardé ni démarré automatiquement.")
        }
    }

    @ViewBuilder
    private var content: some View {
        switch state.migration {
        case .unchecked:
            EmptyView()
        case .loading:
            GroupBox("Migration") { ProgressView("Analyse de la configuration historique…") }
        case .failed(let message):
            GroupBox("Migration") {
                Label(message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Button("Réessayer l’analyse") {
                    Task { await model.refresh(projectId: project.id, packages: packages) }
                }
                .accessibilityIdentifier("project.migration.retry")
            }
        case .applied(let result):
            GroupBox("Configuration convertie") {
                Label("Conversion terminée ; le projet reste en pause.", systemImage: "checkmark.circle")
                if result.hasBackup { Text("Le backup original est conservé et exportable par l’Engine.") }
                if let historyId = result.historyId { Text("Historique : \(historyId)").textSelection(.enabled) }
            }
        case .current(let preview):
            if preview.canApply { guidedPreview(preview) }
            else { requiredPreview(preview) }
        }
    }

    private func guidedPreview(_ preview: ProjectMigrationPreview) -> some View {
        GroupBox("Migration guidée disponible") {
            VStack(alignment: .leading, spacing: 10) {
                Label("Conversion explicite requise", systemImage: "arrow.triangle.2.circlepath")
                    .font(.headline)
                Text("Aperçu : \(preview.destinationSummary).")
                Text("Les éléments conservés et le backup seront traités atomiquement par l’Engine.")
                    .font(.callout).foregroundStyle(.secondary)
                Toggle("Écrire aussi la nouvelle configuration dans le dépôt", isOn: $writeToRepository)
                    .accessibilityIdentifier("project.migration.write-repository")
                HStack {
                    Button("Convertir") { showingConversionConfirmation = true }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("project.migration.convert")
                    exportButton
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func requiredPreview(_ preview: ProjectMigrationPreview) -> some View {
        GroupBox("Migration requise") {
            VStack(alignment: .leading, spacing: 10) {
                Label("Cette composition ne peut pas être convertie automatiquement.", systemImage: "exclamationmark.triangle")
                    .font(.headline).foregroundStyle(.orange)
                ForEach(preview.reasons, id: \.code) { reason in
                    Label(reason.message, systemImage: "minus.circle")
                        .accessibilityLabel("\(reason.code) : \(reason.message)")
                }
                Text("Aperçu de reconstruction : \(preview.destinationSummary). Les règles, instances et valeurs incompatibles indiquées ci-dessus seront abandonnées ; les choix restants seront à confirmer dans le brouillon D04.")
                    .font(.callout)
                if preview.reasons.contains(where: { $0.code == "work-pending" }) {
                    Label(
                        "Des travaux actifs bloquent encore la migration. Après la pause, terminez-les ou annulez-les depuis la supervision, puis relancez l’analyse.",
                        systemImage: "pause.circle")
                        .font(.callout).foregroundStyle(.orange)
                } else if preview.reasons.contains(where: { $0.code == "project-active" }) {
                    Label(
                        "Le projet est actif. Mettez-le en pause avant de continuer.",
                        systemImage: "pause.circle")
                        .font(.callout).foregroundStyle(.orange)
                }
                HStack {
                    if preview.requiresPauseBeforeMigration && (state.detail?.project.status ?? project.status) != .paused {
                        Button("Mettre le projet en pause") {
                            Task {
                                await model.pauseForMigration(projectId: project.id, packages: packages)
                            }
                        }
                        .accessibilityIdentifier("project.migration.pause")
                    }
                    if let onOpenSupervision {
                        Button("Ouvrir la supervision") { onOpenSupervision() }
                            .accessibilityIdentifier("project.migration.open-supervision")
                    }
                    Button("Reconfigurer avec les modules fixes") {
                        showingReconfigurationConfirmation = true
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canReconfigure)
                    .accessibilityIdentifier("project.migration.reconfigure")
                    exportButton
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var exportButton: some View {
        Button("Exporter la configuration originale") { exportOriginalConfiguration() }
            .accessibilityIdentifier("project.migration.export-original")
    }

    private func exportOriginalConfiguration() {
        guard let data = state.detail?.portableConfigJSON else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "\(project.name)-configuration.json"
        panel.allowedContentTypes = [.json]
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            try? data.write(to: url, options: .atomic)
        }
    }
}
