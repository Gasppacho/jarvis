import Foundation
import JarvisAPI
import XCTest

@testable import JarvisCore

/// Asserts the mapping from the composition graph read model (#49) to the
/// hierarchical outline #50 retained (docs/product/UX.md → "Graphe émergent"
/// → "Représentation retenue"). Every fixture below is decoded through the
/// generated `ProjectCompositionGraphV1` type exactly as the Local API would
/// answer it; nothing here recomputes a consumer, a compatibility decision
/// or a routing status.
final class ProjectCompositionOutlineTests: XCTestCase {
    // MARK: - Bound / valid composition

    func testResolvedRequestAndBoundRailReadAsTextWithStableIdentifiers() throws {
        let outline = try ProjectCompositionOutline(graph: decodeGraph(Self.boundFixture))

        XCTAssertEqual(
            outline.rows.map(\.id),
            [
                "instance:automation-rules",
                "instance:automation-rules:contract:produced:0",
                "instance:request-worker",
                "instance:request-worker:contract:consumed:0",
            ])
        XCTAssertEqual(outline.rows.map(\.depth), [0, 1, 0, 1])
        XCTAssertEqual(outline.rows.map(\.role), [.moduleInstance, .contract, .moduleInstance, .contract])

        let produced = outline.rows[1]
        XCTAssertEqual(produced.direction, .produced)
        XCTAssertEqual(produced.contractVersion, 1)
        XCTAssertEqual(produced.statusLabel, "Resolved → request-worker")
        XCTAssertEqual(produced.findings, [])

        let consumed = outline.rows[3]
        XCTAssertEqual(consumed.direction, .consumed)
        XCTAssertEqual(consumed.contractVersion, 1)
        // Routing status is the same text regardless of which side reads it -
        // Swift never recomputes it per perspective.
        XCTAssertEqual(consumed.statusLabel, "Resolved → request-worker")

        XCTAssertEqual(outline.rail.map(\.id), ["slot:tickets:0"])
        XCTAssertEqual(outline.rail[0].statusLabel, "bound")
        XCTAssertEqual(outline.rail[0].bindingRef, "module-instance/request-worker")
        XCTAssertEqual(outline.rail[0].findings, [])
    }

    // MARK: - Incomplete composition: orphaned request, disabled node, unresolved/unbound rail

    func testOrphanedRequestDisabledInstanceAndRailStatesReadAsText() throws {
        let outline = try ProjectCompositionOutline(graph: decodeGraph(Self.incompleteFixture))

        let github = try XCTUnwrap(
            outline.rows.first { $0.role == .moduleInstance && $0.instanceId == "github" })
        XCTAssertEqual(github.statusLabel, "Disabled")

        let orphaned = try XCTUnwrap(outline.rows.first { $0.role == .contract })
        XCTAssertEqual(orphaned.instanceId, "automation-rules")
        XCTAssertEqual(orphaned.direction, .produced)
        XCTAssertEqual(orphaned.statusLabel, "Orphaned — no consumer")
        XCTAssertEqual(orphaned.findings, ["project.request-orphaned"])

        let capability = try XCTUnwrap(outline.rows.first { $0.role == .capability })
        XCTAssertEqual(capability.instanceId, "github")
        XCTAssertEqual(capability.statusLabel, "unresolved")
        XCTAssertEqual(capability.findings, ["project.capability-unresolved"])

        let railStates = Dictionary(uniqueKeysWithValues: outline.rail.map { ($0.slot, $0.statusLabel) })
        XCTAssertEqual(railStates["sourceControl"], "unresolved")
        XCTAssertEqual(railStates["tickets"], "unbound")
        let unresolvedRail = try XCTUnwrap(outline.rail.first { $0.slot == "sourceControl" })
        XCTAssertEqual(unresolvedRail.findings, ["project.binding-missing"])
        let unboundRail = try XCTUnwrap(outline.rail.first { $0.slot == "tickets" })
        XCTAssertEqual(unboundRail.findings, [])
        XCTAssertNil(unboundRail.bindingRef)
    }

    // MARK: - Ambiguous composition: candidate names, and MISSION-0016's duplicate-row regression

    func testAmbiguousCandidatesAndDuplicatedContractAcrossInstancesStayUniqueAndOrdered() throws {
        let outline = try ProjectCompositionOutline(graph: decodeGraph(Self.ambiguousFixture))

        // Row ordering follows the read model: node order, then each node's
        // edges in the order the graph provided them - no re-sorting.
        XCTAssertEqual(
            outline.rows.map(\.instanceId),
            [
                "automation-rules", "automation-rules", "automation-rules", "automation-rules",
                "development", "development", "development",
                "github", "github",
                "github-secondary", "github-secondary",
            ])

        let ambiguous = try XCTUnwrap(
            outline.rows.first {
                $0.instanceId == "development" && $0.direction == .produced
            })
        XCTAssertEqual(ambiguous.statusLabel, "Ambiguous — github, github-secondary")
        XCTAssertEqual(ambiguous.findings, ["project.request-ambiguous"])

        // MISSION-0016 regression: the same fact contract broadcasts from two
        // different Module Instances to the same consumer. Every row id in the
        // whole outline must stay unique even though the contract repeats.
        let broadcastRows = outline.rows.filter { $0.role == .contract && $0.direction == .produced }
        XCTAssertEqual(broadcastRows.filter { $0.statusLabel == "Broadcast → automation-rules" }.count, 2)

        let allIds = outline.rows.map(\.id) + outline.rail.map(\.id)
        XCTAssertEqual(allIds.count, Set(allIds).count, "row ids must be unique across the whole list")
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
