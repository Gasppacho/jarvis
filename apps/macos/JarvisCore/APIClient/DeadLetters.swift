import Foundation
import JarvisAPI

/// A definitive delivery failure returned by the Local API.
public struct DeadLetter: Identifiable, Hashable, Sendable {
    public let deliveryId: String
    public let projectId: String
    public let eventId: String
    public let moduleInstanceId: String
    public let code: String
    public let message: String?
    public let attempts: Int
    public let lastExecutionId: String?
    public let createdAt: Date

    public var id: String { deliveryId }

    public init(
        deliveryId: String,
        projectId: String,
        eventId: String,
        moduleInstanceId: String,
        code: String,
        message: String?,
        attempts: Int,
        lastExecutionId: String?,
        createdAt: Date
    ) {
        self.deliveryId = deliveryId
        self.projectId = projectId
        self.eventId = eventId
        self.moduleInstanceId = moduleInstanceId
        self.code = code
        self.message = message
        self.attempts = attempts
        self.lastExecutionId = lastExecutionId
        self.createdAt = createdAt
    }

    init(payload: Components.Schemas.DeadLetter) {
        self.init(
            deliveryId: payload.deliveryId,
            projectId: payload.projectId,
            eventId: payload.eventId,
            moduleInstanceId: payload.moduleInstanceId,
            code: payload.code,
            message: payload.message,
            attempts: payload.attempts,
            lastExecutionId: payload.lastExecutionId,
            createdAt: payload.createdAt)
    }
}

/// The only operations consumed by the Project Dead Letters feature.
public protocol DeadLettersAPI: Sendable {
    func listProjectDeadLetters(projectId: String) async throws -> [DeadLetter]
    func replayDeadLetter(deliveryId: String) async throws -> TimelineExecution
}

extension EngineClient: DeadLettersAPI {}
