import JarvisCore
import SwiftUI

/// The walking skeleton's whole user-visible surface: is the engine up, and if
/// not, what does the user do about it.
struct EngineHealthView: View {
    // The model, not a snapshot of its state: passing `state` would move the
    // only tracked read out of this view's body and into whatever built it.
    let session: EngineSessionModel

    var body: some View {
        switch session.state {
        case .starting:
            VStack(spacing: 12) {
                ProgressView()
                Text("Starting the engine…").foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .ready(let health):
            VStack(alignment: .leading, spacing: 16) {
                Label("Engine ready", systemImage: "checkmark.circle.fill")
                    .font(.title2)
                    .foregroundStyle(.green)
                Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 8) {
                    row("Engine version", health.engineVersion)
                    row("API version", health.apiVersion)
                    row("Database", health.database.rawValue)
                }
                .font(.callout.monospaced())
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(24)

        case .failed(let error):
            VStack(alignment: .leading, spacing: 12) {
                Label(error.headline, systemImage: "exclamationmark.triangle.fill")
                    .font(.title2)
                    .foregroundStyle(.orange)
                Text(error.cause).font(.callout)
                Text(error.impact).foregroundStyle(.secondary)
                Text(error.nextAction).font(.callout.bold())
                if let detail = error.detail {
                    DisclosureGroup("Details") {
                        ScrollView {
                            Text(detail)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(maxHeight: 160)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(24)
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            Text(value)
        }
    }
}
