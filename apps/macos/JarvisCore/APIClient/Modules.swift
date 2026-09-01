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

    init(payload: Components.Schemas.ModulePackage) {
        let configurationSchema: String? = if let schema = payload.configurationSchema,
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

public struct ModuleConfigurationField: Identifiable, Sendable, Equatable {
    public enum ValueKind: Sendable, Equatable {
        case string
        case integer
        case boolean
        case choice([String])
        case json
    }

    public var id: String { key }
    public let key: String
    public let label: String
    public let required: Bool
    public let kind: ValueKind

    static func decode(from schema: String?) -> [ModuleConfigurationField] {
        guard let schema, let data = schema.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let properties = object["properties"] as? [String: [String: Any]]
        else { return [] }
        let required = Set(object["required"] as? [String] ?? [])
        return properties.keys.sorted().map { key in
            let property = properties[key] ?? [:]
            let label = property["title"] as? String ?? key
            let kind: ValueKind
            if let choices = property["enum"] as? [String] {
                kind = .choice(choices)
            } else {
                kind = switch property["type"] as? String {
                case "string": .string
                case "integer", "number": .integer
                case "boolean": .boolean
                default: .json
                }
            }
            return .init(key: key, label: label, required: required.contains(key), kind: kind)
        }
    }
}

public struct ModulePackagePresentationField: Identifiable, Sendable, Equatable {
    public var id: String { label }
    public let label: String
    public let value: String
}
