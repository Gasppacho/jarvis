import Observation

public enum GitHubConnectionDiscoveryState: Equatable {
    case searching
    case accounts
    case none
    case unavailable
}

public struct GitHubConnectionPresentation: Equatable {
    public let status: String
    public let diagnostic: String
    public let action: String
    public let isSelectable: Bool
}

@MainActor
@Observable
public final class ConnectionsModel {
    public private(set) var connections: [Connection] = []
    public private(set) var isRefreshing = false
    public private(set) var isRegistering = false
    public private(set) var validatingConnectionIDs: Set<String> = []
    public private(set) var errorMessage: String?

    public static let emptyDiscoveryMessage = "Aucun compte GitHub authentifié n'a été découvert. Jarvis utilise l'authentification locale `gh`; exécutez `gh auth login`, puis revenez ici et cliquez sur `Réessayer`."

    private let session: EngineSessionModel?
    private let injectedAPI: (any ConnectionsAPI)?
    private var refreshGeneration = 0
    private var discoveryFailed = false

    public init(session: EngineSessionModel) {
        self.session = session
        injectedAPI = nil
    }

    init(api: any ConnectionsAPI) {
        session = nil
        injectedAPI = api
    }

    private var api: (any ConnectionsAPI)? {
        if let injectedAPI { return injectedAPI }
        return session?.client
    }

    public func refresh() async {
        guard let api else {
            errorMessage = Self.engineUnavailable
            discoveryFailed = true
            return
        }
        refreshGeneration += 1
        let generation = refreshGeneration
        isRefreshing = true
        defer {
            if generation == refreshGeneration { isRefreshing = false }
        }
        do {
            let discovered = try await api.discoverGitHubConnections().sorted { $0.id < $1.id }
            guard generation == refreshGeneration else { return }
            connections = discovered
            errorMessage = nil
            discoveryFailed = false
        } catch {
            guard generation == refreshGeneration else { return }
            errorMessage = Self.describe(error)
            discoveryFailed = true
        }
    }

    public var discoveryState: GitHubConnectionDiscoveryState {
        if isRefreshing { return .searching }
        if discoveryFailed { return .unavailable }
        return connections.isEmpty ? .none : .accounts
    }

    public func presentation(for connection: Connection) -> GitHubConnectionPresentation {
        guard connection.provider == "github" else {
            return GitHubConnectionPresentation(
                status: "Compte incompatible",
                diagnostic: "Ce compte ne fournit pas GitHub.",
                action: "Choisir un compte compatible",
                isSelectable: false)
        }
        if connection.status == "unauthenticated" || connection.status == "revoked" {
            return GitHubConnectionPresentation(
                status: "Accès requis",
                diagnostic: "GitHub est installé mais Jarvis ne peut pas lire ce compte. Reconnectez ou autorisez gh pour collecter les issues.",
                action: "Reconnecter ou autoriser gh",
                isSelectable: false)
        }
        guard connection.status == "available",
            Set(connection.capabilities).isSuperset(of: Self.requiredGitHubCapabilities)
        else {
            let missing = Self.requiredGitHubCapabilities.subtracting(connection.capabilities).sorted()
            return GitHubConnectionPresentation(
                status: "Compte incompatible",
                diagnostic: "Capability manquante : \(missing.joined(separator: ", ")).",
                action: "Choisir un compte compatible",
                isSelectable: false)
        }
        return GitHubConnectionPresentation(
            status: "Disponible",
            diagnostic: "Prêt à être accordé explicitement à ce projet.",
            action: "Utiliser pour ce projet",
            isSelectable: true)
    }

    @discardableResult
    public func register(accountReference: String) async -> Bool {
        let reference = accountReference.trimmingCharacters(in: .whitespacesAndNewlines)
        guard reference.hasPrefix("gh://"), reference.dropFirst("gh://".count).isEmpty == false else {
            errorMessage = "Enter an opaque GitHub account reference such as gh://Account."
            return false
        }
        guard let api else {
            errorMessage = Self.engineUnavailable
            return false
        }

        isRegistering = true
        defer { isRegistering = false }
        do {
            upsert(try await api.registerGitHubConnection(accountReference: reference))
            errorMessage = nil
            return true
        } catch {
            errorMessage = Self.describe(error)
            return false
        }
    }

    public func validate(connectionID: String) async {
        guard let api else {
            errorMessage = Self.engineUnavailable
            return
        }
        guard !validatingConnectionIDs.contains(connectionID) else { return }

        validatingConnectionIDs.insert(connectionID)
        defer { validatingConnectionIDs.remove(connectionID) }
        do {
            upsert(try await api.validateConnection(id: connectionID))
            errorMessage = nil
        } catch {
            errorMessage = Self.describe(error)
        }
    }

    public func isValidating(connectionID: String) -> Bool {
        validatingConnectionIDs.contains(connectionID)
    }

    private func upsert(_ connection: Connection) {
        connections.removeAll { $0.id == connection.id }
        connections.append(connection)
        connections.sort { $0.id < $1.id }
    }

    public static func describe(_ error: Error) -> String {
        guard let error = error as? EngineClientError else {
            return error.localizedDescription
        }
        switch error {
        case .unauthorized(let operation):
            return "The engine rejected the session token (\(operation)). Restart Jarvis."
        case .hostNotAllowed(let operation):
            return "The engine refused a non-loopback request (\(operation)). Restart Jarvis."
        case .engineError(_, let code, let message):
            return "\(message) (\(code))"
        case .unexpectedResponse(let message):
            return message
        }
    }

    private static let engineUnavailable = "The engine is not running. Restart Jarvis."
    private static let requiredGitHubCapabilities: Set<String> = [
        "github.api", "scm.change-request.manage", "work-items.read",
    ]
}
