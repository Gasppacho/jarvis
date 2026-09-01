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
    public let bookmarkRef: String?

    public var id: String { repositoryId }
}

public struct ProjectModulePresentationField: Identifiable, Sendable, Equatable {
    public var id: String { label }
    public let label: String
    public let value: String
}

/// One configured Module Instance, decoded from the generated Local API payload.
public struct ProjectModuleInstance: Identifiable, Sendable, Equatable {
    public var id: String { instanceId }
    public let instanceId: String
    public let moduleId: String
    public let enabled: Bool
    public let runtimeSlot: String?
    public let bindings: [String: String]
    public let configurationSummary: String

    init(payload: Components.Schemas.ModuleInstanceConfiguration) {
        instanceId = payload.instanceId
        moduleId = payload.moduleId
        enabled = payload.enabled
        runtimeSlot = payload.runtimeSlot
        bindings = payload.bindings?.additionalProperties ?? [:]
        configurationSummary = payload.configuration.flatMap(prettyJSON) ?? "None"
    }

    public var presentationFields: [ProjectModulePresentationField] {
        [
            .init(label: "Enabled", value: enabled ? "Enabled" : "Disabled"),
            .init(label: "Package ID", value: moduleId),
            .init(label: "Instance ID", value: instanceId),
            .init(label: "Runtime slot", value: runtimeSlot ?? "None"),
            .init(
                label: "Bindings",
                value: bindings.isEmpty
                    ? "None"
                    : bindings.sorted { $0.key < $1.key }
                        .map { "\($0.key) → \($0.value)" }.joined(separator: ", ")),
            .init(label: "Configuration", value: configurationSummary),
        ]
    }
}

public enum ProjectResourceKind: String, CaseIterable, Sendable, Equatable {
    case connection
    case runtime
    case mcp
    case moduleInstance = "module-instance"
    case engine

    init(wireValue: String) {
        guard let kind = Self(rawValue: wireValue) else {
            preconditionFailure("Generated Project resource kind drifted: \(wireValue)")
        }
        self = kind
    }

    init(payload: Components.Schemas.ProjectSlotBinding.kindPayload) {
        self.init(wireValue: payload.rawValue)
    }

    var payload: Components.Schemas.ProjectSlotBinding.kindPayload {
        guard let payload = Components.Schemas.ProjectSlotBinding.kindPayload(rawValue: rawValue)
        else { preconditionFailure("Generated Project resource kind drifted: \(rawValue)") }
        return payload
    }
}

public struct ProjectSlotBinding: Identifiable, Sendable, Equatable {
    public var id: String { slotId }
    public let slotId: String
    public let kind: ProjectResourceKind
    public let ref: String
}

public struct ProjectResourceCandidate: Identifiable, Sendable, Equatable {
    public var id: String { "\(kind.rawValue)/\(ref)" }
    public let ref: String
    public let kind: ProjectResourceKind
    public let displayName: String
    public let capabilities: [String]

    init(payload: Components.Schemas.ProjectResourceCandidate) {
        ref = payload.ref
        displayName = payload.displayName
        capabilities = payload.capabilities
        kind = ProjectResourceKind(wireValue: payload.kind.rawValue)
    }
}

public struct LocalRepositoryBinding: Identifiable, Sendable, Equatable {
    public var id: String { repositoryId }
    public let repositoryId: String
    public let path: String
    public let bookmarkRef: String?
}

public struct LocalProjectBindings: Sendable, Equatable {
    public let projectId: String
    public let repositories: [LocalRepositoryBinding]
    public let slots: [ProjectSlotBinding]
    public let wirePayload: Components.Schemas.ProjectBindings

    init(payload: Components.Schemas.ProjectBindings) {
        projectId = payload.projectId
        repositories = payload.repositories.additionalProperties
            .sorted { $0.key < $1.key }
            .map { repositoryId, binding in
                LocalRepositoryBinding(
                    repositoryId: repositoryId,
                    path: binding.path,
                    bookmarkRef: binding.bookmarkRef)
            }
        slots = payload.slots.additionalProperties
            .sorted { $0.key < $1.key }
            .map { slotId, binding in
                ProjectSlotBinding(
                    slotId: slotId,
                    kind: ProjectResourceKind(payload: binding.kind),
                    ref: binding.ref)
            }
        wirePayload = payload
    }
}

/// A project with its local bindings (the Local API's `ProjectDetail`).
public struct ProjectDetail: Sendable, Equatable {
    public let project: Project
    public let bindings: [ProjectBinding]
    /// The portable config exactly as the engine stored it, as JSON. It is
    /// committed to the user's repository, so it must never carry the machine's
    /// absolute path (docs/architecture/PROJECTS.md) — tests assert that.
    public let portableConfigJSON: Data?
    public let portableConfiguration: Components.Schemas.PortableProjectConfiguration?
    public let partialPortableConfiguration: Components.Schemas.PortableProjectDraft?
    public let modules: [ProjectModuleInstance]
    public let projectSlots: [String]

    init(detail: Components.Schemas.ProjectDetail) {
        project = Project(
            id: detail.id,
            name: detail.name,
            status: detail.status.asDomain,
            moduleCount: detail.moduleCount,
            activeExecutions: detail.activeExecutions
        )
        bindings = ProjectDetail.decodeBindings(detail.bindingStatus)
        portableConfiguration = detail.portableConfig.value1
        partialPortableConfiguration = detail.portableConfig.value2
        modules = detail.portableConfig.value1?.modules.map(ProjectModuleInstance.init(payload:)) ?? []
        projectSlots = detail.portableConfig.value1?.slots.additionalProperties.keys.sorted() ?? []
        portableConfigJSON = encodedJSON(detail.portableConfig)
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
    static func decodeBindings(
        _ payload: Components.Schemas.ProjectDetail.bindingStatusPayload
    ) -> [ProjectBinding] {
        payload.additionalProperties
            .sorted { $0.key < $1.key }
            .map { repositoryId, entry in
                ProjectBinding(
                    repositoryId: repositoryId,
                    path: entry.path,
                    accessible: entry.accessible,
                    bookmarkRef: entry.bookmarkRef
                )
            }
    }
}

private func encodedJSON<Value: Encodable>(_ value: Value) -> Data? {
    try? JSONEncoder().encode(value)
}

private func prettyJSON<Value: Encodable>(_ value: Value) -> String? {
    guard let data = encodedJSON(value),
        let object = try? JSONSerialization.jsonObject(with: data),
        let pretty = try? JSONSerialization.data(
            withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
    else { return nil }
    return String(data: pretty, encoding: .utf8)
}

extension OpenAPIObjectContainer {
    /// Re-serializes the free-form container back into JSON. The contract
    /// declares `suggested`, `portableConfig` and `bindingStatus` as plain
    /// objects, so the shell decodes its own typed shape from the bytes.
    var jsonData: Data? {
        (try? JSONEncoder().encode(self))
    }
}
