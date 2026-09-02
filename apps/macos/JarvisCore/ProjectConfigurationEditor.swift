import Foundation
import JarvisAPI

public struct AutomationRuleDraft: Identifiable, Sendable, Equatable {
    public enum Target: Sendable, Equatable {
        case moduleInstance(String)
        case binding(String)
    }

    public let id: UUID
    public var ruleID: String
    public var inputEventType: String
    public var matchJSON: String
    public var emissionEventType: String
    public var target: Target
    public var payloadJSON: String?

    init?(document: Any) {
        guard let document = document as? [String: Any],
            let ruleID = document["id"] as? String,
            let when = document["when"] as? [String: Any],
            let inputEventType = when["eventType"] as? String,
            let emit = document["emit"] as? [String: Any],
            let emissionEventType = emit["type"] as? String,
            let targetDocument = emit["target"] as? [String: Any]
        else { return nil }
        let target: Target
        if let instance = targetDocument["moduleInstanceId"] as? String {
            target = .moduleInstance(instance)
        } else if let binding = targetDocument["binding"] as? String {
            target = .binding(binding)
        } else {
            return nil
        }
        id = UUID()
        self.ruleID = ruleID
        self.inputEventType = inputEventType
        matchJSON = Self.jsonText(when["equals"] ?? [:]) ?? "{}"
        self.emissionEventType = emissionEventType
        self.target = target
        payloadJSON = emit["payload"].flatMap(Self.jsonText)
    }

    init(
        ruleID: String,
        inputEventType: String,
        emissionEventType: String,
        target: Target
    ) {
        id = UUID()
        self.ruleID = ruleID
        self.inputEventType = inputEventType
        matchJSON = "{}"
        self.emissionEventType = emissionEventType
        self.target = target
        payloadJSON = nil
    }

    var validationIssues: [String] {
        var issues: [String] = []
        if ruleID.range(of: "^[a-z0-9][a-z0-9._-]*$", options: .regularExpression) == nil {
            issues.append("Rule ID must use lowercase letters, numbers, dots, underscores, or hyphens.")
        }
        if inputEventType.count < 3 || emissionEventType.count < 3 {
            issues.append("Rule \(ruleID) Event types must contain at least three characters.")
        }
        let targetValue =
            switch target {
        case .moduleInstance(let value), .binding(let value): value
        }
        if targetValue.isEmpty {
            issues.append("Rule \(ruleID) needs a Request target.")
        }
        if Self.jsonObject(matchJSON, scalarValuesOnly: true) == nil {
            issues.append("Rule \(ruleID) match must be a JSON object with scalar values.")
        }
        if let payloadJSON, Self.jsonObject(payloadJSON, scalarValuesOnly: false) == nil {
            issues.append("Rule \(ruleID) payload must be a JSON object.")
        }
        return issues
    }

    func document() throws -> [String: Any] {
        guard let equals = Self.jsonObject(matchJSON, scalarValuesOnly: true) else {
            throw ProjectEditorValidationError(issues: validationIssues)
        }
        var when: [String: Any] = ["eventType": inputEventType]
        if !equals.isEmpty { when["equals"] = equals }
        let targetDocument: [String: String] =
            switch target {
        case .moduleInstance(let id): ["moduleInstanceId": id]
        case .binding(let id): ["binding": id]
        }
        var emit: [String: Any] = [
            "type": emissionEventType,
            "target": targetDocument,
        ]
        if let payloadJSON, let payload = Self.jsonObject(payloadJSON, scalarValuesOnly: false) {
            emit["payload"] = payload
        }
        return ["id": ruleID, "when": when, "emit": emit]
    }

    private static func jsonObject(
        _ text: String,
        scalarValuesOnly: Bool
    ) -> [String: Any]? {
        guard let data = text.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        if scalarValuesOnly,
            object.values.contains(where: {
                !($0 is String || $0 is NSNumber || $0 is NSNull)
            })
        {
            return nil
        }
        return object
    }

    private static func jsonText(_ value: Any) -> String? {
        guard JSONSerialization.isValidJSONObject(value),
            let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

public struct ProjectModuleDraft: Identifiable, Sendable, Equatable {
    public let id: UUID
    public var instanceId: String
    public var moduleId: String
    public var enabled: Bool
    public var runtimeSlot: String
    public var bindings: [String: String]
    public var configurationValues: [String: String]
    public var configurationFields: [ModuleConfigurationField]
    public var automationRules: [AutomationRuleDraft]?
    public var rawConfigurationJSON: String?
    public var preservedConfigurationValues: [String: [String: String]]
    public var preservedAutomationRules: [String: [AutomationRuleDraft]]
    public var preservedRawConfigurations: [String: String]
    public var configurationRepairExplanation: String?

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
        configurationValues.merge(Self.decodeConfiguration(payload.configuration)) { _, saved in saved }
        automationRules = Self.decodeAutomationRules(
            payload.configuration, semantics: package?.automationRuleSemantics)
        rawConfigurationJSON = Self.encodeConfiguration(payload.configuration)
        preservedConfigurationValues = [moduleId: configurationValues]
        preservedAutomationRules = [:]
        if let automationRules {
            preservedAutomationRules[moduleId] = automationRules
        }
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
        automationRules = package.automationRuleSemantics == nil ? nil : []
        rawConfigurationJSON = nil
        preservedConfigurationValues = [moduleId: configurationValues]
        preservedAutomationRules = [:]
        preservedRawConfigurations = [:]
        configurationRepairExplanation = nil
    }

    public var validationIssues: [String] {
        let fieldIssues: [String] = configurationFields.compactMap { field in
            if automationRules != nil, field.key == "rules" { return nil }
            return field.validationIssue(for: configurationValues[field.key, default: ""])
                .map { "\(instanceId): \($0)" }
        }
        let ruleIssues = (automationRules ?? []).flatMap(\.validationIssues).map {
            "\(instanceId): \($0)"
        }
        let emptyRuleIssue =
            automationRules?.isEmpty == true
            ? ["\(instanceId): At least one Automation Rule is required."] : []
        return fieldIssues + ruleIssues + emptyRuleIssue
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

    private static func decodeAutomationRules(
        _ payload: Components.Schemas.ModuleInstanceConfiguration.configurationPayload?,
        semantics: AutomationRuleSchemaSemantics?
    ) -> [AutomationRuleDraft]? {
        guard let semantics else { return nil }
        guard let data = payload?.additionalProperties.jsonData,
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let documents = object[semantics.ruleSetKey] as? [Any]
        else { return [] }
        return documents.compactMap(AutomationRuleDraft.init(document:))
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
        if let rules = modules[index].automationRules {
            modules[index].preservedAutomationRules[previousModuleID] = rules
        }
        if let raw = modules[index].rawConfigurationJSON {
            modules[index].preservedRawConfigurations[previousModuleID] = raw
        }
        var restoredValues = modules[index].preservedConfigurationValues[package.moduleId] ?? [:]
        for field in package.configurationFields where restoredValues[field.key] == nil {
            restoredValues[field.key] = field.initialValue
        }
        modules[index].moduleId = package.moduleId
        modules[index].configurationFields = package.configurationFields
        modules[index].automationRules =
            package.automationRuleSemantics == nil
            ? nil : modules[index].preservedAutomationRules[package.moduleId] ?? []
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

    public mutating func addAutomationRule(
        moduleID: UUID,
        inputEventType: String,
        emissionEventType: String,
        resolvedConsumerID: String?
    ) {
        guard let moduleIndex = modules.firstIndex(where: { $0.id == moduleID }),
            modules[moduleIndex].automationRules != nil
        else { return }
        let existing = Set(modules[moduleIndex].automationRules?.map(\.ruleID) ?? [])
        var index = existing.count + 1
        var ruleID = "rule-\(index)"
        while existing.contains(ruleID) {
            index += 1
            ruleID = "rule-\(index)"
        }
        modules[moduleIndex].automationRules?.append(
            AutomationRuleDraft(
                ruleID: ruleID,
                inputEventType: inputEventType,
                emissionEventType: emissionEventType,
                target: .moduleInstance(resolvedConsumerID ?? "")))
    }

    public mutating func removeAutomationRule(moduleID: UUID, ruleID: UUID) {
        guard let moduleIndex = modules.firstIndex(where: { $0.id == moduleID }) else { return }
        modules[moduleIndex].automationRules?.removeAll { $0.id == ruleID }
    }

    public mutating func setAutomationRuleID(moduleID: UUID, ruleID: UUID, value: String) {
        editAutomationRule(moduleID: moduleID, ruleID: ruleID) { $0.ruleID = value }
    }

    public mutating func setAutomationRuleInput(
        moduleID: UUID,
        ruleID: UUID,
        eventType: String
    ) {
        editAutomationRule(moduleID: moduleID, ruleID: ruleID) { $0.inputEventType = eventType }
    }

    public mutating func setAutomationRuleMatch(moduleID: UUID, ruleID: UUID, json: String) {
        editAutomationRule(moduleID: moduleID, ruleID: ruleID) { $0.matchJSON = json }
    }

    public mutating func setAutomationRulePayload(
        moduleID: UUID,
        ruleID: UUID,
        json: String
    ) {
        editAutomationRule(moduleID: moduleID, ruleID: ruleID) {
            $0.payloadJSON = json == "{}" ? nil : json
        }
    }

    public mutating func setAutomationRuleEmission(
        moduleID: UUID,
        ruleID: UUID,
        eventType: String,
        resolvedConsumerID: String?
    ) {
        editAutomationRule(moduleID: moduleID, ruleID: ruleID) { rule in
            rule.emissionEventType = eventType
            if let resolvedConsumerID { rule.target = .moduleInstance(resolvedConsumerID) }
        }
    }

    public mutating func setAutomationRuleTarget(
        moduleID: UUID,
        ruleID: UUID,
        target: AutomationRuleDraft.Target
    ) {
        editAutomationRule(moduleID: moduleID, ruleID: ruleID) { $0.target = target }
    }

    private mutating func editAutomationRule(
        moduleID: UUID,
        ruleID: UUID,
        _ edit: (inout AutomationRuleDraft) -> Void
    ) {
        guard let moduleIndex = modules.firstIndex(where: { $0.id == moduleID }),
            var rules = modules[moduleIndex].automationRules,
            let ruleIndex = rules.firstIndex(where: { $0.id == ruleID })
        else { return }
        edit(&rules[ruleIndex])
        modules[moduleIndex].automationRules = rules
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
        document["slots"] = slotRequirements.mapValues { requirement in
            var value: [String: Any] = ["requires": requirement.requires]
            if let optional = requirement.optional { value["optional"] = optional }
            if let description = requirement.description { value["description"] = description }
            return value
        }
        document["modules"] = try modules.map { module in
            var configuration: [String: Any] = [:]
            if module.configurationFields.isEmpty, let raw = module.rawConfigurationJSON,
                let data = raw.data(using: .utf8),
                let preserved = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            {
                configuration = preserved
            }
            for field in module.configurationFields {
                if module.automationRules != nil, field.key == "rules" { continue }
                let text = module.configurationValues[field.key, default: ""]
                if text.isEmpty && !field.required { continue }
                guard !text.isEmpty else { continue }
                do {
                    configuration[field.key] = try field.decode(text)
                } catch {
                    issues.append("\(module.instanceId): \(field.label) has an invalid value.")
                }
            }
            if let rules = module.automationRules {
                configuration["rules"] = try rules.map { try $0.document() }
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
