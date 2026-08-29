import Foundation
import HTTPTypes
import JarvisAPI
import OpenAPIRuntime
import OpenAPIURLSession

/// Adds the session bearer token to every request. The token never reaches
/// disk or user defaults, so it lives only in this middleware for the session.
struct SessionTokenMiddleware: ClientMiddleware {
    let token: String

    func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var request = request
        request.headerFields[.authorization] = "Bearer \(token)"
        return try await next(request, body, baseURL)
    }
}

public struct EngineHealth: Sendable, Equatable {
    public enum Status: String, Sendable { case ready, degraded, shuttingDown }
    public enum Database: String, Sendable { case ready, migrating, failed }

    public let status: Status
    public let engineVersion: String
    public let apiVersion: String
    public let database: Database
}

public enum EngineClientError: Error, Sendable, Equatable {
    /// The engine rejected the session token. The contract declares this on
    /// every operation, so the generated client makes it a real case.
    case unauthorized(operation: String)
    /// The engine refused a request that did not address the loopback interface.
    case hostNotAllowed(operation: String)
    case unexpectedResponse(String)
}

/// The Local API as the shell uses it. Types come from the generated client, so
/// nothing here can drift from contracts/openapi/local-api.v1.yaml.
public struct EngineClient: Sendable {
    private let underlying: Client

    public init(port: Int, token: String) {
        underlying = Client(
            serverURL: URL(string: "http://127.0.0.1:\(port)")!,
            transport: URLSessionTransport(),
            middlewares: [SessionTokenMiddleware(token: token)]
        )
    }

    public func health() async throws -> EngineHealth {
        let output = try await underlying.getHealth(.init())
        switch output {
        case .ok(let ok):
            let payload = try ok.body.json
            return EngineHealth(
                status: EngineHealth.Status(rawValue: payload.status.rawValue) ?? .degraded,
                engineVersion: payload.engineVersion,
                apiVersion: payload.apiVersion.rawValue,
                database: EngineHealth.Database(rawValue: payload.database.rawValue) ?? .failed
            )
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: "GET /v1/health")
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: "GET /v1/health")
        case .undocumented(let statusCode, _):
            throw EngineClientError.unexpectedResponse("GET /v1/health returned \(statusCode)")
        }
    }

    public func shutdown() async throws {
        let output = try await underlying.shutdownEngine(.init())
        switch output {
        case .accepted:
            return
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: "POST /v1/system/shutdown")
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: "POST /v1/system/shutdown")
        case .undocumented(let statusCode, _):
            throw EngineClientError.unexpectedResponse(
                "POST /v1/system/shutdown returned \(statusCode)")
        }
    }
}
