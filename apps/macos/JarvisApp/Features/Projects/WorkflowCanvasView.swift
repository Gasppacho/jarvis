import AppKit
import JarvisCore
import SwiftUI

/// Native, read-only fixed composition canvas. The outline below remains the
/// equivalent keyboard and VoiceOver surface; nothing here edits an edge.
struct WorkflowCanvasView: View {
    let presentation: WorkflowCanvasPresentation
    var onSelectModule: ((String) -> Void)?

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 12) {
                Text("Les modules échangent automatiquement ces événements.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                GeometryReader { proxy in
                    ZStack {
                        Canvas { context, size in
                            let points = Dictionary(uniqueKeysWithValues: presentation.nodes.map {
                                ($0.id, CGPoint(x: CGFloat($0.x) * size.width, y: CGFloat($0.y) * size.height))
                            })
                            for edge in presentation.connections {
                                guard let source = points[edge.from],
                                    let destination = edge.to.flatMap({ points[$0] })
                                else { continue }
                                let direction: CGFloat = destination.x >= source.x ? 1 : -1
                                let start = CGPoint(x: source.x + direction * 66, y: source.y)
                                let target = CGPoint(
                                    x: destination.x - direction * 66, y: destination.y)
                                var path = Path()
                                let bend = -direction * 48
                                let middle = CGPoint(
                                    x: (start.x + target.x) / 2,
                                    y: (start.y + target.y) / 2 + bend)
                                path.move(to: start)
                                path.addQuadCurve(to: target, control: middle)
                                let lineStyle = edge.kind == .request
                                    ? StrokeStyle(lineWidth: 2)
                                    : StrokeStyle(lineWidth: 2, dash: [6, 4])
                                context.stroke(path, with: .color(.secondary), style: lineStyle)
                                let angle = atan2(target.y - middle.y, target.x - middle.x)
                                var arrow = Path()
                                arrow.move(to: target)
                                arrow.addLine(to: CGPoint(
                                    x: target.x - 8 * cos(angle - .pi / 6),
                                    y: target.y - 8 * sin(angle - .pi / 6)))
                                arrow.move(to: target)
                                arrow.addLine(to: CGPoint(
                                    x: target.x - 8 * cos(angle + .pi / 6),
                                    y: target.y - 8 * sin(angle + .pi / 6)))
                                context.stroke(
                                    arrow, with: .color(.secondary), style: StrokeStyle(lineWidth: 2))
                            }
                        }
                        ForEach(presentation.nodes) { node in
                            VStack(spacing: 4) {
                                Image(systemName: node.enabled ? "shippingbox.fill" : "shippingbox")
                                Text(node.title)
                                    .font(.caption.weight(.medium))
                                    .multilineTextAlignment(.center)
                                Text(node.enabled ? "Activé" : "Désactivé")
                                    .font(.caption2)
                            }
                            .frame(width: 130, height: 68)
                            .background(
                                Color(nsColor: .controlBackgroundColor),
                                in: RoundedRectangle(cornerRadius: 10))
                            .overlay(
                                RoundedRectangle(cornerRadius: 10)
                                    .stroke(Color(nsColor: .separatorColor)))
                            .position(
                                x: CGFloat(node.x) * proxy.size.width,
                                y: CGFloat(node.y) * proxy.size.height)
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(node.accessibilityLabel)
                        }
                    }
                }
                .frame(minHeight: 190, maxHeight: 280)
                Text("Trait plein : demande. Pointillés : fait observé. Le sens de la flèche indique le destinataire.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Échanges — liste équivalente")
                        .font(.subheadline.weight(.semibold))
                    ForEach(presentation.connections) { edge in
                        Label(
                            edge.label,
                            systemImage: edge.kind == .request ? "arrow.right" : "arrow.triangle.branch")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityLabel(edge.accessibilityLabel)
                    }
                    ForEach(presentation.unconnectedOutputs) { edge in
                        HStack {
                            Label(edge.label, systemImage: "circle.dotted")
                            Spacer()
                            Text("Non connecté")
                                .foregroundStyle(.secondary)
                        }
                        .accessibilityLabel(edge.accessibilityLabel)
                    }
                }
            }
        } label: {
            Label("Canvas du workflow", systemImage: "arrow.triangle.branch")
        }
    }
}
