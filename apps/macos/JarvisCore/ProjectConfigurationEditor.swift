import Foundation
import JarvisAPI

public struct ProjectModuleDraft: Identifiable, Sendable, Equatable {
    public let id: UUID
    public var instanceId: String
    public var moduleId: String
    public var enabled: Bool
    public var runtimeSlot: String
    public var bindings: [String: String]
    public var configurationValues: [String: String]
    public var configurationFields: [ModuleConfigurationField]
    public var rawConfigurationJSON: String?

    init(payload: Components.Schemas.ModuleInstanceConfiguration, package: ModulePackage?) {
        id = UUID()
        instanceId = payload.instanceId
        moduleId = payload.moduleId
        enabled = payload.enabled
        runtimeSlot = payload.runtimeSlot ?? ""
        bindings = payload.bindings?.additionalProperties ?? [:]
        configurationFields = package?.configurationFields ?? []
        configurationValues = Self.decodeConfiguration(payload.configuration)
        rawConfigurationJSON = Self.encodeConfiguration(payload.configuration)
    }

    init(package: ModulePackage, instanceId: String) {
        id = UUID()
        self.instanceId = instanceId
        moduleId = package.moduleId
        enabled = true
        runtimeSlot = ""
        bindings = [:]
        configurationFields = package.configurationFields
        configurationValues = Dictionary(
            uniqueKeysWithValues: package.configurationFields.map { ($0.key, "") })
        rawConfigurationJSON = nil
    }

    private static func encodeConfiguration(
        _ payload: Components.Schemas.ModuleInstanceConfiguration.configurationPayload?
    ) -> String? {
        guard let data = payload?.additionalProperties.jsonData,
            let object = try? JSONSerialization.jsonObject(with: data),
            let normalized = try? JSONSerialization.data(
                withJSONObject: object, options: [.sortedKeys])
        else { return nil }
        return String(data: normalized, encoding: .utf8)
    }

    private static func decodeConfiguration(
        _ payload: Components.Schemas.ModuleInstanceConfiguration.configurationPayload?
    ) -> [String: String] {
        guard let data = payload?.additionalProperties.jsonData,
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return object.mapValues { value in
            if let string = value as? String { return string }
            if let boolean = value as? Bool { return boolean ? "true" : "false" }
            if let number = value as? NSNumber { return number.stringValue }
            if value is NSNull { return "null" }
            if let data = try? JSONSerialization.data(
                withJSONObject: value, options: [.sortedKeys]),
                let text = String(data: data, encoding: .utf8)
            {
                return text
            }
            return ""
        }
    }
}

public struct ProjectSlotDraft: Sendable, Equatable {
    public var requires: String
    public var optional: Bool?
    public var description: String?

    public init(requires: String, optional: Bool? = nil, description: String? = nil) {
        self.requires = requires
        self.optional = optional
        self.description = description
    }

    init(payload: Components.Schemas.ProjectSlotRequirement) {
        requires = payload.requires
        optional = payload.optional
        description = payload.description
    }
}

public struct ProjectConfigurationDraft: Sendable, Equatable {
    public var name: String
    public var modules: [ProjectModuleDraft]
    public var slotRequirements: [String: ProjectSlotDraft]

    private let base: Components.Schemas.PortableProjectConfiguration

    public init(
        configuration: Components.Schemas.PortableProjectConfiguration,
        packages: [ModulePackage]
    ) {
        base = configuration
        name = configuration.metadata.name
        let packagesById = Dictionary(uniqueKeysWithValues: packages.map { ($0.moduleId, $0) })
        modules = configuration.modules.map {
            ProjectModuleDraft(payload: $0, package: packagesById[$0.moduleId])
        }
        slotRequirements = configuration.slots.additionalProperties.mapValues(ProjectSlotDraft.init)
    }

    /// Discovery deliberately returns a partial draft. Completing its required
    /// v1 fields here lets the first Project Wizard visit edit the same model as
    /// a reopened configuration instead of dead-ending on the wire union.
    public init(
        partialConfigurationJSON: Data,
        project: Project,
        packages: [ModulePackage]
    ) throws {
        guard var document = try JSONSerialization.jsonObject(with: partialConfigurationJSON)
            as? [String: Any]
        else { throw ProjectEditorValidationError(issues: ["The discovered draft is invalid."]) }
        document["apiVersion"] = document["apiVersion"] ?? "jarvis.dev/project/v1"
        document["kind"] = document["kind"] ?? "Project"
        var metadata = document["metadata"] as? [String: Any] ?? [:]
        metadata["id"] = (metadata["id"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? project.id
        metadata["name"] = (metadata["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? project.name
        document["metadata"] = metadata
        var repositories = document["repositories"] as? [[String: Any]] ?? []
        if repositories.isEmpty { repositories = [["id": "main", "root": "."]] }
        repositories[0]["id"] = "main"
        repositories[0]["root"] = "."
        repositories[0]["defaultBranch"] = repositories[0]["defaultBranch"] ?? "main"
        repositories[0]["remote"] = repositories[0]["remote"] ?? "origin"
        document["repositories"] = [repositories[0]]
        document["commands"] = document["commands"] ?? [String: String]()
        var git = document["git"] as? [String: Any] ?? [:]
        git["branchPattern"] = git["branchPattern"] ?? "agent/{workItemId}-{slug}"
        git["commitStrategy"] = git["commitStrategy"] ?? "conventional"
        git["pushRemote"] = git["pushRemote"] ?? "origin"
        git["allowForcePush"] = false
        document["git"] = git
        var workspace = document["workspace"] as? [String: Any] ?? [:]
        workspace["strategy"] = "git-worktree"
        workspace["maxConcurrentExecutions"] = workspace["maxConcurrentExecutions"] ?? 1
        workspace["retainOnFailureDays"] = workspace["retainOnFailureDays"] ?? 7
        document["workspace"] = workspace
        document["slots"] = document["slots"] ?? [String: Any]()
        document["modules"] = document["modules"] ?? [Any]()
        let completed = try JSONSerialization.data(withJSONObject: document)
        let configuration = try JSONDecoder().decode(
            Components.Schemas.PortableProjectConfiguration.self, from: completed)
        self.init(configuration: configuration, packages: packages)
    }

    public mutating func select(package: ModulePackage, for moduleId: UUID) {
        guard let index = modules.firstIndex(where: { $0.id == moduleId }) else { return }
        let previousValues = modules[index].configurationValues
        modules[index].moduleId = package.moduleId
        modules[index].configurationFields = package.configurationFields
        modules[index].rawConfigurationJSON = nil
        modules[index].configurationValues = Dictionary(
            uniqueKeysWithValues: package.configurationFields.map { field in
                (field.key, previousValues[field.key] ?? "")
            })
    }

    public mutating func add(package: ModulePackage) {
        let stem = package.moduleId.split(separator: ".").last.map(String.init) ?? "module"
        var candidate = stem
        var suffix = 2
        let existing = Set(modules.map(\.instanceId))
        while existing.contains(candidate) {
            candidate = "\(stem)-\(suffix)"
            suffix += 1
        }
        modules.append(ProjectModuleDraft(package: package, instanceId: candidate))
    }

    public func payload() throws -> Components.Schemas.PortableProjectConfiguration {
        var issues: [String] = []
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            issues.append("Project name is required.")
        }
        let identifiers = modules.map(\.instanceId)
        if Set(identifiers).count != identifiers.count {
            issues.append("Module Instance IDs must be unique.")
        }
        for (index, module) in modules.enumerated()
        where module.instanceId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            issues.append("Module \(index + 1) needs an Instance ID.")
        }
        guard issues.isEmpty else { throw ProjectEditorValidationError(issues: issues) }

        let data = try JSONEncoder().encode(base)
        guard var document = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            throw ProjectEditorValidationError(issues: [
                "Portable Configuration could not be edited."
            ])
        }
        var metadata = document["metadata"] as? [String: Any] ?? [:]
        metadata["name"] = name
        document["metadata"] = metadata
        document["slots"] = slotRequirements.mapValues { requirement in
            var value: [String: Any] = ["requires": requirement.requires]
            if let optional = requirement.optional { value["optional"] = optional }
            if let description = requirement.description { value["description"] = description }
            return value
        }
        document["modules"] = modules.map { module in
            var configuration: [String: Any] = [:]
            if module.configurationFields.isEmpty, let raw = module.rawConfigurationJSON,
                let data = raw.data(using: .utf8),
                let preserved = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            {
                configuration = preserved
            }
            for field in module.configurationFields {
                let text = module.configurationValues[field.key, default: ""]
                if text.isEmpty && !field.required { continue }
                guard !text.isEmpty else {
                    issues.append("\(module.instanceId): \(field.label) is required.")
                    continue
                }
                do {
                    configuration[field.key] = try Self.decode(text, as: field.kind)
                } catch {
                    issues.append("\(module.instanceId): \(field.label) has an invalid value.")
                }
            }
            var document: [String: Any] = [
                "instanceId": module.instanceId,
                "moduleId": module.moduleId,
                "enabled": module.enabled,
            ]
            if !module.runtimeSlot.isEmpty { document["runtimeSlot"] = module.runtimeSlot }
            if !module.bindings.isEmpty { document["bindings"] = module.bindings }
            if !configuration.isEmpty { document["configuration"] = configuration }
            return document
        }
        guard issues.isEmpty else { throw ProjectEditorValidationError(issues: issues) }
        let updated = try JSONSerialization.data(withJSONObject: document)
        return try JSONDecoder().decode(
            Components.Schemas.PortableProjectConfiguration.self, from: updated)
    }

    private static func decode(_ text: String, as kind: ModuleConfigurationField.ValueKind) throws
        -> Any
    {
        switch kind {
        case .string, .choice:
            return text
        case .integer:
            guard let value = Int(text) else { throw ProjectEditorValueError.invalid }
            return value
        case .boolean:
            guard let value = Bool(text) else { throw ProjectEditorValueError.invalid }
            return value
        case .json:
            guard let data = text.data(using: .utf8) else { throw ProjectEditorValueError.invalid }
            return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        }
    }
}

public struct ProjectEditorValidationError: LocalizedError, Sendable, Equatable {
    public let issues: [String]
    public var errorDescription: String? { issues.joined(separator: " ") }
}

private enum ProjectEditorValueError: Error { case invalid }
