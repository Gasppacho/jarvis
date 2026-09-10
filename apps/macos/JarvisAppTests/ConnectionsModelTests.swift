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
