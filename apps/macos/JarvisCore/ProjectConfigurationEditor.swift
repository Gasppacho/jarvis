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
    public var preservedConfigurationValues: [String: [String: String]]
    public var preservedRawConfigurations: [String: String]
    public var configurationRepairExplanation: String?

    /// Displays the Engine's effective default without materializing it in the Draft.
    public func configurationValue(for key: String) -> String {
        configurationValues[key]
            ?? (moduleId == "jarvis.module.development" && key == "readyLabel"
                ? "ready-to-dev" : "")
    }

    init(payload: Components.Schemas.ModuleInstanceConfiguration, package: ModulePackage?) {
        id = UUID()
        instanceId = payload.instanceId
        moduleId = payload.moduleId
        enabled = payload.enabled
        runtimeSlot = payload.runtimeSlot ?? ""
        bindings = payload.bindings?.additionalProperties ?? [:]
        configurationFields = package?.configurationFields ?? []
        configurationValues = Dictionary(
            uniqueKeysWithValues: configurationFields.map { ($0.key, $0.initialValue) })
        configurationValues.merge(Self.decodeConfiguration(payload.configuration)) { _, saved in
            saved
        }
        rawConfigurationJSON = Self.encodeConfiguration(payload.configuration)
        preservedConfigurationValues = [moduleId: configurationValues]
        preservedRawConfigurations = [:]
        if let rawConfigurationJSON {
            preservedRawConfigurations[moduleId] = rawConfigurationJSON
        }
        configurationRepairExplanation = nil
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
            uniqueKeysWithValues: package.configurationFields.map { ($0.key, $0.initialValue) })
        rawConfigurationJSON = nil
        preservedConfigurationValues = [moduleId: configurationValues]
        preservedRawConfigurations = [:]
        configurationRepairExplanation = nil
    }

    public var validationIssues: [String] {
        let fieldIssues: [String] = configurationFields.compactMap { field in
            return field.validationIssue(for: configurationValues[field.key, default: ""])
                .map { "\(instanceId): \($0)" }
        }
        return fieldIssues
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

    public var repositories: [Components.Schemas.ProjectRepositoryConfiguration]
    private let base: Components.Schemas.PortableProjectConfiguration
    public var isFixedComposition: Bool { base.compositionMode == .fixed_hyphen_modules }

    public init(
        configuration: Components.Schemas.PortableProjectConfiguration,
        packages: [ModulePackage]
    ) {
        base = configuration
        repositories = configuration.repositories
        name = configuration.metadata.name
        let packagesById = Dictionary(uniqueKeysWithValues: packages.map { ($0.moduleId, $0) })
        modules = configuration.modules.map {
            ProjectModuleDraft(payload: $0, package: packagesById[$0.moduleId])
        }
        slotRequirements = configuration.slots.additionalProperties.mapValues(ProjectSlotDraft.init)
    }

    /// The engine owns every discovered repository/Git/workspace value. Swift
    /// only converts the typed empty-composition draft to the shared editor model.
    public init(
        partialConfiguration: Components.Schemas.PortableProjectDraft,
        packages: [ModulePackage]
    ) throws {
        let encoded = try JSONEncoder().encode(partialConfiguration)
        let configuration = try JSONDecoder().decode(
            Components.Schemas.PortableProjectConfiguration.self, from: encoded)
        self.init(configuration: configuration, packages: packages)
    }

    public mutating func select(package: ModulePackage, for moduleId: UUID) {
        guard let index = modules.firstIndex(where: { $0.id == moduleId }) else { return }
        let previousModuleID = modules[index].moduleId
        modules[index].preservedConfigurationValues[previousModuleID] =
            modules[index].configurationValues
        if let raw = modules[index].rawConfigurationJSON {
            modules[index].preservedRawConfigurations[previousModuleID] = raw
        }
        var restoredValues = modules[index].preservedConfigurationValues[package.moduleId] ?? [:]
        for field in package.configurationFields where restoredValues[field.key] == nil {
            restoredValues[field.key] = field.initialValue
        }
        modules[index].moduleId = package.moduleId
        modules[index].configurationFields = package.configurationFields
        modules[index].rawConfigurationJSON =
            modules[index].preservedRawConfigurations[package.moduleId]
        modules[index].configurationValues = restoredValues
        modules[index].preservedConfigurationValues[package.moduleId] =
            modules[index].configurationValues
        modules[index].configurationRepairExplanation =
            previousModuleID == package.moduleId
            ? nil
            : "Configuration input for \(previousModuleID) was preserved. Switch back to repair or reuse it; review the fields required by \(package.displayName)."
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

    public var validationIssues: [String] {
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
        issues.append(contentsOf: modules.flatMap(\.validationIssues))
        return issues
    }

    public func payload() throws -> Components.Schemas.PortableProjectConfiguration {
        var issues = validationIssues
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
        let repositoriesData = try JSONEncoder().encode(repositories)
        document["repositories"] = try JSONSerialization.jsonObject(with: repositoriesData)
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
                guard !text.isEmpty else { continue }
                do {
                    configuration[field.key] = try field.decode(text)
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
}

public struct ProjectEditorValidationError: LocalizedError, Sendable, Equatable {
    public let issues: [String]
    public var errorDescription: String? { issues.joined(separator: " ") }
}
