import Foundation
import JarvisAPI
import XCTest

@testable import JarvisCore

final class ProjectResourceGuidanceTests: XCTestCase {
    func testResourceInventoryListsOnlyEligibleChoicesAndExplainsRepairStates() throws {
        let configuration = try decodePortableConfiguration([
            "apiVersion": "jarvis.dev/project/v1",
            "kind": "Project",
            "metadata": ["id": "guided", "name": "Guided"],
            "repositories": [[
                "id": "main", "root": ".", "defaultBranch": "main", "remote": "origin",
            ]],
            "slots": [
                "sourceControl": ["requires": "scm.change-request.manage"],
                "agentRuntime": ["requires": "agent.execute"],
                "tickets": ["requires": "work-items.read"],
                "artifacts": ["requires": "artifact.write"],
            ],
            "commands": [:],
            "git": [
                "branchPattern": "agent/{workItemId}-{slug}",
                "commitStrategy": "conventional", "pushRemote": "origin",
                "allowForcePush": false,
            ],
            "workspace": [
                "strategy": "git-worktree", "maxConcurrentExecutions": 1,
                "retainOnFailureDays": 1,
            ],
            "modules": [[
                "instanceId": "development", "moduleId": "jarvis.module.development",
                "enabled": true, "runtimeSlot": "agentRuntime",
                "bindings": ["tickets": "tickets", "sourceControl": "sourceControl"],
            ]],
        ])
        let github = try candidate(
            ref: "connection/github", kind: "connection", displayName: "GitHub",
            capabilities: ["scm.change-request.manage", "github.api"])
        let runtime = try candidate(
            ref: "runtime/local", kind: "runtime", displayName: "Local Agent",
            capabilities: ["agent.execute"])
        let tickets = try candidate(
            ref: "connection/issues", kind: "connection", displayName: "Issues",
            capabilities: ["work-items.read"])

        var state = ProjectConfigurationState()
        state.draft = ProjectConfigurationDraft(configuration: configuration, packages: [])
        state.candidates = [github, runtime, tickets]
        state.localBindings = try localBindings(slots: [
            "sourceControl": ["kind": "connection", "ref": "connection/github"],
            "tickets": ["kind": "connection", "ref": "connection/removed"],
        ])
        state.resourceChoices = [
            ProjectResourceBindingChoice(
                slotId: "sourceControl",
                requiredCapabilities: ["github.api", "scm.change-request.manage"],
                candidates: [github], status: .bound,
                impact: "Development needs this source-control capability.",
                repairAction: "Choose another eligible Project resource."),
            ProjectResourceBindingChoice(
                slotId: "agentRuntime", requiredCapabilities: ["agent.execute"],
                candidates: [runtime], status: .available,
                impact: "Development cannot execute without an Agent Runtime.",
                repairAction: "Choose Local Agent."),
            ProjectResourceBindingChoice(
                slotId: "tickets", requiredCapabilities: ["work-items.read"],
                candidates: [tickets], status: .inaccessible,
                impact: "Development cannot read Work Items.",
                repairAction: "Restore Project access or choose Issues."),
            ProjectResourceBindingChoice(
                slotId: "artifacts", requiredCapabilities: ["artifact.write"],
                candidates: [], status: .missing,
                impact: "Artifact publishing is unavailable.",
                repairAction: "Grant a compatible resource to this Project, then reload."),
        ]

        let presentation = ProjectDetailPresentation(
            project: Project(id: "guided", name: "Guided", status: .draft,
                             moduleCount: 1, activeExecutions: 0),
            detail: nil, state: state, packages: [])

        XCTAssertEqual(presentation.resourceBindings.map(\.id), [
            "agentRuntime", "artifacts", "sourceControl", "tickets",
        ])
        let sourceControl = try XCTUnwrap(
            presentation.resourceBindings.first { $0.id == "sourceControl" })
        XCTAssertEqual(sourceControl.status, .bound)
        XCTAssertEqual(sourceControl.candidates.map(\.id), [github.id])
        XCTAssertFalse(sourceControl.accessibilityLabel.isEmpty)
        XCTAssertTrue(sourceControl.accessibilityHint.contains("Development"))

        let inaccessible = try XCTUnwrap(
            presentation.resourceBindings.first { $0.id == "tickets" })
        XCTAssertEqual(inaccessible.status, .inaccessible)
        XCTAssertTrue(inaccessible.unavailableExplanation.contains("no longer accessible"))
        XCTAssertTrue(inaccessible.repairAction.contains("Restore"))

        let missing = try XCTUnwrap(
            presentation.resourceBindings.first { $0.id == "artifacts" })
        XCTAssertEqual(missing.status, .missing)
        XCTAssertTrue(missing.unavailableExplanation.contains("artifact.write"))
        XCTAssertTrue(missing.repairAction.contains("Grant"))
        XCTAssertFalse(missing.impact.isEmpty)
    }

    func testSlotInspectorDerivesRequestersAndCapabilityOptionsFromDraftAndCatalog() throws {
        let configuration = try decodePortableConfiguration([
            "apiVersion": "jarvis.dev/project/v1",
            "kind": "Project",
            "metadata": ["id": "inspector", "name": "Inspector"],
            "repositories": [],
            "slots": [
                "sourceControl": ["requires": "capability.source"],
                "agentRuntime": ["requires": "capability.runtime"],
            ],
            "commands": [:],
            "git": [
                "branchPattern": "agent/{workItemId}-{slug}",
                "commitStrategy": "conventional", "pushRemote": "origin",
                "allowForcePush": false,
            ],
            "workspace": [
                "strategy": "git-worktree", "maxConcurrentExecutions": 1,
                "retainOnFailureDays": 1,
            ],
            "modules": [
                [
                    "instanceId": "change-provider", "moduleId": "module.change",
                    "enabled": true, "bindings": ["source": "sourceControl"],
                ],
                [
                    "instanceId": "local-runner", "moduleId": "module.runner",
                    "enabled": true, "runtimeSlot": "agentRuntime", "bindings": [:],
                ],
            ],
        ])
        let packages = [
            try modulePackage(
                id: "module.change", name: "Change Provider",
                description: "Publishes source-control changes.",
                requires: ["capability.shared", "capability.source"]),
            try modulePackage(
                id: "module.runner", name: "Local Runner",
                description: "Runs work on this Mac.",
                requires: ["capability.runtime", "capability.shared"]),
        ]
        var state = ProjectConfigurationState()
        state.draft = ProjectConfigurationDraft(configuration: configuration, packages: packages)
        state.resourceChoices = [
            ProjectResourceBindingChoice(
                slotId: "sourceControl",
                requiredCapabilities: ["capability.source"],
                candidates: [], status: .missing,
                impact: "Changes cannot be published.",
                repairAction: "Grant a source-control resource."),
            ProjectResourceBindingChoice(
                slotId: "agentRuntime",
                requiredCapabilities: ["capability.runtime"],
                candidates: [], status: .incompatible,
                impact: "Work cannot run.",
                repairAction: "Grant a compatible runtime."),
        ]

        let presentation = ProjectDetailPresentation(
            project: Project(id: "inspector", name: "Inspector", status: .draft,
                             moduleCount: 2, activeExecutions: 0),
            detail: nil, state: state, packages: packages)

        XCTAssertEqual(presentation.capabilityOptions, [
            "capability.runtime", "capability.shared", "capability.source",
        ])
        let sourceControl = try XCTUnwrap(presentation.slots.first { $0.id == "sourceControl" })
        XCTAssertEqual(sourceControl.requesters.map(\.instanceId), ["change-provider"])
        XCTAssertEqual(sourceControl.requesters.map(\.displayName), ["Change Provider"])
        XCTAssertEqual(
            sourceControl.requesters.map(\.description),
            ["Publishes source-control changes."])
        let runtime = try XCTUnwrap(presentation.slots.first { $0.id == "agentRuntime" })
        XCTAssertEqual(runtime.requesters.map(\.instanceId), ["local-runner"])
        XCTAssertEqual(runtime.requesters.map(\.displayName), ["Local Runner"])
        XCTAssertEqual(runtime.requesters.map(\.description), ["Runs work on this Mac."])
        let sourceBinding = try XCTUnwrap(
            presentation.resourceBindings.first { $0.id == "sourceControl" })
        XCTAssertEqual(sourceBinding.requesters, sourceControl.requesters)
        let runtimeBinding = try XCTUnwrap(
            presentation.resourceBindings.first { $0.id == "agentRuntime" })
        XCTAssertEqual(runtimeBinding.requesters, runtime.requesters)
    }

    func testResourceInspectorPresentsEngineGuidanceAndEveryReportedStatus() throws {
        let statuses: [ProjectResourceBindingStatus] = [
            .bound, .available, .missing, .inaccessible, .incompatible,
        ]
        var state = ProjectConfigurationState()
        state.resourceChoices = statuses.map { status in
            ProjectResourceBindingChoice(
                slotId: status.rawValue,
                requiredCapabilities: ["capability.\(status.rawValue)"],
                candidates: [],
                status: status,
                impact: "Impact reported for \(status.rawValue).",
                repairAction: "Repair reported for \(status.rawValue).")
        }

        let presentation = ProjectDetailPresentation(
            project: Project(id: "statuses", name: "Statuses", status: .draft,
                             moduleCount: 0, activeExecutions: 0),
            detail: nil, state: state, packages: [])

        XCTAssertEqual(
            presentation.resourceBindings.map(\.statusLabel),
            statuses.map(\.rawValue).sorted())
        for resource in presentation.resourceBindings {
            XCTAssertEqual(resource.impact, "Impact reported for \(resource.statusLabel).")
            XCTAssertEqual(resource.repairAction, "Repair reported for \(resource.statusLabel).")
            XCTAssertTrue(resource.emptyCandidateExplanation.contains(resource.statusLabel))
            // The repair action is rendered on its own row; the empty-candidate explanation must
            // not repeat it, or an unresolved Slot states the same next action twice.
            XCTAssertFalse(resource.emptyCandidateExplanation.contains(resource.repairAction))
        }
    }

    private func modulePackage(
        id: String, name: String, description: String, requires: [String]
    ) throws -> ModulePackage {
        let data = try JSONSerialization.data(withJSONObject: [
            "moduleId": id,
            "version": "1.0.0",
            "displayName": name,
            "description": description,
            "categories": [],
            "consumes": [],
            "produces": [],
            "requires": requires,
            "provides": [],
            "configurationSchemaRef": "fixture.schema.json",
            "configurationSchema": ["type": "object", "properties": [:]],
        ])
        return ModulePackage(
            payload: try JSONDecoder().decode(Components.Schemas.ModulePackage.self, from: data))
    }

    private func candidate(
        ref: String, kind: String, displayName: String, capabilities: [String]
    ) throws -> ProjectResourceCandidate {
        let data = try JSONSerialization.data(withJSONObject: [
            "ref": ref, "kind": kind, "displayName": displayName,
            "capabilities": capabilities,
        ])
        return ProjectResourceCandidate(
            payload: try JSONDecoder().decode(
                Components.Schemas.ProjectResourceCandidate.self, from: data))
    }

    private func decodePortableConfiguration(
        _ document: [String: Any]
    ) throws -> Components.Schemas.PortableProjectConfiguration {
        try JSONDecoder().decode(
            Components.Schemas.PortableProjectConfiguration.self,
            from: JSONSerialization.data(withJSONObject: document))
    }

    private func localBindings(
        slots: [String: [String: String]]
    ) throws -> LocalProjectBindings {
        let data = try JSONSerialization.data(withJSONObject: [
            "apiVersion": "jarvis.dev/project-bindings/v1",
            "kind": "ProjectBindings",
            "projectId": "guided",
            "repositories": ["main": ["path": "/tmp/guided", "bookmarkRef": NSNull()]],
            "slots": slots,
        ])
        return LocalProjectBindings(
            payload: try JSONDecoder().decode(Components.Schemas.ProjectBindings.self, from: data))
    }
}
