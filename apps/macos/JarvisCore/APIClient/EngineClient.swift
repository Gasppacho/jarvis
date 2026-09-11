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
        self.init(
            serverURL: URL(string: "http://127.0.0.1:\(port)")!,
            transport: URLSessionTransport(
                configuration: .init(session: URLSession(configuration: configuration))),
            middlewares: [SessionTokenMiddleware(token: token)])
    }

    /// Test seam: the full `Client` construction (same server URL, transport
    /// and middlewares as the convenience init above) with an injectable
    /// `ClientTransport`, so the generated REST client's decoding can be
    /// asserted against exact wire bytes — the engine's own JSON, with its
    /// fractional-second `occurredAt` — without a socket. The fractional-
    /// seconds regression lived exactly below this seam: the stream decoder
    /// fixed, the REST reads broken.
    init(
        serverURL: URL,
        transport: any ClientTransport,
        middlewares: [any ClientMiddleware] = []
    ) {
        underlying = Client(
            serverURL: serverURL,
            // The `Configuration` default decodes dates with
            // `ISO8601DateTranscoder.iso8601` — whole-second only — which
            // cannot parse the engine's `toISOString()` stamps; see
            // `FlexibleISO8601DateTranscoder`.
            configuration: Configuration(dateTranscoder: FlexibleISO8601DateTranscoder()),
            transport: transport,
            middlewares: middlewares
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

    // MARK: Module Host (ticket 04)

    public func listModuleCatalog() async throws -> [ModulePackage] {
        let operation = "GET /v1/module-catalog"
        let output = try await underlying.listModuleCatalog(.init())
        switch output {
        case .ok(let ok):
            return try ok.body.json.items.map(ModulePackage.init(payload:))
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .undocumented(let statusCode, _):
            throw EngineClientError.unexpectedResponse("\(operation) returned \(statusCode)")
        }
    }

    /// Served, versioned human meaning for every documented capability id
    /// (ticket 48). Never a hardcoded fallback: an id absent from this
    /// response must render as unavailable rather than guessed.
    public func getCapabilityCatalog() async throws -> [CapabilityGuidance] {
        let operation = "GET /v1/capability-catalog"
        let output = try await underlying.getCapabilityCatalog(.init())
        switch output {
        case .ok(let ok):
            return try ok.body.json.capabilities.map(CapabilityGuidance.init(payload:))
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .undocumented(let statusCode, _):
            throw EngineClientError.unexpectedResponse("\(operation) returned \(statusCode)")
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
            throw try mappedEngineError(operation: operation, payload: error.body.json)
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
            throw try mappedEngineError(operation: operation, payload: error.body.json)
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
            throw try mappedEngineError(operation: operation, payload: error.body.json)
        }
    }

    /// Ticket #61: the Project's durable Event journal, newest first.
    public func listProjectEvents(projectId: String) async throws -> [TimelineEvent] {
        let operation = "GET /v1/projects/\(projectId)/events"
        let output = try await underlying.listProjectEvents(
            .init(path: .init(projectId: projectId))
        )
        switch output {
        case .ok(let ok):
            let payload = try ok.body.json
            return payload.items.map(TimelineEvent.init(payload:))
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .`default`(_, let error):
            throw try mappedEngineError(operation: operation, payload: error.body.json)
        }
    }

    /// Ticket #61: the Project's Executions from the Execution Ledger, newest first.
    public func listProjectExecutions(projectId: String) async throws -> [TimelineExecution] {
        let operation = "GET /v1/projects/\(projectId)/executions"
        let output = try await underlying.listProjectExecutions(
            .init(path: .init(projectId: projectId))
        )
        switch output {
        case .ok(let ok):
            let payload = try ok.body.json
            return payload.items.map(TimelineExecution.init(payload:))
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .`default`(_, let error):
            throw try mappedEngineError(operation: operation, payload: error.body.json)
        }
    }

    public func listProjectDeadLetters(projectId: String) async throws -> [DeadLetter] {
        let operation = "GET /v1/projects/\(projectId)/dead-letters"
        let output = try await underlying.listProjectDeadLetters(
            .init(path: .init(projectId: projectId)))
        switch output {
        case .ok(let ok):
            return try ok.body.json.items.map(DeadLetter.init(payload:))
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .undocumented(let statusCode, _):
            throw EngineClientError.unexpectedResponse("\(operation) returned \(statusCode)")
        }
    }

    public func replayDeadLetter(deliveryId: String) async throws {
        let operation = "POST /v1/dead-letters/\(deliveryId)/replay"
        let output = try await underlying.replayDeadLetter(
            .init(path: .init(deliveryId: deliveryId)))
        switch output {
        case .accepted(_):
            return
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .`default`(_, let error):
            throw try mappedEngineError(operation: operation, payload: error.body.json)
        }
    }

    public func previewProjectCompositionChoices(
        projectId: String,
        portableConfig: Components.Schemas.PortableProjectConfiguration? = nil
    ) async throws -> ProjectCompositionGuide {
        let operation = "POST /v1/projects/\(projectId)/composition-choices"
        let body: Operations.previewProjectCompositionChoicesV1.Input.Body?
        if let portableConfig {
            let payload: Operations.previewProjectCompositionChoicesV1.Input.Body.jsonPayload.portableConfigPayload =
                .PortableProjectConfiguration(portableConfig)
            body = .json(.init(portableConfig: payload))
        } else {
            body = nil
        }
        let output = try await underlying.previewProjectCompositionChoicesV1(
            .init(path: .init(projectId: projectId), body: body))
        switch output {
        case .ok(let ok):
            return ProjectCompositionGuide(payload: try ok.body.json)
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .`default`(_, let error):
            throw try mappedEngineError(operation: operation, payload: error.body.json)
        }
    }

    public func reviewProjectComposition(
        projectId: String,
        portableConfig: Components.Schemas.PortableProjectConfiguration? = nil
    ) async throws -> ProjectCompositionReview {
        let operation = "POST /v1/projects/\(projectId)/composition-review"
        let body: Operations.reviewProjectCompositionV1.Input.Body?
        if let portableConfig {
            let payload: Operations.reviewProjectCompositionV1.Input.Body.jsonPayload.portableConfigPayload =
                .PortableProjectConfiguration(portableConfig)
            body = .json(.init(portableConfig: payload))
        } else {
            body = nil
        }
        let output = try await underlying.reviewProjectCompositionV1(
            .init(path: .init(projectId: projectId), body: body))
        switch output {
        case .ok(let ok):
            return ProjectCompositionReview(payload: try ok.body.json)
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .`default`(_, let error):
            throw try mappedEngineError(operation: operation, payload: error.body.json)
        }
    }

    public func fetchProjectCompositionGraph(
        projectId: String,
        portableConfig: Components.Schemas.PortableProjectConfiguration? = nil
    ) async throws -> ProjectCompositionGraph {
        let operation = "POST /v1/projects/\(projectId)/composition-graph"
        let body: Operations.projectCompositionGraph.Input.Body?
        if let portableConfig {
            let payload: Operations.projectCompositionGraph.Input.Body.jsonPayload.portableConfigPayload =
                .PortableProjectConfiguration(portableConfig)
            body = .json(.init(portableConfig: payload))
        } else {
            body = nil
        }
        let output = try await underlying.projectCompositionGraph(
            .init(path: .init(projectId: projectId), body: body))
        switch output {
        case .ok(let ok):
            return ProjectCompositionGraph(payload: try ok.body.json)
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .`default`(_, let error):
            throw try mappedEngineError(operation: operation, payload: error.body.json)
        }
    }

    public func generateProjectValidationReport(projectId: String) async throws
        -> ProjectValidationReport
    {
        let operation = "POST /v1/projects/\(projectId)/validation-report"
        let output = try await underlying.generateProjectValidationReportV1(
            .init(path: .init(projectId: projectId)))
        switch output {
        case .ok(let ok):
            return try ProjectValidationReport(payload: ok.body.json)
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .`default`(_, let error):
            throw try mappedEngineError(operation: operation, payload: error.body.json)
        }
    }

    /// Ticket #55: activates the Project whose current composition and Local
    /// Bindings produced `compositionFingerprint` on a successful validation
    /// report. The engine — not this client — decides whether that report is
    /// still current; a stale or missing one is a stable error code, not a
    /// silent revalidation.
    public func activateProject(
        projectId: String,
        compositionFingerprint: String
    ) async throws -> Project {
        let operation = "POST /v1/projects/\(projectId)/activate"
        let output = try await underlying.activateProject(
            .init(
                path: .init(projectId: projectId),
                body: .json(.init(compositionFingerprint: compositionFingerprint))))
        switch output {
        case .ok(let ok):
            let payload = try ok.body.json
            return Project(
                id: payload.id,
                name: payload.name,
                status: payload.status.asDomain,
                moduleCount: payload.moduleCount,
                activeExecutions: payload.activeExecutions)
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .`default`(_, let error):
            throw try mappedEngineError(operation: operation, payload: error.body.json)
        }
    }

    public func deleteProject(id: String) async throws {
        let operation = "DELETE /v1/projects/\(id)"
        let output = try await underlying.deleteProject(
            .init(path: .init(projectId: id))
        )
        switch output {
        case .noContent:
            return
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .notFound(let error):
            throw try mappedEngineError(operation: operation, payload: error.body.json)
        case .conflict(let error):
            throw try mappedEngineError(operation: operation, payload: error.body.json)
        case .`default`(_, let error):
            throw try mappedEngineError(operation: operation, payload: error.body.json)
        }
    }

    public func replaceProjectConfiguration(
        projectId: String,
        portableConfig: Components.Schemas.PortableProjectConfiguration,
        writeToRepository: Bool
    ) async throws -> ProjectDetail {
        let operation = "PUT /v1/projects/\(projectId)/configuration"
        let output = try await underlying.replaceProjectConfiguration(
            .init(
                path: .init(projectId: projectId),
                body: .json(.init(
                    portableConfig: .PortableProjectConfiguration(portableConfig),
                    writeToRepository: writeToRepository
                ))
            ))
        switch output {
        case .ok(let ok):
            return ProjectDetail(detail: try ok.body.json)
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .`default`(_, let error):
            throw try mappedEngineError(operation: operation, payload: error.body.json)
        }
    }

    public func listProjectBindingCandidates(projectId: String) async throws -> ProjectResourceChoices {
        let operation = "GET /v1/projects/\(projectId)/binding-candidates"
        let output = try await underlying.listProjectBindingCandidates(
            .init(path: .init(projectId: projectId)))
        switch output {
        case .ok(let ok):
            let payload = try ok.body.json
            return ProjectResourceChoices(
                candidates: payload.items.map(ProjectResourceCandidate.init(payload:)),
                slots: payload.slots.map(ProjectResourceBindingChoice.init(payload:)))
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .`default`(_, let error):
            throw try mappedEngineError(operation: operation, payload: error.body.json)
        }
    }

    public func previewProjectBindingCandidates(
        projectId: String,
        portableConfig: Components.Schemas.PortableProjectConfiguration
    ) async throws -> ProjectResourceChoices {
        let operation = "POST /v1/projects/\(projectId)/binding-candidates"
        let output = try await underlying.previewProjectBindingCandidates(
            .init(
                path: .init(projectId: projectId),
                body: .json(.init(portableConfig: portableConfig))))
        switch output {
        case .ok(let ok):
            let payload = try ok.body.json
            return ProjectResourceChoices(
                candidates: payload.items.map(ProjectResourceCandidate.init(payload:)),
                slots: payload.slots.map(ProjectResourceBindingChoice.init(payload:)))
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .`default`(_, let error):
            throw try mappedEngineError(operation: operation, payload: error.body.json)
        }
    }

    public func getProjectBindings(projectId: String) async throws -> LocalProjectBindings {
        let operation = "GET /v1/projects/\(projectId)/bindings"
        let output = try await underlying.getProjectBindings(
            .init(path: .init(projectId: projectId)))
        switch output {
        case .ok(let ok):
            return LocalProjectBindings(payload: try ok.body.json)
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .`default`(_, let error):
            throw try mappedEngineError(operation: operation, payload: error.body.json)
        }
    }

    public func replaceProjectBindings(
        projectId: String,
        bindings: Components.Schemas.ProjectBindings
    ) async throws -> LocalProjectBindings {
        let operation = "PUT /v1/projects/\(projectId)/bindings"
        let output = try await underlying.replaceProjectBindings(
            .init(path: .init(projectId: projectId), body: .json(bindings)))
        switch output {
        case .ok(let ok):
            return LocalProjectBindings(payload: try ok.body.json)
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .`default`(_, let error):
            throw try mappedEngineError(operation: operation, payload: error.body.json)
        }
    }

    // MARK: Connections (ticket 118)

    public func listConnections() async throws -> [Connection] {
        let operation = "GET /v1/connections"
        let output = try await underlying.listConnections(.init())
        switch output {
        case .ok(let ok):
            return try ok.body.json.items.map(Connection.init(payload:))
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .undocumented(let statusCode, _):
            throw EngineClientError.unexpectedResponse("\(operation) returned \(statusCode)")
        }
    }

    public func registerGitHubConnection(accountReference: String) async throws -> Connection {
        let operation = "POST /v1/connections"
        let account = String(accountReference.dropFirst("gh://".count))
        let output = try await underlying.upsertConnection(
            .init(
                body: .json(
                    .init(
                        id: "connection/github-\(account)",
                        kind: "github",
                        displayName: account,
                        secretRef: accountReference))))
        switch output {
        case .created(let created):
            return Connection(payload: try created.body.json)
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .`default`(_, let error):
            throw try mappedEngineError(operation: operation, payload: error.body.json)
        }
    }

    public func validateConnection(id: String) async throws -> Connection {
        let operation = "POST /v1/connections/\(id)/validate"
        let output = try await underlying.validateConnection(
            .init(path: .init(connectionId: id)))
        switch output {
        case .ok(let ok):
            return Connection(payload: try ok.body.json)
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .`default`(_, let error):
            throw try mappedEngineError(operation: operation, payload: error.body.json)
        }
    }

    private func mappedEngineError(
        operation: String,
        payload: Components.Schemas.ErrorResponse
    ) -> EngineClientError {
        .engineError(
            operation: operation,
            code: payload.error.code,
            message: payload.error.message)
    }

    /// Updates the machine-local repository path after the macOS Shell resolves
    /// its Repository Grant. Bookmark bytes remain in the shell; only their
    /// opaque reference crosses the Local API boundary.
    public func updateRepositoryBinding(
        projectId: String,
        repositoryId: String,
        path: String,
        bookmarkRef: String
    ) async throws {
        let operation = "PUT /v1/projects/\(projectId)/repositories/\(repositoryId)/binding"
        let output = try await underlying.updateRepositoryBinding(
            .init(
                path: .init(projectId: projectId, repositoryId: repositoryId),
                body: .json(.init(path: path, bookmarkRef: bookmarkRef))
            ))
        switch output {
        case .ok:
            return
        case .unauthorized:
            throw EngineClientError.unauthorized(operation: operation)
        case .forbidden:
            throw EngineClientError.hostNotAllowed(operation: operation)
        case .`default`(_, let error):
            throw try mappedEngineError(operation: operation, payload: error.body.json)
        }
    }
}
