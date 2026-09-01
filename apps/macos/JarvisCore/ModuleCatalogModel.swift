import Observation

/// Presentation state for the global catalogue of validated bundled Module
/// Packages. Project-scoped Module Instances and activation are deliberately
/// outside this model.
@MainActor
@Observable
public final class ModuleCatalogModel {
    public enum State: Equatable, Sendable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    public private(set) var packages: [ModulePackage] = []
    public private(set) var state: State = .idle

    private let session: EngineSessionModel

    public init(session: EngineSessionModel) {
        self.session = session
    }

    public func refresh() async {
        guard let client = session.client else {
            state = .failed("The engine is not running. Restart Jarvis.")
            return
        }
        state = .loading
        do {
            packages = try await client.listModuleCatalog()
            state = .loaded
        } catch {
            state = .failed(Self.describe(error))
        }
    }

    private static func describe(_ error: Error) -> String {
        guard let error = error as? EngineClientError else {
            return "The Module Package catalogue could not be loaded. No packages were changed. Try again; if it repeats, restart Jarvis."
        }
        return switch error {
        case .unauthorized(let operation):
            "The engine rejected the session token (\(operation)). The catalogue cannot be loaded. Restart Jarvis."
        case .hostNotAllowed(let operation):
            "The engine refused a non-loopback request (\(operation)). The catalogue cannot be loaded. Restart Jarvis."
        case .engineError(_, let code, let message):
            "\(message) (\(code)) The catalogue cannot be loaded. Restart Jarvis; if it repeats, inspect the engine log."
        case .unexpectedResponse(let message):
            "\(message). The catalogue cannot be loaded. Try again; if it repeats, restart Jarvis."
        }
    }
}
