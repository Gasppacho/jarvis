import JarvisAPI

/// A connection descriptor returned by the Local API without its credential reference.
public struct Connection: Identifiable, Hashable, Sendable {
    public let id: String
    public let provider: String
    public let accountLabel: String
    public let status: String
    public let capabilities: [String]

    public init(
        id: String,
        provider: String,
        accountLabel: String,
        status: String,
        capabilities: [String]
    ) {
        self.id = id
        self.provider = provider
        self.accountLabel = accountLabel
        self.status = status
        self.capabilities = capabilities
    }

    init(payload: Components.Schemas.ResourceDescriptor) {
        self.init(
            id: payload.id,
            provider: payload.kind,
            accountLabel: payload.displayName,
            status: payload.status,
            capabilities: payload.capabilities)
    }
}

/// The connection operations consumed by the macOS Connections feature.
public protocol ConnectionsAPI: Sendable {
    func listConnections() async throws -> [Connection]
    func registerGitHubConnection(accountReference: String) async throws -> Connection
    func validateConnection(id: String) async throws -> Connection
}

extension EngineClient: ConnectionsAPI {}
