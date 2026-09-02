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
