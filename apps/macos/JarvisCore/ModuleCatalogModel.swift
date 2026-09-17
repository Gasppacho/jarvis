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
    /// Served, versioned human meaning for capability ids (ticket 48). Empty
    /// until loaded; a capability id absent here is unavailable, not guessed.
    public private(set) var capabilityGuidance: [CapabilityGuidance] = []
    public private(set) var state: State = .idle

    private let session: EngineSessionModel

    public init(session: EngineSessionModel) {
        self.session = session
    }

    public func refresh() async {
        guard let client = session.client else {
            packages = []
            capabilityGuidance = []
            state = .failed("Le moteur Jarvis n’est pas disponible. Relancez Jarvis.")
            return
        }
        state = .loading
        do {
            packages = try await client.listModuleCatalog()
            capabilityGuidance = try await client.getCapabilityCatalog()
            state = .loaded
        } catch {
            packages = []
            capabilityGuidance = []
            state = .failed(Self.describe(error))
        }
    }

    private static func describe(_ error: Error) -> String {
        guard let error = error as? EngineClientError else {
            return "Le catalogue n’a pas pu être chargé. Réessayez ; si le problème persiste, relancez Jarvis."
        }
        return switch error {
        case .unauthorized(let operation):
            "La session avec le moteur a expiré (\(operation)). Relancez Jarvis."
        case .hostNotAllowed(let operation):
            "Le moteur a refusé la connexion locale (\(operation)). Relancez Jarvis."
        case .engineError(_, let code, let message):
            "Le moteur a refusé le catalogue : \(message) (\(code)). Réessayez ; si le problème persiste, relancez Jarvis."
        case .unexpectedResponse(let message):
            "Réponse inattendue du moteur : \(message). Réessayez ; si le problème persiste, relancez Jarvis."
        }
    }
}
