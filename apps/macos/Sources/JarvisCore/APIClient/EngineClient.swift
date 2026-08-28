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

    /// Read-only inspection of a folder the user picked.
    public func inspectRepository(at path: String) async throws -> RepositoryInspection {
        let response = try await client.discoverRepository(body: .json(.init(path: path)))
        switch response {
        case .ok(let ok):
            let payload = try ok.body.json
            return RepositoryInspection(
                isGitRepository: payload.isGitRepository,
                remoteUrl: payload.remoteUrl,
                provider: payload.provider,
                defaultBranch: payload.defaultBranch,
                packageManager: payload.packageManager
            )
        case let .`default`(statusCode, response):
            throw Self.failure(statusCode: statusCode, response: response)
        }
    }

    public func importProject(repositoryPath: String) async throws -> Project {
        let response = try await client.importProject(
            body: .json(.init(repositoryPath: repositoryPath)))
        switch response {
        case .created(let created):
            let payload = try created.body.json
            return Project(
                id: payload.value1.id,
                name: payload.value1.name,
                status: payload.value1.status.rawValue,
                moduleCount: payload.value1.moduleCount
            )
        case let .`default`(statusCode, response):
            throw Self.failure(statusCode: statusCode, response: response)
        }
    }

    public func listProjects() async throws -> [Project] {
        let response = try await client.listProjects()
        switch response {
        case .ok(let ok):
            return try ok.body.json.items.map { summary in
                Project(
                    id: summary.id,
                    name: summary.name,
                    status: summary.status.rawValue,
                    moduleCount: summary.moduleCount
                )
            }
        case let .`default`(statusCode, response):
            throw Self.failure(statusCode: statusCode, response: response)
        }
    }

    private static func failure(
        statusCode: Int, response: Components.Responses._Error
    ) -> EngineClientError {
        if statusCode == 401 || statusCode == 403 { return .unauthorized }
        guard let failure = try? response.body.json.error else {
            return .unexpectedStatus(statusCode)
        }
        return .requestRejected(code: failure.code, message: failure.message)
    }
}
