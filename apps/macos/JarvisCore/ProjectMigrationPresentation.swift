import Foundation
import JarvisAPI

public struct ProjectMigrationReason: Sendable, Equatable {
    public let code: String
    public let message: String

    init(_ payload: Components.Schemas.ProjectGuidedMigrationReason) {
        code = payload.code
        message = payload.message
    }
}

public struct ProjectMigrationPreview: Sendable, Equatable {
    public struct Plan: Sendable, Equatable {
        public let removedModule: String
        public let readyLabel: String
        public let scope: String

        init(_ payload: Components.Schemas.ProjectGuidedMigrationPreview.planPayload) {
            removedModule = payload.removedModule.rawValue
            readyLabel = payload.destination.readyLabel
            scope = switch payload.destination.scope {
            case .case1: "Surveiller les issues prêtes"
            case .case2(let value): "Essai limité à \(ProjectPreflightState.issueLabel(value.workItemRef))"
            }
        }
    }

    public let projectId: String
    public let canApply: Bool
    public let compositionFingerprint: String
    public let reasons: [ProjectMigrationReason]
    public let plan: Plan?

    init(_ payload: Components.Schemas.ProjectGuidedMigrationPreview) {
        projectId = payload.projectId
        canApply = payload.canApply
        compositionFingerprint = payload.compositionFingerprint
        reasons = payload.reasons.map(ProjectMigrationReason.init)
        plan = payload.plan.map(Plan.init)
    }

    public var destinationSummary: String {
        guard let plan else {
            return "GitHub, Development et Pull Request · composition fixe · règles remplacées par l’admission Development"
        }
        return "GitHub, Development et Pull Request · \(plan.scope) · label \(plan.readyLabel) · règle \(plan.removedModule) retirée"
    }

    public var requiresPauseBeforeMigration: Bool {
        reasons.contains { $0.code == "project-active" || $0.code == "work-pending" }
    }
}

public struct ProjectMigrationResult: Sendable, Equatable {
    public let projectId: String
    public let applied: Bool
    public let historyId: String?
    public let hasBackup: Bool

    init(_ payload: Components.Schemas.ProjectGuidedMigrationResult) {
        projectId = payload.projectId
        applied = payload.applied
        historyId = payload.historyId
        hasBackup = payload.backup != nil
    }
}

public protocol ProjectMigrationAPI: Sendable {
    func previewGuidedMigration(projectId: String) async throws -> ProjectMigrationPreview
    func applyGuidedMigration(
        projectId: String,
        compositionFingerprint: String,
        writeToRepository: Bool
    ) async throws -> ProjectMigrationResult
}

public enum ProjectMigrationState: Sendable, Equatable {
    case unchecked
    case loading
    case current(ProjectMigrationPreview)
    case applied(ProjectMigrationResult)
    case failed(String)

    public var preview: ProjectMigrationPreview? {
        if case .current(let value) = self { return value }
        return nil
    }

    public var requiresMigration: Bool {
        preview != nil && preview?.canApply == false
    }
}
