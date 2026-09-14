import JarvisCore
import SwiftUI

/// Native, read-only fixed composition canvas. The outline below remains the
/// equivalent keyboard and VoiceOver surface; nothing here edits an edge.
struct WorkflowCanvasView: View {
    let presentation: WorkflowCanvasPresentation
    var onSelectModule: ((String) -> Void)?
    @State private var selectedEdgeID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Composition fixe").font(.headline)
            Text("Les flèches et contrats viennent de la réponse Engine. Les liens sont informatifs.")
                .font(.callout).foregroundStyle(.secondary)
            GeometryReader { proxy in
                ZStack {
                    Canvas { context, size in
                        let points = Dictionary(uniqueKeysWithValues: presentation.nodes.map {
                            ($0.id, CGPoint(x: CGFloat($0.x) * size.width, y: CGFloat($0.y) * size.height))
                        })
                        for (index, edge) in presentation.edges.enumerated() {
                            guard let start = points[edge.from], let target = edge.to.flatMap({ points[$0] }) else { continue }
                            var path = Path()
                            let bend = CGFloat(index.isMultiple(of: 2) ? 18 : -18)
                            let middle = CGPoint(x: (start.x + target.x) / 2, y: (start.y + target.y) / 2 + bend)
                            path.move(to: start)
                            path.addQuadCurve(to: target, control: middle)
                            context.stroke(path, with: .color(.secondary), style: edge.kind == .request ? StrokeStyle(lineWidth: 2) : StrokeStyle(lineWidth: 2, dash: [6, 4]))
                            let angle = atan2(target.y - middle.y, target.x - middle.x)
                            var arrow = Path()
                            arrow.move(to: target)
                            arrow.addLine(to: CGPoint(x: target.x - 8 * cos(angle - .pi / 6), y: target.y - 8 * sin(angle - .pi / 6)))
                            arrow.move(to: target)
                            arrow.addLine(to: CGPoint(x: target.x - 8 * cos(angle + .pi / 6), y: target.y - 8 * sin(angle + .pi / 6)))
                            context.stroke(arrow, with: .color(.secondary), style: StrokeStyle(lineWidth: 2))
                        }
                    }
                    ForEach(presentation.nodes) { node in
                        Button { onSelectModule?(node.id) } label: {
                            VStack(spacing: 4) {
                                Image(systemName: node.enabled ? "shippingbox.fill" : "shippingbox")
                                Text(node.title).font(.caption.weight(.medium)).multilineTextAlignment(.center)
                                Text(node.enabled ? "Enabled" : "Disabled").font(.caption2)
                            }
                            .frame(width: 130, height: 68)
                            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(.secondary.opacity(0.4)))
                        }
                        .buttonStyle(.plain)
                        .position(x: CGFloat(node.x) * proxy.size.width, y: CGFloat(node.y) * proxy.size.height)
                        .accessibilityLabel(node.accessibilityLabel)
                        .accessibilityHint("Open module settings")
                    }
                }
            }
            .frame(minHeight: 190, maxHeight: 280)
            Text("Solid arrow: request. Dashed arrow: fact broadcast. An absent arrow target is an orphaned or ambiguous request.")
                .font(.caption).foregroundStyle(.secondary)
                .accessibilityLabel("Legend: solid arrow is a request; dashed arrow is a fact broadcast; an absent target is an orphaned or ambiguous request.")
            VStack(alignment: .leading, spacing: 6) {
                Text("Links").font(.subheadline.weight(.semibold))
                ForEach(presentation.edges) { edge in
                    Button {
                        selectedEdgeID = selectedEdgeID == edge.id ? nil : edge.id
                    } label: {
                        Label(edge.label, systemImage: edge.kind == .request ? "arrow.right" : "arrow.triangle.branch")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(edge.accessibilityLabel)
                    .accessibilityHint("Show contract compatibility and trigger information")
                    if selectedEdgeID == edge.id {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Compatibility: \(edge.compatibilityLabel)")
                            Text("Trigger: \(edge.triggerLabel)")
                        }
                        .font(.caption)
                        .padding(.leading, 24)
                    }
                }
            }
        }
        .padding(14)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
    }
}
