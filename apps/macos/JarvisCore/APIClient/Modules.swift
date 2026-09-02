import Foundation
import JarvisAPI

/// A validated bundled Module Package as presented by the macOS catalogue.
public struct ModulePackage: Identifiable, Sendable, Equatable {
    public var id: String { "\(moduleId)@\(version)" }

    public let moduleId: String
    public let version: String
    public let displayName: String
    public let description: String
    public let categories: [String]
    public let consumes: [String]
    public let produces: [String]
    public let requires: [String]
    public let provides: [String]
    public let configurationSchemaRef: String?
    public let configurationSchema: String?
    public let configurationFields: [ModuleConfigurationField]
    public let automationRuleSemantics: AutomationRuleSchemaSemantics?

    init(payload: Components.Schemas.ModulePackage) {
        let configurationSchema: String? =
            if let schema = payload.configurationSchema,
            let compactJSON = schema.additionalProperties.jsonData,
            let object = try? JSONSerialization.jsonObject(with: compactJSON),
            let prettyJSON = try? JSONSerialization.data(
                withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        {
            String(data: prettyJSON, encoding: .utf8)
        } else {
            nil
        }
        moduleId = payload.moduleId
        version = payload.version
        displayName = payload.displayName
        description = payload.description
        categories = payload.categories
        consumes = payload.consumes
        produces = payload.produces
        requires = payload.requires
        provides = payload.provides
        configurationSchemaRef = payload.configurationSchemaRef
        self.configurationSchema = configurationSchema
        configurationFields = ModuleConfigurationField.decode(from: configurationSchema)
        automationRuleSemantics = AutomationRuleSchemaSemantics.decode(from: configurationSchema)
    }

    public var presentationFields: [ModulePackagePresentationField] {
        [
            .init(label: "Module ID", value: moduleId),
            .init(label: "Categories", value: list(categories)),
            .init(label: "Consumes", value: list(consumes)),
            .init(label: "Produces", value: list(produces)),
            .init(label: "Requires", value: list(requires)),
            .init(label: "Provides", value: list(provides)),
            .init(label: "Configuration schema reference", value: configurationSchemaRef ?? "None"),
            .init(label: "Configuration schema", value: configurationSchema ?? "None"),
        ]
    }

    private func list(_ values: [String]) -> String {
        values.isEmpty ? "None" : values.joined(separator: ", ")
    }
}

public struct AutomationRuleSchemaSemantics: Sendable, Equatable {
    public let ruleSetKey: String

    static func decode(from schema: String?) -> Self? {
        guard let schema, let data = schema.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let properties = object["properties"] as? [String: [String: Any]],
            let ruleSet = properties.first(where: {
                $0.value["$comment"] as? String == "jarvis:automation-rule-set"
            }),
            let items = ruleSet.value["items"] as? [String: Any],
            let ruleProperties = items["properties"] as? [String: [String: Any]],
            let when = ruleProperties["when"],
            let whenProperties = when["properties"] as? [String: [String: Any]],
            whenProperties["eventType"]?["$comment"] as? String == "jarvis:event-kind=fact",
            whenProperties["equals"]?["$comment"] as? String == "jarvis:bounded-match",
            let emit = ruleProperties["emit"],
            let emitProperties = emit["properties"] as? [String: [String: Any]],
            emitProperties["type"]?["$comment"] as? String == "jarvis:event-kind=request",
            emitProperties["target"]?["$comment"] as? String == "jarvis:request-target"
        else { return nil }
        return Self(ruleSetKey: ruleSet.key)
    }
}

public struct ModuleConfigurationField: Identifiable, Sendable, Equatable {
    public indirect enum ValueKind: Sendable, Equatable {
        case string
        case integer
        case number
        case boolean
        case choice([String])
        case object([ModuleConfigurationField])
        case array(ModuleConfigurationField)
    }

    public var id: String { key }
    public let key: String
    public let label: String
    public let required: Bool
    public let kind: ValueKind
    public let defaultValue: String?
    public let minimum: Double?
    public let maximum: Double?
    public let minimumLength: Int?
    public let maximumLength: Int?
    public let pattern: String?
    public let description: String?
    public let examples: [String]
    public let minimumItems: Int?
    public let maximumItems: Int?
    private let schemaJSON: Data?

    public var initialValue: String {
        if let defaultValue { return defaultValue }
        return switch kind {
        case .array: "[]"
        case .object: "{}"
        default: ""
        }
    }

    public var accessibilityLabel: String {
        "\(label), \(required ? "required" : "optional"), \(controlName)"
    }

    public var accessibilityHint: String {
        var parts = description.map { [$0] } ?? []
        if let defaultValue { parts.append("Default: \(defaultValue).") }
        if !examples.isEmpty { parts.append("Example: \(examples.joined(separator: ", ")).") }
        if minimum != nil || maximum != nil {
            parts.append(
                "Range: \(minimum?.formatted() ?? "unbounded") to \(maximum?.formatted() ?? "unbounded").")
        }
        return parts.joined(separator: " ")
    }

    private var controlName: String {
        switch kind {
        case .string: "text"
        case .integer: "integer"
        case .number: "number"
        case .boolean: "toggle"
        case .choice: "choice"
        case .object: "object"
        case .array: "repeatable"
        }
    }

    public func validationIssue(for text: String) -> String? {
        if text.isEmpty {
            return required ? "\(label) is required." : nil
        }
        do {
            let value = try decode(text)
            if let number = value as? NSNumber, kind != .boolean {
                if let minimum, number.doubleValue < minimum {
                    return "\(label) must be at least \(minimum.formatted())."
                }
                if let maximum, number.doubleValue > maximum {
                    return "\(label) must be at most \(maximum.formatted())."
                }
            }
            if let pattern, case .string = kind,
                text.range(of: pattern, options: .regularExpression) == nil
            {
                return "\(label) does not match the required pattern."
            }
            if let schemaJSON,
                let schema = try JSONSerialization.jsonObject(with: schemaJSON)
                    as? [String: Any],
                !Self.satisfies(value, schema: schema)
            {
                return "\(label) does not satisfy its schema."
            }
            return nil
        } catch {
            return "\(label) has an invalid value."
        }
    }

    public func decode(_ text: String) throws -> Any {
        switch kind {
        case .string:
            return text
        case .choice(let choices):
            guard choices.contains(text) else { throw ModuleConfigurationValueError.invalid }
            return text
        case .integer:
            guard let value = Int(text) else { throw ModuleConfigurationValueError.invalid }
            return value
        case .number:
            guard let value = Double(text), value.isFinite else {
                throw ModuleConfigurationValueError.invalid
            }
            return value
        case .boolean:
            guard text == "true" || text == "false" else {
                throw ModuleConfigurationValueError.invalid
            }
            return text == "true"
        case .array:
            guard let data = text.data(using: .utf8),
                let value = try JSONSerialization.jsonObject(with: data) as? [Any]
            else { throw ModuleConfigurationValueError.invalid }
            return value
        case .object:
            guard let data = text.data(using: .utf8),
                let value = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { throw ModuleConfigurationValueError.invalid }
            return value
        }
    }

    static func decode(from schema: String?) -> [ModuleConfigurationField] {
        guard let schema, let data = schema.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let properties = object["properties"] as? [String: [String: Any]]
        else { return [] }
        let required = Set(object["required"] as? [String] ?? [])
        return properties.keys.sorted().map { key in
            decodeField(key: key, schema: properties[key] ?? [:], required: required.contains(key))
        }
    }

    private static func decodeField(
        key: String,
        schema: [String: Any],
        required: Bool
    ) -> ModuleConfigurationField {
            let kind: ValueKind
        if let choices = schema["enum"] as? [String] {
                kind = .choice(choices)
            } else {
            kind =
                switch schema["type"] as? String {
                case "string": .string
                case "integer": .integer
                case "number": .number
                case "boolean": .boolean
                case "array":
                    .array(
                        decodeField(
                            key: "item",
                            schema: schema["items"] as? [String: Any] ?? [:],
                            required: true))
                default:
                    .object(decodeObjectFields(schema))
                }
            }
            return .init(
                key: key,
            label: schema["title"] as? String ?? key,
            required: required,
                kind: kind,
            defaultValue: encodeDefault(schema["default"]),
            minimum: (schema["minimum"] as? NSNumber)?.doubleValue,
            maximum: (schema["maximum"] as? NSNumber)?.doubleValue,
            minimumLength: schema["minLength"] as? Int,
            maximumLength: schema["maxLength"] as? Int,
            pattern: schema["pattern"] as? String,
            description: schema["description"] as? String,
            examples: (schema["examples"] as? [Any] ?? []).compactMap(encodeDefault),
            minimumItems: schema["minItems"] as? Int,
            maximumItems: schema["maxItems"] as? Int,
                schemaJSON: try? JSONSerialization.data(
                withJSONObject: schema, options: [.sortedKeys]))
    }

    private static func decodeObjectFields(_ schema: [String: Any]) -> [ModuleConfigurationField] {
        let properties = schema["properties"] as? [String: [String: Any]] ?? [:]
        let required = Set(schema["required"] as? [String] ?? [])
        return properties.keys.sorted().map { key in
            decodeField(key: key, schema: properties[key] ?? [:], required: required.contains(key))
        }
    }

    private static func satisfies(_ value: Any, schema: [String: Any]) -> Bool {
        if let choices = schema["enum"] as? [Any],
            !choices.contains(where: { jsonEqual($0, value) })
        {
            return false
        }
        if let types = schema["type"] as? [String] {
            if !types.contains(where: { matchesType(value, type: $0) }) { return false }
        } else if let type = schema["type"] as? String, !matchesType(value, type: type) {
            return false
        }
        if let string = value as? String {
            if let minimum = schema["minLength"] as? Int, string.count < minimum { return false }
            if let maximum = schema["maxLength"] as? Int, string.count > maximum { return false }
            if let pattern = schema["pattern"] as? String,
                string.range(of: pattern, options: .regularExpression) == nil
            {
                return false
            }
        }
        if let number = value as? NSNumber, !(value is Bool) {
            if let minimum = schema["minimum"] as? NSNumber,
                number.doubleValue < minimum.doubleValue
            {
                return false
            }
            if let maximum = schema["maximum"] as? NSNumber,
                number.doubleValue > maximum.doubleValue
            {
                return false
            }
        }
        if let array = value as? [Any] {
            if let minimum = schema["minItems"] as? Int, array.count < minimum { return false }
            if let maximum = schema["maxItems"] as? Int, array.count > maximum { return false }
            if schema["uniqueItems"] as? Bool == true {
                for index in array.indices
                where array[(index + 1)...].contains(where: {
                    jsonEqual(array[index], $0)
                }) { return false }
            }
            if let itemSchema = schema["items"] as? [String: Any],
                array.contains(where: { !satisfies($0, schema: itemSchema) })
            {
                return false
            }
        }
        if let object = value as? [String: Any] {
            let required = schema["required"] as? [String] ?? []
            if required.contains(where: { object[$0] == nil }) { return false }
            let properties = schema["properties"] as? [String: [String: Any]] ?? [:]
            for (key, child) in object {
                if let childSchema = properties[key] {
                    if !satisfies(child, schema: childSchema) { return false }
                } else if schema["additionalProperties"] as? Bool == false {
                    return false
                } else if let childSchema = schema["additionalProperties"] as? [String: Any],
                    !satisfies(child, schema: childSchema)
                {
                    return false
                }
            }
            if let alternatives = schema["oneOf"] as? [[String: Any]],
                alternatives.filter({ satisfies(object, schema: $0) }).count != 1
            {
                return false
            }
        }
        return true
    }

    private static func matchesType(_ value: Any, type: String) -> Bool {
        switch type {
        case "null": return value is NSNull
        case "boolean": return value is Bool
        case "string": return value is String
        case "integer":
            guard let number = value as? NSNumber, !(value is Bool) else { return false }
            return number.doubleValue.rounded() == number.doubleValue
        case "number": return value is NSNumber && !(value is Bool)
        case "array": return value is [Any]
        case "object": return value is [String: Any]
        default: return true
        }
    }

    private static func jsonEqual(_ left: Any, _ right: Any) -> Bool {
        guard JSONSerialization.isValidJSONObject([left]),
            JSONSerialization.isValidJSONObject([right]),
            let leftData = try? JSONSerialization.data(withJSONObject: [left], options: [.sortedKeys]),
            let rightData = try? JSONSerialization.data(withJSONObject: [right], options: [.sortedKeys])
        else { return false }
        return leftData == rightData
    }

    private static func encodeDefault(_ value: Any?) -> String? {
        guard let value else { return nil }
        if let string = value as? String { return string }
        if let boolean = value as? Bool { return boolean ? "true" : "false" }
        if let number = value as? NSNumber { return number.stringValue }
        guard JSONSerialization.isValidJSONObject(value),
            let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

private enum ModuleConfigurationValueError: Error { case invalid }

public struct ModulePackagePresentationField: Identifiable, Sendable, Equatable {
    public var id: String { label }
    public let label: String
    public let value: String
}
