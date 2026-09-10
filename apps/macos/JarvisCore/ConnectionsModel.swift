import Observation

@MainActor
@Observable
public final class ConnectionsModel {
    public private(set) var connections: [Connection] = []
    public private(set) var isRefreshing = false
    public private(set) var isRegistering = false
    public private(set) var validatingConnectionIDs: Set<String> = []
    public private(set) var errorMessage: String?

    private let session: EngineSessionModel?
    private let injectedAPI: (any ConnectionsAPI)?

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
            return
        }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            connections = try await api.listConnections().sorted { $0.id < $1.id }
            errorMessage = nil
        } catch {
            errorMessage = Self.describe(error)
        }
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
}
