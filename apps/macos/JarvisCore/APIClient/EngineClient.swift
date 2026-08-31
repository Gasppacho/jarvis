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
    public enum Status: String, Sendable {
        case ready
        case degraded
        case shuttingDown = "shutting-down"
    }
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
    /// The engine answered with its documented error envelope: the stable code
    /// (`project.already-imported`, `engine.database-unavailable`, …) and the
    /// message the shell can display.
    case engineError(operation: String, code: String, message: String)
    case unexpectedResponse(String)
}

/// The Local API as the shell uses it. Types come from the generated client, so
/// nothing here can drift from contracts/openapi/local-api.v1.yaml.
public struct EngineClient: Sendable {
    private let underlying: Client

    /// Loopback only, so a request that has not answered in a few seconds is
    /// wedged rather than slow. URLSession's 60-second default would hang Quit
    /// for over a minute waiting on an engine that will never reply.
    private static let requestTimeout: TimeInterval = 5

    public init(port: Int, token: String) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = Self.requestTimeout
        configuration.timeoutIntervalForResource = Self.requestTimeout
        underlying = Client(
            serverURL: URL(string: "http://127.0.0.1:\(port)")!,
            transport: URLSessionTransport(
                configuration: .init(session: URLSession(configuration: configuration))),
            middlewares: [SessionTokenMiddleware(token: token)]
        )
    }

    public func health() async throws -> EngineHealth {
        let output = try await underlying.getHealth(.init())
        switch output {
        case .ok(let ok):
            let payload = try ok.body.json
            // Exhaustive switches, not `?? .degraded`: a value added to the
            // contract must break this build rather than be silently mapped to
            // something plausible.
            let status: EngineHealth.Status =
                switch payload.status {
                case .ready: .ready
                case .degraded: .degraded
                case .shutting_hyphen_down: .shuttingDown
                }
            let database: EngineHealth.Database =
                switch payload.database {
                case .ready: .ready
                case .migrating: .migrating
                case .failed: .failed
                }
            return EngineHealth(
                status: status,
                engineVersion: payload.engineVersion,
                apiVersion: payload.apiVersion.rawValue,
                database: database
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

    // MARK: Project Registry (ticket 02)

    /// Inspects a local repository read-only. Discovery never spawns git, never
    /// runs a project script and never writes to the folder (PROJECTS.md).
    public func discoverRepository(path: String) async throws -> RepositoryInspection {
        let operation = "POST /v1/discovery/repository"
        let output = try await underlying.discoverRepository(
            .init(body: .json(.init(path: path)))
        )
        switch output {
        case .ok(let ok):
            let payload = try ok.body.json
            return RepositoryInspection(discovery: payload)
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .`default`(_, let error):
            let payload = try error.body.json
            throw EngineClientError.engineError(
                operation: operation, code: payload.error.code, message: payload.error.message)
        }
    }

    /// Saves a `draft` project for the repository at `repositoryPath`. A
    /// committed `.jarvis/project.yaml` is adopted; otherwise the engine infers
    /// the draft from discovery. Returns 409 `project.already-imported` for a
    /// repository this installation already imported.
    public func importProject(repositoryPath: String) async throws -> ProjectDetail {
        let operation = "POST /v1/projects"
        let output = try await underlying.importProject(
            .init(body: .json(.init(repositoryPath: repositoryPath)))
        )
        switch output {
        case .created(let created):
            let payload = try created.body.json
            return ProjectDetail(detail: payload)
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .`default`(_, let error):
            let payload = try error.body.json
            throw EngineClientError.engineError(
                operation: operation, code: payload.error.code, message: payload.error.message)
        }
    }

    public func listProjects() async throws -> [Project] {
        let operation = "GET /v1/projects"
        let output = try await underlying.listProjects(.init())
        switch output {
        case .ok(let ok):
            let payload = try ok.body.json
            // The engine's list order is authoritative (PERSISTENCE.md: name, then id).
            return payload.items
                .map {
                    Project(
                        id: $0.id,
                        name: $0.name,
                        status: $0.status.asDomain,
                        moduleCount: $0.moduleCount,
                        activeExecutions: $0.activeExecutions)
                }
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .undocumented(let statusCode, _):
            throw EngineClientError.unexpectedResponse("\(operation) returned \(statusCode)")
        }
    }

    public func getProject(id: String) async throws -> ProjectDetail {
        let operation = "GET /v1/projects/\(id)"
        let output = try await underlying.getProject(
            .init(path: .init(projectId: id))
        )
        switch output {
        case .ok(let ok):
            let payload = try ok.body.json
            return ProjectDetail(detail: payload)
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .`default`(_, let error):
            let payload = try error.body.json
            throw EngineClientError.engineError(
                operation: operation, code: payload.error.code, message: payload.error.message)
        }
    }
}
