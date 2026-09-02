import Foundation
import JarvisAPI
import XCTest

@testable import JarvisCore

final class AutomationRuleConfigurationTests: XCTestCase {
    func testAutomationRuleSchemaDrivesSentenceRowsAndCanonicalRoundTrip() throws {
        let package = try automationPackage()
        XCTAssertEqual(package.automationRuleSemantics?.ruleSetKey, "rules")

        let configuration = try projectConfiguration()
        var draft = ProjectConfigurationDraft(configuration: configuration, packages: [package])
        let moduleID = try XCTUnwrap(draft.modules.first?.id)
        let rule = try XCTUnwrap(draft.modules.first?.automationRules?.first)

        XCTAssertEqual(rule.ruleID, "ready-label-starts-development")
        XCTAssertEqual(rule.inputEventType, "scm.work-item.tag-added")
        XCTAssertEqual(rule.matchJSON, #"{"payload.tag":"agent:ready"}"#)
        XCTAssertEqual(rule.emissionEventType, "development.implementation.requested")
        XCTAssertEqual(rule.target, .moduleInstance("development"))

        draft.addAutomationRule(
            moduleID: moduleID,
            inputEventType: "scm.work-item.tag-added",
            emissionEventType: "development.implementation.requested",
            resolvedConsumerID: "development")
        let secondRule = try XCTUnwrap(draft.modules.first?.automationRules?.last)
        draft.setAutomationRuleMatch(moduleID: moduleID, ruleID: rule.id, json: #"{"payload.tag":"agent:queued"}"#)
        XCTAssertEqual(
            draft.modules.first?.automationRules?.last?.ruleID,
            secondRule.ruleID,
            "editing one Rule preserves unrelated Rules")
        draft.setAutomationRuleEmission(
            moduleID: moduleID,
            ruleID: rule.id,
            eventType: "development.implementation.requested",
            resolvedConsumerID: "development")
        draft.setAutomationRulePayload(
            moduleID: moduleID, ruleID: rule.id, json: #"{"priority":"high"}"#)

        let payload = try draft.payload()
        let reopened = ProjectConfigurationDraft(configuration: payload, packages: [package])
        let reopenedRule = try XCTUnwrap(reopened.modules.first?.automationRules?.first)
        XCTAssertEqual(reopenedRule.matchJSON, #"{"payload.tag":"agent:queued"}"#)
        XCTAssertEqual(reopenedRule.payloadJSON, #"{"priority":"high"}"#)
        XCTAssertEqual(reopenedRule.target, .moduleInstance("development"))
        XCTAssertEqual(reopened.modules.first?.automationRules?.count, 2)
        XCTAssertEqual(reopened.modules.count, 2, "editing a Rule preserves unrelated Project input")

        var removed = reopened
        let reopenedModuleID = try XCTUnwrap(removed.modules.first?.id)
        let reopenedRuleID = try XCTUnwrap(removed.modules.first?.automationRules?.first?.id)
        removed.removeAutomationRule(moduleID: reopenedModuleID, ruleID: reopenedRuleID)
        XCTAssertEqual(removed.modules.first?.automationRules?.map(\.ruleID), [secondRule.ruleID])
    }

    func testPresentationUsesEngineChoicesAndMarksAdvancedUnknownValuesNotReady() throws {
        let package = try automationPackage()
        let configuration = try projectConfiguration()
        let draft = ProjectConfigurationDraft(configuration: configuration, packages: [package])
        let choices = try compositionChoices()
        let state = ProjectConfigurationState(
            compositionGuide: ProjectCompositionGuide(payload: choices),
            draft: draft)
        let project = Project(
            id: "rules-project",
            name: "Rules Project",
            status: .draft,
            moduleCount: 2,
            activeExecutions: nil)

        var presentation = ProjectDetailPresentation(
            project: project,
            detail: nil,
            state: state,
            packages: [package])
        let row = try XCTUnwrap(presentation.automationRuleRows.first)
        XCTAssertEqual(row.sentence, "When Work item tag added matches, emit Implementation requested to Development.")
        XCTAssertEqual(row.inputChoices.map(\.type), ["scm.work-item.tag-added"])
        XCTAssertEqual(row.emissionChoices.map(\.type), ["development.implementation.requested"])
        XCTAssertTrue(row.inputChoices[0].detail.contains("GitHub"))
        XCTAssertTrue(row.inputChoices[0].detail.contains("Fact"))
        XCTAssertTrue(row.emissionChoices[0].detail.contains("Development"))
        XCTAssertTrue(row.emissionChoices[0].detail.contains("compatible"))
        XCTAssertEqual(row.targetChoices, ["development"])
        XCTAssertEqual(row.payloadJSON, "{}")
        XCTAssertTrue(row.routingExplanation.contains("exactly one compatible consumer"))
        XCTAssertFalse(
            presentation.isReadyForValidation,
            "Event choices alone cannot replace Engine-owned saved-Draft readiness")

        var unknownDraft = draft
        let moduleID = try XCTUnwrap(unknownDraft.modules.first?.id)
        let ruleID = try XCTUnwrap(unknownDraft.modules.first?.automationRules?.first?.id)
        unknownDraft.setAutomationRuleInput(
            moduleID: moduleID, ruleID: ruleID, eventType: "custom.unknown.fact")
        var unknownState = state
        unknownState.draft = unknownDraft
        presentation = ProjectDetailPresentation(
            project: project,
            detail: nil,
            state: unknownState,
            packages: [package])

        XCTAssertFalse(presentation.isReadyForValidation)
        XCTAssertEqual(presentation.automationRuleRows.first?.inputStatus, .unknown)
        XCTAssertTrue(presentation.automationRuleRows.first?.inputHint.contains("Advanced custom value") == true)
        XCTAssertEqual(presentation.automationRuleRows.first?.emissionEventType, "development.implementation.requested")
    }

    private func automationPackage() throws -> ModulePackage {
        let payload: Components.Schemas.ModulePackage = try decode([
            "moduleId": "jarvis.module.automation-rules",
            "version": "1.0.0",
            "displayName": "Automation Rules",
            "description": "Translates matching Facts into Requests.",
            "categories": ["automation"],
            "consumes": ["scm.work-item.tag-added.v1"],
            "produces": ["development.implementation.requested.v1"],
            "requires": [],
            "provides": [],
            "configurationSchemaRef": "contracts/module-config/automation-rules.v1.schema.json",
            "configurationSchema": automationSchema(),
        ])
        return ModulePackage(payload: payload)
    }

    private func automationSchema() -> [String: Any] {
        [
            "type": "object",
            "required": ["rules"],
            "properties": [
                "rules": [
                    "type": "array",
                    "$comment": "jarvis:automation-rule-set",
                    "items": [
                        "type": "object",
                        "properties": [
                            "when": [
                                "type": "object",
                                "properties": [
                                    "eventType": [
                                        "type": "string",
                                        "$comment": "jarvis:event-kind=fact",
                                    ],
                                    "equals": [
                                        "type": "object",
                                        "$comment": "jarvis:bounded-match",
                                    ],
                                ],
                            ],
                            "emit": [
                                "type": "object",
                                "properties": [
                                    "type": [
                                        "type": "string",
                                        "$comment": "jarvis:event-kind=request",
                                    ],
                                    "target": [
                                        "type": "object",
                                        "$comment": "jarvis:request-target",
                                    ],
                                ],
                            ],
                        ],
                    ],
                ]
            ],
        ]
    }

    private func projectConfiguration() throws -> Components.Schemas.PortableProjectConfiguration {
        try decode([
            "apiVersion": "jarvis.dev/project/v1",
            "kind": "Project",
            "metadata": ["id": "rules-project", "name": "Rules Project"],
            "repositories": [[
                "id": "main", "root": ".", "defaultBranch": "main", "remote": "origin",
            ]],
            "slots": [:],
            "commands": [:],
            "git": [
                "branchPattern": "agent/{workItemId}-{slug}",
                "commitStrategy": "conventional",
                "pushRemote": "origin",
                "allowForcePush": false,
            ],
            "workspace": [
                "strategy": "git-worktree",
                "maxConcurrentExecutions": 1,
                "retainOnFailureDays": 7,
            ],
            "modules": [
                [
                    "instanceId": "automation-rules",
                    "moduleId": "jarvis.module.automation-rules",
                    "enabled": true,
                    "configuration": [
                        "rules": [[
                            "id": "ready-label-starts-development",
                            "when": [
                                "eventType": "scm.work-item.tag-added",
                                "equals": ["payload.tag": "agent:ready"],
                            ],
                            "emit": [
                                "type": "development.implementation.requested",
                                "target": ["moduleInstanceId": "development"],
                            ],
                        ]]
                    ],
                ],
                [
                    "instanceId": "development",
                    "moduleId": "jarvis.module.development",
                    "enabled": true,
                ],
            ],
        ])
    }

    private func compositionChoices() throws -> Components.Schemas.ProjectCompositionChoicesV1 {
        try decode([
            "apiVersion": "jarvis.dev/project-composition-choices/v1",
            "kind": "ProjectCompositionChoices",
            "projectId": "rules-project",
            "startingPoints": [],
            "modulePackages": [],
            "moduleInstances": [],
            "choices": [
                [
                    "label": "Work item tag added",
                    "type": "scm.work-item.tag-added",
                    "version": 1,
                    "kind": "fact",
                    "description": "A source-control work item received a tag.",
                    "payloadSchema": [:],
                    "producers": [[
                        "instanceId": "github", "moduleId": "jarvis.module.github",
                    ]],
                    "consumers": [[
                        "instanceId": "automation-rules",
                        "moduleId": "jarvis.module.automation-rules",
                        "compatibility": "compatible",
                    ]],
                    "routing": [
                        "status": "broadcast",
                        "explanation": "Facts may be delivered to zero or many compatible consumers (1 available).",
                    ],
                ],
                [
                    "label": "Implementation requested",
                    "type": "development.implementation.requested",
                    "version": 1,
                    "kind": "request",
                    "description": "Request implementation.",
                    "payloadSchema": [:],
                    "producers": [[
                        "instanceId": "automation-rules",
                        "moduleId": "jarvis.module.automation-rules",
                    ]],
                    "consumers": [[
                        "instanceId": "development",
                        "moduleId": "jarvis.module.development",
                        "compatibility": "compatible",
                    ]],
                    "routing": [
                        "status": "resolved",
                        "selectedConsumer": [
                            "instanceId": "development",
                            "moduleId": "jarvis.module.development",
                        ],
                        "explanation": "The Request resolves to exactly one compatible consumer.",
                    ],
                ],
            ],
        ])
    }

    private func decode<Value: Decodable>(_ object: Any) throws -> Value {
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(Value.self, from: data)
    }
}
