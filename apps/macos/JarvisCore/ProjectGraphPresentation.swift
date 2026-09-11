import Foundation

/// Pure view data for the emergent graph. It exposes only the model state and
/// the Engine-provided graph findings; it does not infer routing or validity.
public struct ProjectGraphPresentation: Sendable, Equatable {
    public enum Status: Sendable, Equatable {
        case loading
        case loaded
        case neverActivated
        case error(String)
    }

    public let status: Status
    public let valid: Bool?
    public let outline: ProjectCompositionOutline?
    public let issues: [ProjectGraph.Issue]

    public init(state: ProjectGraphLoadState) {
        switch state {
        case .loading:
            status = .loading
            valid = nil
            outline = nil
            issues = []
        case .loaded(let graph):
            status = .loaded
            valid = graph.valid
            outline = ProjectCompositionOutline(graph: graph)
            issues = graph.issues
        case .neverActivated:
            status = .neverActivated
            valid = nil
            outline = nil
            issues = []
        case .error(let message):
            status = .error(message)
            valid = nil
            outline = nil
            issues = []
        }
    }
}
