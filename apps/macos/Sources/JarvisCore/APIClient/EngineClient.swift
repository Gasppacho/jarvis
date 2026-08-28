import Foundation
import HTTPTypes
import JarvisAPI
import OpenAPIRuntime
import OpenAPIURLSession

/// The engine's self-reported health, as described by the Local API contract.
public struct EngineHealth: Sendable, Equatable {
    public let status: String
    public let engineVersion: String
    public let apiVersion: String
    public let database: String

    public var isReady: Bool { status == "ready" && database == "ready" }
}

public enum EngineClientError: Error, LocalizedError {
    case unauthorized
    case requestRejected(code: String, message: String)
    case unexpectedStatus(Int)

    public var errorDescription: String? {
        switch self {
        case .unauthorized:
            return "Jarvis was not authorised by its engine. Quit and reopen Jarvis."
        case .requestRejected(let code, let message):
            return "\(message) (\(code))"
        case .unexpectedStatus(let code):
            return "The Jarvis engine answered with an unexpected status (\(code))."
        }
    }
}

/// Attaches the ephemeral Engine Session token to every call. The token is
/// never persisted to preferences (docs/architecture/MACOS_APP.md).
private struct BearerTokenMiddleware: ClientMiddleware {
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

/// Typed access to the Local API, built on the generated OpenAPI client.
public struct EngineClient: Sendable {
    private let client: Client

    public init(session: EngineSession) {
        self.client = Client(
            serverURL: session.baseURL,
            transport: URLSessionTransport(),
            middlewares: [BearerTokenMiddleware(token: session.token)]
        )
    }

    public func health() async throws -> EngineHealth {
        let response = try await client.getHealth()
        switch response {
        case .ok(let ok):
            let payload = try ok.body.json
            return EngineHealth(
                status: payload.status.rawValue,
                engineVersion: payload.engineVersion,
                apiVersion: payload.apiVersion.rawValue,
                database: payload.database.rawValue
            )
        // Declaring a `default` response makes it the catch-all: the generator
        // emits no `undocumented` case for this operation.
        case let .`default`(statusCode, response):
            if statusCode == 401 || statusCode == 403 { throw EngineClientError.unauthorized }
            guard let failure = try? response.body.json.error else {
                throw EngineClientError.unexpectedStatus(statusCode)
            }
            throw EngineClientError.requestRejected(code: failure.code, message: failure.message)
        }
    }
}
