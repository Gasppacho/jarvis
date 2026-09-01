import Foundation
import JarvisAPI
import OpenAPIRuntime

/// A project as the sidebar shows it (the Local API's `ProjectSummary`).
public struct Project: Sendable, Equatable, Hashable, Identifiable {
    public enum Status: String, Sendable, Equatable {
        case draft
        case valid
        case active
        case paused
        case invalid
        case degraded
        case archived
    }

    public let id: String
    public let name: String
    public let status: Status
    public let moduleCount: Int
    public let activeExecutions: Int?

    /// The summary and the detail restate the status as two distinct wire
    /// enums (the contract keeps them in sync); callers map both to the domain
    /// value before constructing.
    init(
        id: String,
        name: String,
        status: Status,
        moduleCount: Int,
        activeExecutions: Int?
    ) {
        self.id = id
        self.name = name
        self.status = status
        self.moduleCount = moduleCount
        self.activeExecutions = activeExecutions
    }
}

extension Project.Status {
    init(payload: Components.Schemas.ProjectSummary.statusPayload) {
        // Exhaustive, not `?? .draft`: a value added to the contract must break
        // this build rather than be silently mapped to something plausible.
        self = switch payload {
            case .draft: .draft
            case .valid: .valid
            case .active: .active
            case .paused: .paused
            case .invalid: .invalid
            case .degraded: .degraded
            case .archived: .archived
        }
    }
}

extension Components.Schemas.ProjectSummary.statusPayload {
    var asDomain: Project.Status { Project.Status(payload: self) }
}

extension Components.Schemas.ProjectDetail.statusPayload {
    var asDomain: Project.Status {
        // The detail restates the summary's status (the contract keeps the two
        // enums in sync); map through the wire value, so a drift fails loudly.
        switch self {
            case .draft: .draft
            case .valid: .valid
            case .active: .active
            case .paused: .paused
            case .invalid: .invalid
            case .degraded: .degraded
            case .archived: .archived
        }
    }
}

/// Where a project's repository lives on this machine (the detail's `bindingStatus`).
public struct ProjectBinding: Sendable, Equatable, Identifiable {
    public let repositoryId: String
    public let path: String
    public let accessible: Bool

    public var id: String { repositoryId }
}

/// A project with its local bindings (the Local API's `ProjectDetail`).
public struct ProjectDetail: Sendable, Equatable {
    public let project: Project
    public let bindings: [ProjectBinding]
    /// The portable config exactly as the engine stored it, as JSON. It is
    /// committed to the user's repository, so it must never carry the machine's
    /// absolute path (docs/architecture/PROJECTS.md) — tests assert that.
    public let portableConfigJSON: Data?

    init(detail: Components.Schemas.ProjectDetail) {
        project = Project(
            id: detail.id,
            name: detail.name,
            status: detail.status.asDomain,
            moduleCount: detail.moduleCount,
            activeExecutions: detail.activeExecutions
        )
        bindings = ProjectDetail.decodeBindings(detail.bindingStatus)
        portableConfigJSON = detail.portableConfig.jsonData
    }
}

/// What discovery learned from the picked folder (the Local API's `RepositoryDiscovery`).
public struct RepositoryInspection: Sendable, Equatable {
    public let isGitRepository: Bool
    public let remoteUrl: String?
    public let provider: String?
    public let defaultBranch: String?
    public let packageManager: String?
    public let scripts: [String: String]
    /// The draft configuration the engine proposes (`.jarvis/project.yaml` shape,
    /// minus the wizard's `slots`/`modules` — tickets 03+); `nil` if the engine
    /// omits or the shell cannot decode it.
    public let suggested: SuggestedProjectConfig?

    init(discovery: Components.Schemas.RepositoryDiscovery) {
        isGitRepository = discovery.isGitRepository
        remoteUrl = discovery.remoteUrl
        provider = discovery.provider
        defaultBranch = discovery.defaultBranch
        packageManager = discovery.packageManager
        scripts = discovery.scripts?.additionalProperties ?? [:]
        suggested = SuggestedProjectConfig(container: discovery.suggested)
    }
}

/// The draft portable configuration discovery proposes (`.jarvis/project.yaml`,
/// minus the wizard's `slots`/`modules`). The contract types `suggested` as a
/// plain object, so the shell decodes its own shape from the JSON bytes.
public struct SuggestedProjectConfig: Sendable, Equatable, Decodable {
    public struct Metadata: Sendable, Equatable, Decodable {
        public let id: String?
        public let name: String?
    }
    public struct Repository: Sendable, Equatable, Decodable {
        public let id: String?
        public let root: String?
        public let defaultBranch: String?
        public let remote: String?
    }
    public struct Git: Sendable, Equatable, Decodable {
        public let branchPattern: String?
        public let pushRemote: String?
    }
    public struct Workspace: Sendable, Equatable, Decodable {
        public let maxConcurrentExecutions: Int?
    }

    public let metadata: Metadata?
    public let repositories: [Repository]?
    public let commands: [String: String]?
    public let git: Git?
    public let workspace: Workspace?

    init?(container: OpenAPIObjectContainer) {
        guard let data = container.jsonData else { return nil }
        guard let decoded = try? JSONDecoder().decode(SuggestedProjectConfig.self, from: data) else {
            return nil
        }
        self = decoded
    }
}

private extension ProjectDetail {
    struct BindingEntry: Decodable {
        let path: String?
        let accessible: Bool?
    }

    static func decodeBindings(_ container: OpenAPIObjectContainer) -> [ProjectBinding] {
        guard let data = container.jsonData,
            let entries = try? JSONDecoder().decode([String: BindingEntry].self, from: data)
        else {
            return []
        }
        return entries
            .sorted { $0.key < $1.key }
            .map { repositoryId, entry in
                guard let path = entry.path else { return nil }
                return ProjectBinding(
                    repositoryId: repositoryId, path: path, accessible: entry.accessible ?? false)
            }
            .compactMap { $0 }
    }
}

extension OpenAPIObjectContainer {
    /// Re-serializes the free-form container back into JSON. The contract
    /// declares `suggested`, `portableConfig` and `bindingStatus` as plain
    /// objects, so the shell decodes its own typed shape from the bytes.
    var jsonData: Data? {
        (try? JSONEncoder().encode(self))
    }
}
