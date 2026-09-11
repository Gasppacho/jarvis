import JarvisCore
import SwiftUI

struct ProjectDeadLettersView: View {
    let model: ProjectDeadLettersModel
    let projectId: String

    var body: some View {
        let state = model.state(for: projectId)
        VStack(spacing: 0) {
            switch stateView(for: state) {
            case .loading:
                ProgressView("Loading Dead Letters…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .error(let message):
                ContentUnavailableView {
                    Label("Dead Letters unavailable", systemImage: "exclamationmark.triangle.fill")
                } description: {
                    Text(message)
                } actions: {
                    Button("Retry") { Task { await model.refresh(projectId: projectId) } }
                }
            case .empty:
                ContentUnavailableView {
                    Label("No Dead Letters", systemImage: "checkmark.circle")
                } description: {
                    Text("This Project has no definitive delivery failures.")
                } actions: {
                    Button("Refresh") { Task { await model.refresh(projectId: projectId) } }
                }
            case .list:
                list(state)
            }
        }
        .task(id: projectId) {
            await model.refresh(projectId: projectId)
        }
    }

    private enum StateView {
        case loading
        case error(String)
        case empty
        case list
    }

    private func stateView(for state: ProjectDeadLettersState) -> StateView {
        if state.deadLetters.isEmpty, state.isLoading { return .loading }
        if state.deadLetters.isEmpty, let errorMessage = state.errorMessage {
            return .error(errorMessage)
        }
        if state.deadLetters.isEmpty { return .empty }
        return .list
    }

    private func list(_ state: ProjectDeadLettersState) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Definitive delivery failures")
                        .font(.headline)
                    Spacer()
                    Button("Refresh") { Task { await model.refresh(projectId: projectId) } }
                        .disabled(state.isLoading)
                }
                if let errorMessage = state.errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                ForEach(state.deadLetters) { deadLetter in
                    row(deadLetter, state: state)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)
        }
    }

    private func row(_ deadLetter: DeadLetter, state: ProjectDeadLettersState) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("Consumer: \(deadLetter.moduleInstanceId)")
                    .font(.body.weight(.semibold))
                Spacer()
                Button {
                    Task {
                        await model.replay(
                            projectId: projectId, deliveryId: deadLetter.deliveryId)
                    }
                } label: {
                    Label("Replay", systemImage: "arrow.clockwise")
                }
                .disabled(state.replayingDeliveryIDs.contains(deadLetter.deliveryId))
            }
            LabeledContent("Event", value: deadLetter.eventId)
            LabeledContent("Code", value: deadLetter.code)
            LabeledContent("Attempts", value: String(deadLetter.attempts))
            LabeledContent(
                "Time",
                value: deadLetter.createdAt.formatted(date: .abbreviated, time: .shortened))
            Text(deadLetter.message ?? "No cleaned message was provided.")
                .foregroundStyle(.secondary)
            if let replayError = state.replayErrorMessages[deadLetter.deliveryId] {
                Label(replayError, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(14)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 10))
    }
}
