import JarvisCore
import SwiftUI

/// The first screen of the product: is the local engine running, and if not,
/// what should the user do about it (MVP_SPEC user story 3).
struct EngineHealthView: View {
    let session: EngineSessionModel

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            header

            switch session.status {
            case .starting:
                ProgressView("Starting the local engine…")
                    .frame(maxWidth: .infinity, alignment: .center)

            case .ready(let health), .degraded(let health):
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                    row("Engine", health.engineVersion)
                    row("Local API", health.apiVersion)
                    row("Database", health.database)
                }

            case .failed(let message):
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Try again") {
                    Task { await session.start() }
                }
            }

            Spacer()
        }
        .padding(24)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Circle().fill(indicatorColor).frame(width: 10, height: 10)
            Text(headline).font(.title2.weight(.semibold))
        }
    }

    private var headline: String {
        switch session.status {
        case .starting: return "Starting"
        case .ready: return "Engine ready"
        case .degraded: return "Engine degraded"
        case .failed: return "Engine unavailable"
        }
    }

    private var indicatorColor: Color {
        switch session.status {
        case .starting: return .secondary
        case .ready: return .green
        case .degraded: return .orange
        case .failed: return .red
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            Text(value).monospaced().textSelection(.enabled)
        }
    }
}
