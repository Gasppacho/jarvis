import JarvisCore
import SwiftUI

/// Read-only view of the Engine's emergent Project graph. Routing labels,
/// symbols and findings come from `ProjectGraphPresentation`; this view only
/// lays them out and exposes the response status to assistive technology.
struct ProjectGraphView: View {
    let model: ProjectGraphModel
    let projectId: String

    var body: some View {
        let presentation = model.state(for: projectId).map(ProjectGraphPresentation.init)
        Group {
            switch presentation?.status ?? .loading {
            case .loading:
                ProgressView("Chargement du graphe…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .neverActivated:
                ContentUnavailableView {
                    Label("Graphe pas encore disponible", systemImage: "point.3.connected.trianglepath.dotted")
                } description: {
                    Text("Activez ce projet pour afficher les modules et événements réellement chargés.")
                } actions: {
                    Button("Actualiser") { Task { await model.refresh(projectId: projectId) } }
                }
            case .error(let message):
                ContentUnavailableView {
                    Label("Graphe indisponible", systemImage: "exclamationmark.triangle.fill")
                } description: {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Jarvis n’a pas pu charger le graphe de ce projet.")
                        DisclosureGroup("Détails de l’erreur") {
                            Text(message)
                                .textSelection(.enabled)
                                .padding(.top, 6)
                        }
                    }
                } actions: {
                    Button("Réessayer") { Task { await model.refresh(projectId: projectId) } }
                }
            case .loaded:
                if let presentation {
                    graph(presentation)
                }
            }
        }
        .task(id: projectId) {
            await model.refresh(projectId: projectId)
        }
        .navigationTitle("Graphe du projet")
    }

    private func graph(_ presentation: ProjectGraphPresentation) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Graphe actif")
                            .font(.largeTitle.weight(.semibold))
                        Text("Projection en lecture seule des modules et de leurs événements.")
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if let valid = presentation.valid {
                        Label(
                            valid ? "Valide" : "À vérifier",
                            systemImage: valid ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                        .foregroundStyle(valid ? Color.green : Color.orange)
                        .accessibilityLabel(valid ? "État du graphe : valide" : "État du graphe : à vérifier")
                    }
                    Button {
                        Task { await model.refresh(projectId: projectId) }
                    } label: {
                        Label("Actualiser", systemImage: "arrow.clockwise")
                    }
                    .accessibilityIdentifier("project-graph.refresh")
                }

                if let outline = presentation.outline {
                    if outline.rows.isEmpty {
                        ContentUnavailableView {
                            Label("Aucun module actif", systemImage: "square.stack.3d.up")
                        } description: {
                            Text("Le graphe se remplira lorsque ce projet aura des modules actifs.")
                        }
                    } else {
                        graphRows(outline.rows)
                    }
                }

                if !presentation.issues.isEmpty {
                    GroupBox("Points à examiner") {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(presentation.issues) { issue in
                                issueRow(issue)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .frame(maxWidth: 960, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .top)
            .padding(28)
        }
    }

    private func graphRows(_ rows: [ProjectCompositionOutline.Row]) -> some View {
        GroupBox("Modules et événements") {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(rows) { row in
                    graphRow(row)
                    if row.id != rows.last?.id {
                        Divider().padding(.leading, row.depth > 0 ? 30 : 0)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func issueRow(_ issue: ProjectGraph.Issue) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                Text(issue.message)
                    .frame(maxWidth: .infinity, alignment: .leading)
                DisclosureGroup("Détails techniques") {
                    Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                        LabeledContent("Code", value: issue.code)
                        LabeledContent("Sévérité", value: issue.severity)
                    }
                    .font(.caption.monospaced())
                    .padding(.top, 8)
                }
            }
        } label: {
            Label(localizedSeverity(issue.severity), systemImage: "exclamationmark.circle")
                .font(.callout.weight(.semibold))
        }
        .accessibilityElement(children: .contain)
    }

    private func graphRow(_ row: ProjectCompositionOutline.Row) -> some View {
        HStack(alignment: .top, spacing: 10) {
            if row.depth > 0 {
                Image(systemName: "arrow.turn.down.right")
                    .foregroundStyle(.tertiary)
                    .padding(.leading, 16)
                    .accessibilityHidden(true)
            }
            Image(systemName: rowSymbol(for: row.role))
                .foregroundStyle(.secondary)
                .frame(width: 18)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(displayTitle(for: row))
                    .font(row.depth == 0 ? .headline : .body)
                Label(localizedStatus(row), systemImage: row.statusSymbol)
                    .font(.caption)
                    .accessibilityLabel("État : \(localizedStatus(row))")
                DisclosureGroup("Détails techniques") {
                    VStack(alignment: .leading, spacing: 6) {
                        LabeledContent("Instance", value: row.instanceId)
                        if row.role != .moduleInstance {
                            Text(row.title)
                                .textSelection(.enabled)
                        }
                        Text("État du moteur : \(row.statusLabel)")
                            .textSelection(.enabled)
                        if !row.findings.isEmpty {
                            Text("Codes : \(row.findings.joined(separator: ", "))")
                                .textSelection(.enabled)
                        }
                    }
                    .font(.caption.monospaced())
                    .padding(.top, 8)
                }
                .font(.callout)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 10)
        .accessibilityElement(children: .contain)
    }

    private func displayTitle(for row: ProjectCompositionOutline.Row) -> String {
        switch row.role {
        case .moduleInstance:
            row.title
        case .contract:
            row.direction == .produced ? "Événement produit" : "Événement consommé"
        case .capability:
            "Accès requis"
        }
    }

    private func localizedStatus(_ row: ProjectCompositionOutline.Row) -> String {
        switch row.role {
        case .moduleInstance:
            return switch row.statusLabel.lowercased() {
            case "enabled": "Actif"
            case "disabled": "Désactivé"
            default: row.statusLabel
            }
        case .contract:
            if row.statusLabel.hasPrefix("Resolved → ") {
                return "Routé vers " + String(row.statusLabel.dropFirst("Resolved → ".count))
            }
            if row.statusLabel.hasPrefix("Broadcast → ") {
                return "Diffusé vers " + String(row.statusLabel.dropFirst("Broadcast → ".count))
            }
            if row.statusLabel.hasPrefix("Ambiguous — ") {
                return "Plusieurs destinataires : "
                    + String(row.statusLabel.dropFirst("Ambiguous — ".count))
            }
            return switch row.statusLabel {
            case "Broadcast — no consumer": "Diffusé sans destinataire"
            case "Orphaned — no consumer": "Aucun destinataire"
            default: row.statusLabel
            }
        case .capability:
            return switch row.statusLabel.lowercased() {
            case "bound": "Accès configuré"
            case "unbound": "Accès manquant"
            case "unresolved": "Accès introuvable"
            default: row.statusLabel
            }
        }
    }

    private func rowSymbol(for role: ProjectCompositionOutline.Row.Role) -> String {
        switch role {
        case .moduleInstance: "square.stack.3d.up"
        case .contract: "arrow.triangle.branch"
        case .capability: "key.horizontal"
        }
    }

    private func localizedSeverity(_ severity: String) -> String {
        switch severity.lowercased() {
        case "error", "critical": "Erreur"
        case "warning": "Avertissement"
        case "info", "informational": "Information"
        default: severity
        }
    }
}
