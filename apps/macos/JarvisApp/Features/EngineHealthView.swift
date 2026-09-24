import JarvisCore
import SwiftUI

/// The walking skeleton's whole user-visible surface: is the engine up, and if
/// not, what does the user do about it.
struct EngineHealthView: View {
    // The model, not a snapshot of its state: passing `state` would move the
    // only tracked read out of this view's body and into whatever built it.
    let session: EngineSessionModel

    @State private var isRetrying = false

    var body: some View {
        Group {
            switch session.state {
            case .starting:
                ProgressView("Démarrage du moteur…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

            case .ready(let health):
                VStack(alignment: .leading, spacing: 18) {
                    Label("Moteur prêt", systemImage: "checkmark.circle.fill")
                        .font(.largeTitle.weight(.semibold))
                        .foregroundStyle(.green)
                    Text("Les services locaux de Jarvis sont disponibles.")
                        .foregroundStyle(.secondary)
                    GroupBox("État du moteur") {
                        DisclosureGroup("Détails techniques") {
                            Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 8) {
                                row("Version du moteur", health.engineVersion)
                                row("Version de l’API", health.apiVersion)
                                row("Base de données", health.database.rawValue)
                            }
                            .font(.callout.monospaced())
                            .padding(.top, 8)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .frame(maxWidth: 760, maxHeight: .infinity, alignment: .topLeading)
                .frame(maxWidth: .infinity, alignment: .top)
                .padding(28)

            case .failed(let error):
                failure(error)
            }
        }
        .navigationTitle("État du moteur")
    }

    private func failure(_ error: EngineStartError) -> some View {
        ContentUnavailableView {
            Label("Le moteur local est indisponible", systemImage: "exclamationmark.triangle.fill")
        } description: {
            VStack(alignment: .leading, spacing: 12) {
                Text(error.headline)
                    .font(.headline)
                LabeledContent("Cause", value: error.cause)
                LabeledContent("Conséquence", value: error.impact)
                VStack(alignment: .leading, spacing: 4) {
                    Label("Prochaine étape", systemImage: "arrow.turn.down.right")
                        .font(.callout.weight(.semibold))
                    Text(error.nextAction)
                }
                if let detail = error.detail {
                    DisclosureGroup("Détails techniques") {
                        ScrollView {
                            Text(detail)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(maxHeight: 160)
                        .padding(.top, 8)
                    }
                }
            }
            .frame(maxWidth: 620, alignment: .leading)
            .multilineTextAlignment(.leading)
        } actions: {
            Button(action: retry) {
                if isRetrying {
                    Label("Tentative de démarrage…", systemImage: "hourglass")
                } else {
                    Label("Réessayer le démarrage", systemImage: "arrow.clockwise")
                }
            }
            .disabled(isRetrying)
            .accessibilityIdentifier("engine.retry")
        }
    }

    private func retry() {
        guard !isRetrying else { return }
        isRetrying = true
        Task {
            await session.start()
            isRetrying = false
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            Text(value)
        }
    }
}
