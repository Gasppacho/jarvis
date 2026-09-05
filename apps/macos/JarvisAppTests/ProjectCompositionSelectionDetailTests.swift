import Foundation
import JarvisAPI
import XCTest

@testable import JarvisCore

/// Asserts #52's selection detail: a pure projection from a row's or rail
/// entry's unique id (qualified by Module Instance, role and index, as
/// `ProjectCompositionOutlineTests` establishes) to its stable identifiers,
/// contract version, routing status and applicable findings - read from
/// `ProjectCompositionGraph` (#49) as-is, never recomputed. Also asserts the
/// Project Detail read-only surface (a saved Project with no Draft open,
/// `ProjectConfigurationState.isDraftSaved == true`) derives its composition
/// from the exact same model the Wizard uses while mid-edit.
final class ProjectCompositionSelectionDetailTests: XCTestCase {
    // MARK: - Valid composition: Module Instance, produced/consumed contract, rail entry

    func testValidCompositionSelectionDetailPerRowKind() throws {
        let outline = try ProjectCompositionOutline(graph: decodeGraph(Self.boundFixture))

        let moduleInstance = try XCTUnwrap(outline.selectionDetail(forID: "instance:automation-rules"))
        XCTAssertEqual(moduleInstance.kind, .moduleInstance)
        XCTAssertEqual(moduleInstance.instanceId, "automation-rules")
        XCTAssertEqual(moduleInstance.moduleId, "jarvis.module.automation-rules")
        XCTAssertEqual(moduleInstance.statusLabel, "Enabled")
        XCTAssertEqual(moduleInstance.findings, [])

        let produced = try XCTUnwrap(
            outline.selectionDetail(forID: "instance:automation-rules:contract:produced:0"))
        XCTAssertEqual(produced.kind, .producedContract)
        XCTAssertEqual(produced.instanceId, "automation-rules")
        XCTAssertEqual(produced.contractType, "development.implementation.requested")
        XCTAssertEqual(produced.contractVersion, 1)
        XCTAssertEqual(produced.statusLabel, "Resolved → request-worker")
        XCTAssertEqual(produced.findings, [])

        let consumed = try XCTUnwrap(
            outline.selectionDetail(forID: "instance:request-worker:contract:consumed:0"))
        XCTAssertEqual(consumed.kind, .consumedContract)
        XCTAssertEqual(consumed.instanceId, "request-worker")
        XCTAssertEqual(consumed.contractType, "development.implementation.requested")
        XCTAssertEqual(consumed.contractVersion, 1)
        XCTAssertEqual(consumed.statusLabel, "Resolved → request-worker")

        let rail = try XCTUnwrap(outline.selectionDetail(forID: "slot:tickets:0"))
        XCTAssertEqual(rail.kind, .railEntry)
        XCTAssertNil(rail.instanceId)
        XCTAssertEqual(rail.slot, "tickets")
        XCTAssertEqual(rail.capability, "work-items.read")
        XCTAssertEqual(rail.bindingRef, "module-instance/request-worker")
        XCTAssertEqual(rail.statusLabel, "bound")
        XCTAssertEqual(rail.findings, [])
    }

    // MARK: - Incomplete composition: orphaned request, disabled instance, capability row

    func testIncompleteCompositionSelectionDetailCarriesFindings() throws {
        let outline = try ProjectCompositionOutline(graph: decodeGraph(Self.incompleteFixture))

        let disabled = try XCTUnwrap(outline.selectionDetail(forID: "instance:github"))
        XCTAssertEqual(disabled.kind, .moduleInstance)
        XCTAssertEqual(disabled.statusLabel, "Disabled")

        let orphaned = try XCTUnwrap(
            outline.selectionDetail(forID: "instance:automation-rules:contract:produced:0"))
        XCTAssertEqual(orphaned.kind, .producedContract)
        XCTAssertEqual(orphaned.statusLabel, "Orphaned — no consumer")
        XCTAssertEqual(orphaned.findings, ["project.request-orphaned"])

        let capability = try XCTUnwrap(outline.selectionDetail(forID: "instance:github:capability:0"))
        XCTAssertEqual(capability.kind, .capability)
        XCTAssertEqual(capability.instanceId, "github")
        XCTAssertEqual(capability.capability, "github.api")
        XCTAssertEqual(capability.statusLabel, "unresolved")
        XCTAssertEqual(capability.findings, ["project.capability-unresolved"])

        let unresolvedRail = try XCTUnwrap(outline.selectionDetail(forID: "slot:sourceControl:0"))
        XCTAssertEqual(unresolvedRail.findings, ["project.binding-missing"])
        XCTAssertNil(unresolvedRail.bindingRef)
    }

    // MARK: - Ambiguous composition: candidates named in the status label

    func testAmbiguousCompositionSelectionDetailNamesCandidates() throws {
        let outline = try ProjectCompositionOutline(graph: decodeGraph(Self.ambiguousFixture))

        let ambiguous = try XCTUnwrap(
            outline.rows.first { $0.instanceId == "development" && $0.direction == .produced })
        let detail = try XCTUnwrap(outline.selectionDetail(forID: ambiguous.id))
        XCTAssertEqual(detail.kind, .producedContract)
        XCTAssertEqual(detail.statusLabel, "Ambiguous — github, github-secondary")
        XCTAssertEqual(detail.findings, ["project.request-ambiguous"])
    }

    // MARK: - Mission gates

    func testUnknownOrStaleRowIDYieldsNoDetail() throws {
        let outline = try ProjectCompositionOutline(graph: decodeGraph(Self.boundFixture))

        XCTAssertNil(outline.selectionDetail(forID: "instance:does-not-exist"))
        XCTAssertNil(outline.selectionDetail(forID: "slot:removed-slot:0"))
        // A stale id from a previous, denser composition must not crash a
        // lookup against a since-refreshed, smaller graph.
        XCTAssertNil(outline.selectionDetail(forID: "instance:automation-rules:contract:produced:99"))
    }

    func testEveryRowAndRailIDStaysUniqueAndHasADetail() throws {
        let outline = try ProjectCompositionOutline(graph: decodeGraph(Self.ambiguousFixture))
        let allIDs = outline.rows.map(\.id) + outline.rail.map(\.id)
        XCTAssertEqual(allIDs.count, Set(allIDs).count, "row and rail ids must be unique")
        for id in allIDs {
            XCTAssertNotNil(outline.selectionDetail(forID: id), "every row must resolve a detail")
        }
    }

    @MainActor
    func testReadOnlySurfaceDerivesCompositionFromTheSameModelAsTheWizard() throws {
        let graph = try decodeGraph(Self.boundFixture)
        let project = Project(
            id: "outline-fixture", name: "Outline Fixture", status: .draft,
            moduleCount: 2, activeExecutions: 0)

        var editing = ProjectConfigurationState()
        editing.compositionGraph = graph
        editing.isDraftSaved = false

        var readOnly = ProjectConfigurationState()
        readOnly.compositionGraph = graph
        readOnly.isDraftSaved = true

        let wizardPresentation = ProjectDetailPresentation(
            project: project, detail: nil, state: editing, packages: [])
        let readOnlyPresentation = ProjectDetailPresentation(
            project: project, detail: nil, state: readOnly, packages: [])

        XCTAssertNotNil(readOnlyPresentation.compositionOutline)
        XCTAssertEqual(
            wizardPresentation.compositionOutline, readOnlyPresentation.compositionOutline,
            "the read-only surface (isDraftSaved == true, no Draft open) must render the same "
                + "ProjectCompositionOutline the Wizard renders while a Draft edit is in progress")
    }

    // MARK: - Decoding helper

    private func decodeGraph(_ json: String) throws -> ProjectCompositionGraph {
        let payload = try JSONDecoder().decode(
            Components.Schemas.ProjectCompositionGraphV1.self,
            from: Data(json.utf8))
        return ProjectCompositionGraph(payload: payload)
    }

    private static let boundFixture = """
        {
          "apiVersion": "jarvis.dev/project-composition-graph/v1",
          "kind": "ProjectCompositionGraph",
          "projectId": "outline-fixture",
          "nodes": [
            {"instanceId":"automation-rules","moduleId":"jarvis.module.automation-rules","enabled":true,"moduleVersion":"1.0.0","displayName":"Automation Rules","findings":[]},
            {"instanceId":"request-worker","moduleId":"jarvis.module.change-request-review","enabled":true,"moduleVersion":"1.0.0","displayName":"Request Worker","findings":[]}
          ],
          "edges": [
            {
              "kind":"request",
              "contract":{"type":"development.implementation.requested","version":1,"kind":"request"},
              "from":{"instanceId":"automation-rules","moduleId":"jarvis.module.automation-rules"},
              "to":{"instanceId":"request-worker","moduleId":"jarvis.module.change-request-review"},
              "routing":{"status":"resolved","consumer":{"instanceId":"request-worker","moduleId":"jarvis.module.change-request-review"}},
              "findings":[]
            }
          ],
          "rail": [
            {"kind":"slot","slot":"tickets","capability":"work-items.read","binding":{"kind":"module-instance","ref":"request-worker"},"state":"bound","findings":[]}
          ],
          "findings": []
        }
        """

    private static let incompleteFixture = """
        {
          "apiVersion": "jarvis.dev/project-composition-graph/v1",
          "kind": "ProjectCompositionGraph",
          "projectId": "outline-fixture",
          "nodes": [
            {"instanceId":"automation-rules","moduleId":"jarvis.module.automation-rules","enabled":true,"moduleVersion":"1.0.0","displayName":"Automation Rules","findings":[]},
            {"instanceId":"github","moduleId":"jarvis.module.github","enabled":false,"moduleVersion":"1.0.0","displayName":"GitHub","findings":[]}
          ],
          "edges": [
            {
              "kind":"request",
              "contract":{"type":"development.implementation.requested","version":1,"kind":"request"},
              "from":{"instanceId":"automation-rules","moduleId":"jarvis.module.automation-rules"},
              "routing":{"status":"orphaned"},
              "findings":["project.request-orphaned"]
            }
          ],
          "rail": [
            {"kind":"slot","slot":"sourceControl","capability":"repository.write","state":"unresolved","findings":["project.binding-missing"]},
            {"kind":"slot","slot":"tickets","capability":"work-items.read","state":"unbound","findings":[]},
            {"kind":"module-instance","instanceId":"github","capability":"github.api","state":"unresolved","findings":["project.capability-unresolved"]}
          ],
          "findings": []
        }
        """

    private static let ambiguousFixture = """
        {
          "apiVersion": "jarvis.dev/project-composition-graph/v1",
          "kind": "ProjectCompositionGraph",
          "projectId": "outline-fixture",
          "nodes": [
            {"instanceId":"automation-rules","moduleId":"jarvis.module.automation-rules","enabled":true,"moduleVersion":"1.0.0","displayName":"Automation Rules","findings":[]},
            {"instanceId":"development","moduleId":"jarvis.module.development","enabled":true,"moduleVersion":"1.0.0","displayName":"Development","findings":[]},
            {"instanceId":"github","moduleId":"jarvis.module.github","enabled":true,"moduleVersion":"1.0.0","displayName":"GitHub","findings":[]},
            {"instanceId":"github-secondary","moduleId":"jarvis.module.github","enabled":true,"moduleVersion":"1.0.0","displayName":"GitHub","findings":[]}
          ],
          "edges": [
            {
              "kind":"request",
              "contract":{"type":"development.implementation.requested","version":1,"kind":"request"},
              "from":{"instanceId":"automation-rules","moduleId":"jarvis.module.automation-rules"},
              "to":{"instanceId":"development","moduleId":"jarvis.module.development"},
              "routing":{"status":"resolved","consumer":{"instanceId":"development","moduleId":"jarvis.module.development"}},
              "findings":[]
            },
            {
              "kind":"request",
              "contract":{"type":"scm.change-request.creation-requested","version":1,"kind":"request"},
              "from":{"instanceId":"development","moduleId":"jarvis.module.development"},
              "routing":{"status":"ambiguous","candidates":[{"instanceId":"github","moduleId":"jarvis.module.github"},{"instanceId":"github-secondary","moduleId":"jarvis.module.github"}]},
              "findings":["project.request-ambiguous"]
            },
            {
              "kind":"fact",
              "contract":{"type":"scm.work-item.tag-added","version":1,"kind":"fact"},
              "from":{"instanceId":"github","moduleId":"jarvis.module.github"},
              "to":{"instanceId":"automation-rules","moduleId":"jarvis.module.automation-rules"},
              "findings":[]
            },
            {
              "kind":"fact",
              "contract":{"type":"scm.work-item.tag-added","version":1,"kind":"fact"},
              "from":{"instanceId":"github-secondary","moduleId":"jarvis.module.github"},
              "to":{"instanceId":"automation-rules","moduleId":"jarvis.module.automation-rules"},
              "findings":[]
            }
          ],
          "rail": [],
          "findings": []
        }
        """
}
