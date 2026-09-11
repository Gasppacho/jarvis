import JarvisCore
import SwiftUI

/// Read-only view of the Engine's emergent Project graph. Routing labels,
/// symbols and findings come from `ProjectGraphPresentation`; this view only
/// lays them out and exposes the response status to assistive technology.
struct ProjectGraphView: View {
    let model: ProjectGraphModel
    let projectId: String

    @State private var selectedRowID: String?

    var body: some View {
        let presentation = model.state(for: projectId).map(ProjectGraphPresentation.init)
        Group {
            switch presentation?.status ?? .loading {
            case .loading:
                ProgressView("Loading Graph…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .neverActivated:
                ContentUnavailableView {
                    Label("Graph not available yet", systemImage: "point.3.connected.trianglepath.dotted")
                } description: {
                    Text("Activate this Project to populate its emergent graph.")
                } actions: {
                    Button("Refresh") { Task { await model.refresh(projectId: projectId) } }
                }
            case .error(let message):
                ContentUnavailableView {
                    Label("Graph unavailable", systemImage: "exclamationmark.triangle.fill")
                } description: {
                    Text(message)
                } actions: {
                    Button("Retry") { Task { await model.refresh(projectId: projectId) } }
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
    }

    private func graph(_ presentation: ProjectGraphPresentation) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text("Emergent Graph")
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    if let valid = presentation.valid {
                        Label(
                            valid ? "Valid" : "Invalid",
                            systemImage: valid ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                        .accessibilityLabel(valid ? "Graph status: valid" : "Graph status: invalid")
                    }
                    Button("Refresh") { Task { await model.refresh(projectId: projectId) } }
                }

                if let outline = presentation.outline {
                    graphRows(outline.rows)
                }

                if !presentation.issues.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Issues")
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(.secondary)
                        ForEach(presentation.issues) { issue in
                            issueRow(issue)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)
        }
    }

    private func graphRows(_ rows: [ProjectCompositionOutline.Row]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Module Instances and Edges")
                .font(.callout.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(rows, id: \.id) { row in
                graphRow(row)
            }
        }
    }

    private func issueRow(_ issue: ProjectGraph.Issue) -> some View {
        let label = "Issue " + issue.code + ". Value: " + issue.message
            + ". Status: " + issue.severity + "."
        return VStack(alignment: .leading, spacing: 4) {
            Text(issue.code).font(.body.monospaced())
            Text(issue.message).font(.callout)
            Label(issue.severity.capitalized, systemImage: "exclamationmark.circle")
                .font(.caption)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }

    private func graphRow(_ row: ProjectCompositionOutline.Row) -> some View {
        let isSelected = selectedRowID == row.id
        let label = row.accessibilityLabel + ". Value: " + row.title + ". Status: "
            + row.statusLabel + (isSelected ? ". Selected." : ".")
        return Button {
            selectedRowID = isSelected ? nil : row.id
        } label: {
            HStack(alignment: .top, spacing: 8) {
                if row.depth > 0 {
                    Spacer().frame(width: 20)
                }
                graphRowContent(row)
                Spacer()
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
            .background(
                isSelected ? Color.accentColor.opacity(0.15) : Color.clear,
                in: RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
        .accessibilityHint("Selects this graph row.")
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }

    private func graphRowContent(_ row: ProjectCompositionOutline.Row) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(row.title)
                .font(row.depth == 0 ? .headline : .body)
            Label(row.statusLabel, systemImage: row.statusSymbol)
                .font(.caption)
            if !row.findings.isEmpty {
                Text("Findings: " + row.findings.joined(separator: ", "))
                    .font(.caption2)
            }
        }
    }
}
