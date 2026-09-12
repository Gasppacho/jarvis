import XCTest

@testable import JarvisCore

final class ConnectionsModelTests: XCTestCase {
    @MainActor
    func testRefreshListsProviderAccountLabelAndStatus() async {
        let connection = Connection(
            id: "connection/github-main",
            provider: "github",
            accountLabel: "Gasppacho",
            status: "available",
            capabilities: ["github.api"])
        let model = ConnectionsModel(api: StubConnectionsAPI(connections: [connection]))

        await model.refresh()

        XCTAssertEqual(model.connections, [connection])
        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(model.discoveryState, .accounts)
    }

    @MainActor
    func testEmptyDiscoveryExplainsHowToAuthenticateLocally() async {
        let model = ConnectionsModel(api: StubConnectionsAPI())

        await model.refresh()

        XCTAssertEqual(model.discoveryState, .none)
        XCTAssertEqual(
            ConnectionsModel.emptyDiscoveryMessage,
            "Aucun compte GitHub authentifié n'a été découvert. Jarvis utilise l'authentification locale `gh`; exécutez `gh auth login`, puis revenez ici et cliquez sur `Réessayer`.")
    }

    @MainActor
    func testDiscoveryFailureIsNotPresentedAsNoAccount() async {
        let model = ConnectionsModel(
            api: StubConnectionsAPI(
                listError: .engineError(
                    operation: "POST /v1/connections/discover",
                    code: "connection.discovery-unavailable",
                    message: "GitHub account discovery is unavailable.")))

        await model.refresh()

        XCTAssertEqual(model.discoveryState, .unavailable)
        XCTAssertEqual(
            model.errorMessage,
            "GitHub account discovery is unavailable. (connection.discovery-unavailable)")
    }

    @MainActor
    func testDiscoveredAccessAndCompatibilityHaveActionablePresentation() async {
        let accessRequired = Connection(
            id: "connection/github-locked",
            provider: "github",
            accountLabel: "Locked",
            status: "unauthenticated",
            capabilities: [])
        let incompatible = Connection(
            id: "connection/github-limited",
            provider: "github",
            accountLabel: "Limited",
            status: "available",
            capabilities: ["github.api"])
        let model = ConnectionsModel(
            api: StubConnectionsAPI(connections: [accessRequired, incompatible]))

        await model.refresh()

        XCTAssertEqual(model.presentation(for: accessRequired).status, "Accès requis")
        XCTAssertEqual(
            model.presentation(for: accessRequired).diagnostic,
            "GitHub est installé mais Jarvis ne peut pas lire ce compte. Reconnectez ou autorisez gh pour collecter les issues.")
        XCTAssertEqual(model.presentation(for: incompatible).status, "Compte incompatible")
        XCTAssertEqual(
            model.presentation(for: incompatible).diagnostic,
            "Capability manquante : scm.change-request.manage, work-items.read.")
        XCTAssertEqual(
            model.presentation(for: incompatible).action,
            "Choisir un compte compatible")
    }

    @MainActor
    func testRefreshIgnoresAnObsoleteDiscoveryResponse() async {
        let stale = Connection(
            id: "connection/github-stale", provider: "github", accountLabel: "Stale",
            status: "available", capabilities: ["github.api", "scm.change-request.manage", "work-items.read"])
        let current = Connection(
            id: "connection/github-current", provider: "github", accountLabel: "Current",
            status: "available", capabilities: ["github.api", "scm.change-request.manage", "work-items.read"])
        let api = DeferredDiscoveryAPI()
        let model = ConnectionsModel(api: api)

        let first = Task { await model.refresh() }
        await api.waitForDiscoveries(1)
        let second = Task { await model.refresh() }
        await api.waitForDiscoveries(2)
        await api.resolve(at: 0, with: [stale])
        await api.resolve(at: 1, with: [current])
        await first.value
        await second.value

        XCTAssertEqual(model.connections, [current])
        XCTAssertEqual(model.discoveryState, .accounts)
    }

    @MainActor
    func testRegisterAddsTheEngineDescriptorWithoutStoringTheAccountReference() async {
        let connection = Connection(
            id: "connection/github-Account",
            provider: "github",
            accountLabel: "Account",
            status: "unauthenticated",
            capabilities: [])
        let api = StubConnectionsAPI(registered: connection)
        let model = ConnectionsModel(api: api)

        let didRegister = await model.register(accountReference: "  gh://Account  ")
        let registeredReferences = await api.registeredReferences

        XCTAssertTrue(didRegister)
        XCTAssertEqual(model.connections, [connection])
        XCTAssertEqual(registeredReferences, ["gh://Account"])
    }

    @MainActor
    func testValidateReplacesTheDisplayedDescriptorAndStatus() async {
        let registered = Connection(
            id: "connection/github-main",
            provider: "github",
            accountLabel: "Registered account",
            status: "unauthenticated",
            capabilities: [])
        let validated = Connection(
            id: registered.id,
            provider: "github",
            accountLabel: "Gasppacho",
            status: "available",
            capabilities: ["github.api", "scm.change-request.manage", "work-items.read"])
        let model = ConnectionsModel(
            api: StubConnectionsAPI(connections: [registered], validated: validated))

        await model.refresh()
        await model.validate(connectionID: registered.id)

        XCTAssertEqual(model.connections, [validated])
        XCTAssertNil(model.errorMessage)
    }

    @MainActor
    func testValidateFailureKeepsTheDescriptorAndShowsTheEngineError() async {
        let connection = Connection(
            id: "connection/github-main",
            provider: "github",
            accountLabel: "Gasppacho",
            status: "available",
            capabilities: ["github.api"])
        let model = ConnectionsModel(
            api: StubConnectionsAPI(
                connections: [connection],
                validated: connection,
                validateError: .engineError(
                    operation: "POST /v1/connections/connection%2Fgithub-main/validate",
                    code: "connection.not-found",
                    message: "The connection is no longer registered.")))

        await model.refresh()
        await model.validate(connectionID: connection.id)

        XCTAssertEqual(model.connections, [connection])
        XCTAssertEqual(
            model.errorMessage,
            "The connection is no longer registered. (connection.not-found)")
    }

    @MainActor
    func testEngineErrorKeepsItsDocumentedCodeAndMessage() async {
        let model = ConnectionsModel(
            api: StubConnectionsAPI(
                registerError: .engineError(
                    operation: "POST /v1/connections",
                    code: "connection.provider-unsupported",
                    message: "The provider is not supported.")))

        let didRegister = await model.register(accountReference: "gh://Account")

        XCTAssertFalse(didRegister)
        XCTAssertEqual(
            model.errorMessage,
            "The provider is not supported. (connection.provider-unsupported)")
    }
}

private actor StubConnectionsAPI: ConnectionsAPI {
    let connections: [Connection]
    let registered: Connection
    let validated: Connection
    let listError: EngineClientError?
    let registerError: EngineClientError?
    let validateError: EngineClientError?
    private(set) var registeredReferences: [String] = []

    init(
        connections: [Connection] = [],
        registered: Connection? = nil,
        validated: Connection? = nil,
        listError: EngineClientError? = nil,
        registerError: EngineClientError? = nil,
        validateError: EngineClientError? = nil
    ) {
        self.connections = connections
        let defaultConnection = Connection(
            id: "connection/github-Account",
            provider: "github",
            accountLabel: "Account",
            status: "unauthenticated",
            capabilities: [])
        let registeredConnection = registered ?? defaultConnection
        self.registered = registeredConnection
        self.validated = validated ?? registeredConnection
        self.listError = listError
        self.registerError = registerError
        self.validateError = validateError
    }

    func listConnections() async throws -> [Connection] {
        if let listError { throw listError }
        return connections
    }

    func discoverGitHubConnections() async throws -> [Connection] {
        if let listError { throw listError }
        return connections
    }

    func registerGitHubConnection(accountReference: String) async throws -> Connection {
        registeredReferences.append(accountReference)
        if let registerError { throw registerError }
        return registered
    }

    func validateConnection(id: String) async throws -> Connection {
        if let validateError { throw validateError }
        return validated
    }
}

private actor DeferredDiscoveryAPI: ConnectionsAPI {
    private var continuations: [CheckedContinuation<[Connection], Never>] = []

    func listConnections() async throws -> [Connection] { [] }

    func discoverGitHubConnections() async throws -> [Connection] {
        await withCheckedContinuation { continuations.append($0) }
    }

    func registerGitHubConnection(accountReference: String) async throws -> Connection {
        Connection(
            id: accountReference, provider: "github", accountLabel: "Unused",
            status: "unauthenticated", capabilities: [])
    }

    func validateConnection(id: String) async throws -> Connection {
        Connection(id: id, provider: "github", accountLabel: "Unused", status: "unauthenticated", capabilities: [])
    }

    func waitForDiscoveries(_ expected: Int) async {
        while continuations.count < expected { await Task.yield() }
    }

    func resolve(at index: Int, with connections: [Connection]) {
        continuations[index].resume(returning: connections)
    }
}
