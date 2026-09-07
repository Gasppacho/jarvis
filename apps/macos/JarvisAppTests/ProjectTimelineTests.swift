import Foundation
import XCTest

@testable import JarvisCore

/// Ticket #61: the Project Timeline's pure grouping/ordering/row-content
/// value, built from fixed `TimelineEvent`/`TimelineExecution` fixtures — the
/// engine's own summaries for `GET /v1/projects/{projectId}/events` and
/// `/executions` (ticket #59) — with no running engine, per TESTING.md.
final class ProjectTimelineTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    // MARK: - Chronological ordering and correlation grouping

    func testGroupsByCorrelationAndOrdersGroupsByMostRecentActivity() {
        // corr-2's only row is older than anything in corr-1, so corr-1 must
        // sort first: grouping reads as one chronological, correlated story,
        // not two lists concatenated in fetch order.
        let corr1Request = makeEvent(
            id: "evt-request", occurredAt: t0, correlationId: "corr-1")
        let corr1Fact = makeEvent(
            id: "evt-fact", occurredAt: t0.addingTimeInterval(20), correlationId: "corr-1",
            kind: .fact, causationId: "evt-request")
        let corr2Request = makeEvent(
            id: "evt-other", occurredAt: t0.addingTimeInterval(5), correlationId: "corr-2")

        let presentation = ProjectTimelinePresentation(
            events: [corr1Fact, corr2Request, corr1Request],
            executions: [],
            isLoading: false,
            errorMessage: nil)

        XCTAssertEqual(presentation.status, .loaded)
        XCTAssertEqual(presentation.groups.map(\.id), ["corr-1", "corr-2"])
        // Within corr-1, cause before effect.
        XCTAssertEqual(presentation.groups[0].rows.map(\.id), ["event:evt-request", "event:evt-fact"])
    }

    func testGroupingIsStableWhenRowsShareATimestamp() {
        // Two rows in the same chain, minted at the same instant. Order must
        // not depend on input/array order: it always breaks the tie on id.
        let later = makeEvent(id: "evt-bbb", occurredAt: t0, correlationId: "corr-1")
        let earlier = makeEvent(id: "evt-aaa", occurredAt: t0, correlationId: "corr-1")

        let presentation = ProjectTimelinePresentation(
            events: [later, earlier], executions: [], isLoading: false, errorMessage: nil)

        XCTAssertEqual(presentation.groups.count, 1)
        XCTAssertEqual(
            presentation.groups[0].rows.map(\.id), ["event:evt-aaa", "event:evt-bbb"],
            "same-timestamp rows must sort by id, not by input order")

        // Reversing the input must not change the result.
        let reversed = ProjectTimelinePresentation(
            events: [earlier, later], executions: [], isLoading: false, errorMessage: nil)
        XCTAssertEqual(reversed.groups[0].rows.map(\.id), presentation.groups[0].rows.map(\.id))
    }

    // MARK: - Row content per kind

    func testRequestRowNamesKindModuleInstanceSubjectAndTime() {
        let event = makeEvent(
            id: "evt-1", occurredAt: t0, correlationId: "corr-1",
            kind: .request, producer: "github-connector", subjectRef: "issue-42",
            type: "scm.work-item.tag-added")

        let presentation = ProjectTimelinePresentation(
            events: [event], executions: [], isLoading: false, errorMessage: nil)
        let row = presentation.groups[0].rows[0]

        XCTAssertEqual(row.kind, .request)
        XCTAssertEqual(row.title, "scm.work-item.tag-added")
        XCTAssertEqual(row.moduleInstance, "github-connector")
        XCTAssertEqual(row.subject, "issue-42")
        XCTAssertEqual(row.occurredAt, t0)
        XCTAssertNil(row.executionStatus)
        XCTAssertNil(row.attempt)
    }

    func testFactRowNamesItsKind() {
        let event = makeEvent(id: "evt-1", occurredAt: t0, correlationId: "corr-1", kind: .fact)

        let presentation = ProjectTimelinePresentation(
            events: [event], executions: [], isLoading: false, errorMessage: nil)

        XCTAssertEqual(presentation.groups[0].rows[0].kind, .fact)
    }

    func testExecutionRowNamesModuleInstanceStateAndAttempt() {
        let execution = makeExecution(
            id: "exe-1", createdAt: t0, correlationId: "corr-1",
            moduleInstanceId: "development", status: .running, attempt: 2)

        let presentation = ProjectTimelinePresentation(
            events: [], executions: [execution], isLoading: false, errorMessage: nil)
        let row = presentation.groups[0].rows[0]

        XCTAssertEqual(row.kind, .execution)
        XCTAssertEqual(row.moduleInstance, "development")
        XCTAssertEqual(row.executionStatus, .running)
        XCTAssertEqual(row.attempt, 2)
        XCTAssertEqual(row.occurredAt, t0)
    }

    // MARK: - Completion (findings-review #61-7: `completedAt` is fetched but
    // was never used — a finished Execution's recency and display must
    // reflect it, not just its start)

    func testCompletedExecutionRowShowsWhenItFinished() {
        let completedAt = t0.addingTimeInterval(120)
        let execution = makeExecution(
            id: "exe-1", createdAt: t0, correlationId: "corr-1", status: .completed,
            completedAt: completedAt)

        let presentation = ProjectTimelinePresentation(
            events: [], executions: [execution], isLoading: false, errorMessage: nil)

        XCTAssertEqual(presentation.groups[0].rows[0].completedAt, completedAt)
    }

    func testStillRunningExecutionRowHasNoCompletionTime() {
        let execution = makeExecution(
            id: "exe-1", createdAt: t0, correlationId: "corr-1", status: .running)

        let presentation = ProjectTimelinePresentation(
            events: [], executions: [execution], isLoading: false, errorMessage: nil)

        XCTAssertNil(presentation.groups[0].rows[0].completedAt)
    }

    func testGroupRecencyReflectsAnExecutionsCompletionNotJustItsStart() {
        // corr-old's Execution started well before corr-new's chain, but
        // finished after it. A long-running Execution that just completed
        // must not read as the stale chain.
        let oldExecution = makeExecution(
            id: "exe-old", createdAt: t0, correlationId: "corr-old", status: .completed,
            completedAt: t0.addingTimeInterval(1000))
        let newEvent = makeEvent(
            id: "evt-new", occurredAt: t0.addingTimeInterval(500), correlationId: "corr-new")

        let presentation = ProjectTimelinePresentation(
            events: [newEvent], executions: [oldExecution], isLoading: false, errorMessage: nil)

        XCTAssertEqual(presentation.groups.map(\.id), ["corr-old", "corr-new"])
    }

    // MARK: - Linkage: use the API's own links, never re-derive them

    func testExecutionIsShownAgainstTheEventThatCausedIt() {
        let cause = makeEvent(
            id: "evt-cause", occurredAt: t0, correlationId: "corr-1",
            producer: "github-connector", subjectRef: "issue-42",
            type: "scm.work-item.tag-added")
        let execution = makeExecution(
            id: "exe-1", createdAt: t0.addingTimeInterval(1), correlationId: "corr-1",
            inputEventId: "evt-cause")

        let presentation = ProjectTimelinePresentation(
            events: [cause], executions: [execution], isLoading: false, errorMessage: nil)
        let executionRow = presentation.groups[0].rows.first { $0.kind == .execution }

        XCTAssertEqual(executionRow?.causingEvent?.id, "evt-cause")
        XCTAssertEqual(executionRow?.causingEvent?.type, "scm.work-item.tag-added")
        // The Execution has no subject of its own on the wire; it takes its
        // causing Event's, since it is always shown against that Event.
        XCTAssertEqual(executionRow?.subject, "issue-42")
    }

    func testExecutionWithNoResolvableCausingEventShowsNoLinkRatherThanGuessing() {
        // `inputEventId` points outside this snapshot (e.g. truncated by a
        // limit): never guessed from timestamp or Module Instance, just absent.
        let execution = makeExecution(
            id: "exe-1", createdAt: t0, correlationId: "corr-1", inputEventId: "evt-missing")

        let presentation = ProjectTimelinePresentation(
            events: [], executions: [execution], isLoading: false, errorMessage: nil)
        let row = presentation.groups[0].rows[0]

        XCTAssertNil(row.causingEvent)
        XCTAssertNil(row.subject)
    }

    func testCausedEventShowsItsParent() {
        let parent = makeEvent(
            id: "evt-parent", occurredAt: t0, correlationId: "corr-1",
            type: "scm.work-item.tag-added")
        let child = makeEvent(
            id: "evt-child", occurredAt: t0.addingTimeInterval(1), correlationId: "corr-1",
            kind: .fact, causationId: "evt-parent", type: "scm.change-request.created")

        let presentation = ProjectTimelinePresentation(
            events: [parent, child], executions: [], isLoading: false, errorMessage: nil)
        let childRow = presentation.groups[0].rows.first { $0.id == "event:evt-child" }

        XCTAssertEqual(childRow?.parentEvent?.id, "evt-parent")
        XCTAssertEqual(childRow?.parentEvent?.type, "scm.work-item.tag-added")
    }

    func testExecutionWithNoCorrelationIdFormsItsOwnGroupRatherThanCrashing() {
        // Pre-#59 shape: `correlationId` is optional on the wire.
        let execution = makeExecution(id: "exe-orphan", createdAt: t0, correlationId: nil)

        let presentation = ProjectTimelinePresentation(
            events: [], executions: [execution], isLoading: false, errorMessage: nil)

        XCTAssertEqual(presentation.groups.count, 1)
        XCTAssertEqual(presentation.groups[0].rows.map(\.id), ["execution:exe-orphan"])
    }

    // MARK: - Correlation header only for a real chain (findings-review #61-5)

    func testCorrelationChainGroupExposesItsRealCorrelationId() {
        let event = makeEvent(id: "evt-1", occurredAt: t0, correlationId: "corr-1")

        let presentation = ProjectTimelinePresentation(
            events: [event], executions: [], isLoading: false, errorMessage: nil)

        XCTAssertEqual(presentation.groups[0].correlationId, "corr-1")
    }

    func testOrphanExecutionGroupHasNoCorrelationIdEvenThoughItsGroupKeyLooksLikeOne() {
        // `group.id` is still the synthesized "execution:<id>" key so
        // SwiftUI's `ForEach` can identify it, but that key was never
        // reported by the engine and must never be shown as one.
        let execution = makeExecution(id: "exe-1", createdAt: t0, correlationId: nil)

        let presentation = ProjectTimelinePresentation(
            events: [], executions: [execution], isLoading: false, errorMessage: nil)

        XCTAssertEqual(presentation.groups[0].id, "execution:exe-1")
        XCTAssertNil(presentation.groups[0].correlationId)
    }

    // MARK: - Empty, loading and failure states

    func testNoEventsShowsAnExplicitEmptyStateNotAFailure() {
        let presentation = ProjectTimelinePresentation(
            events: [], executions: [], isLoading: false, errorMessage: nil)

        XCTAssertEqual(presentation.status, .empty)
        XCTAssertTrue(presentation.groups.isEmpty)
    }

    func testFirstLoadWithNothingCachedYetShowsTheFullPaneLoadingState() {
        // No previous snapshot exists yet, so there is nothing to keep on
        // screen: this is the one case `.loading` (not `.refreshing`) is
        // still correct.
        let presentation = ProjectTimelinePresentation(
            events: [], executions: [], isLoading: true, errorMessage: nil)

        XCTAssertEqual(presentation.status, .loading)
        XCTAssertTrue(presentation.groups.isEmpty)
    }

    // Findings-review #61-2: `refresh` sets `isLoading = true` while keeping
    // the cached rows (`ProjectTimelineModel.refresh`), but this struct used
    // to return `groups = []` for any `isLoading`, flashing a long Timeline
    // to empty and losing scroll position on every "Refresh Timeline" click.
    // Never a half-applied *new* snapshot (there is no partial-merge step —
    // `groups` is always built from one complete array pair) — so showing
    // the previous complete snapshot while a refresh is in flight is exactly
    // what must happen, not what the old test above's name warned against.
    func testRefreshingWithRowsAlreadyCachedKeepsThemOnScreenInsteadOfBlanking() {
        let cached = makeEvent(id: "evt-cached", occurredAt: t0, correlationId: "corr-1")

        let presentation = ProjectTimelinePresentation(
            events: [cached], executions: [], isLoading: true, errorMessage: nil)

        XCTAssertEqual(presentation.status, .refreshing)
        XCTAssertEqual(presentation.groups.map(\.id), ["corr-1"])
        XCTAssertEqual(presentation.groups[0].rows.map(\.id), ["event:evt-cached"])
    }

    func testAFailedFirstLoadWithNothingCachedShowsTheFullPaneFailure() {
        let presentation = ProjectTimelinePresentation(
            events: [], executions: [], isLoading: false,
            errorMessage: "The engine did not answer (GET /v1/projects/p/events returned 503).")

        XCTAssertEqual(
            presentation.status,
            .failed("The engine did not answer (GET /v1/projects/p/events returned 503)."))
        XCTAssertTrue(presentation.groups.isEmpty)
    }

    /// findings-review #62-4: a reload that failed after the Timeline already
    /// showed rows must not blank the screen — the last snapshot stays, with
    /// the engine's message surfaced alongside it (never the full-pane
    /// failure, which would lose the content). The intent of the original
    /// #61 test — "shows the engine's message" — is preserved in both halves
    /// of this split.
    func testAFailedReloadWithRowsCachedShowsThemAlongsideTheEnginesMessage() {
        let stale = makeEvent(id: "evt-stale", occurredAt: t0, correlationId: "corr-1")

        let presentation = ProjectTimelinePresentation(
            events: [stale], executions: [], isLoading: false,
            errorMessage: "The engine did not answer (GET /v1/projects/p/events returned 503).")

        XCTAssertEqual(
            presentation.status,
            .stale("The engine did not answer (GET /v1/projects/p/events returned 503)."))
        XCTAssertEqual(presentation.groups.map(\.id), ["corr-1"])
        guard let group = presentation.groups.first else { return }
        XCTAssertEqual(group.rows.map(\.id), ["event:evt-stale"])
    }

    // MARK: - Accessibility text

    func testRequestRowAccessibilityLabelNamesKindModuleInstanceSubjectAndTime() {
        let event = makeEvent(
            id: "evt-1", occurredAt: t0, correlationId: "corr-1",
            kind: .request, producer: "github-connector", subjectRef: "issue-42",
            type: "scm.work-item.tag-added")

        let presentation = ProjectTimelinePresentation(
            events: [event], executions: [], isLoading: false, errorMessage: nil)
        let label = presentation.groups[0].rows[0].accessibilityLabel

        XCTAssertTrue(label.contains("Request"))
        XCTAssertTrue(label.contains("scm.work-item.tag-added"))
        XCTAssertTrue(label.contains("github-connector"))
        XCTAssertTrue(label.contains("issue-42"))
    }

    func testExecutionRowAccessibilityLabelNamesStateAttemptAndCausingEvent() {
        let cause = makeEvent(
            id: "evt-cause", occurredAt: t0, correlationId: "corr-1",
            type: "scm.work-item.tag-added")
        let execution = makeExecution(
            id: "exe-1", createdAt: t0.addingTimeInterval(1), correlationId: "corr-1",
            moduleInstanceId: "development", status: .failed, attempt: 3,
            inputEventId: "evt-cause")

        let presentation = ProjectTimelinePresentation(
            events: [cause], executions: [execution], isLoading: false, errorMessage: nil)
        let row = presentation.groups[0].rows.first { $0.kind == .execution }!

        XCTAssertTrue(row.accessibilityLabel.contains("development"))
        XCTAssertTrue(row.accessibilityLabel.contains("attempt 3"))
        XCTAssertTrue(row.accessibilityLabel.lowercased().contains("failed"))
        XCTAssertTrue(row.accessibilityLabel.contains("scm.work-item.tag-added"))
    }

    // Findings-review #61-3: the accessibility label used to format
    // `occurredAt` with `ISO8601DateFormatter().string(from:)` (UTC), while
    // the visible row renders `.dateTime` in the user's locale/time zone
    // (`ProjectTimelineView.rowView`). VoiceOver must announce the same
    // instant the screen shows.
    func testRequestRowAccessibilityLabelAnnouncesTheSameInstantTheVisibleRowDisplays() {
        let event = makeEvent(id: "evt-1", occurredAt: t0, correlationId: "corr-1")

        let presentation = ProjectTimelinePresentation(
            events: [event], executions: [], isLoading: false, errorMessage: nil)
        let row = presentation.groups[0].rows[0]

        XCTAssertTrue(
            row.accessibilityLabel.contains(t0.formatted(.dateTime)),
            "expected the same locale/time-zone rendering `Text(row.occurredAt, format: .dateTime)` produces, not UTC ISO-8601"
        )
    }

    func testCompletedExecutionRowAccessibilityLabelAnnouncesWhenItFinished() {
        let completedAt = t0.addingTimeInterval(60)
        let execution = makeExecution(
            id: "exe-1", createdAt: t0, correlationId: "corr-1", status: .completed,
            completedAt: completedAt)

        let presentation = ProjectTimelinePresentation(
            events: [], executions: [execution], isLoading: false, errorMessage: nil)
        let row = presentation.groups[0].rows[0]

        XCTAssertTrue(row.accessibilityLabel.contains(completedAt.formatted(.dateTime)))
    }

    // MARK: - Fixtures

    private func makeEvent(
        id: String,
        occurredAt: Date,
        correlationId: String,
        kind: TimelineEvent.Kind = .request,
        producer: String = "development",
        subjectRef: String? = nil,
        causationId: String? = nil,
        type: String = "scm.work-item.tag-added"
    ) -> TimelineEvent {
        TimelineEvent(
            id: id, type: type, kind: kind, occurredAt: occurredAt, producer: producer,
            correlationId: correlationId, causationId: causationId, subjectRef: subjectRef)
    }

    private func makeExecution(
        id: String,
        createdAt: Date,
        correlationId: String?,
        moduleInstanceId: String = "development",
        status: TimelineExecution.Status = .running,
        attempt: Int = 1,
        completedAt: Date? = nil,
        inputEventId: String? = nil
    ) -> TimelineExecution {
        TimelineExecution(
            id: id, projectId: "proj-1", moduleInstanceId: moduleInstanceId, status: status,
            attempt: attempt, createdAt: createdAt, completedAt: completedAt,
            inputEventId: inputEventId, correlationId: correlationId)
    }
}

/// Ticket #61: `ProjectTimelineModel.refresh`'s own state transitions —
/// cancellation in particular — via the `provider` test seam (mirrors
/// `ProjectConfigurationModel.ValidationReportProvider`), with no running
/// engine, per TESTING.md.
@MainActor
final class ProjectTimelineModelTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    // Findings-review #61-6: `.task(id:)` cancels on every Project (or tab)
    // switch. The `catch` used to treat `CancellationError` like any other
    // failure, so switching away mid-fetch always wrote "The Timeline could
    // not be loaded…" into that Project's cached state — invisible today
    // because it's overwritten on return, but exactly what #62's
    // rehydration would read: a failure that never happened.
    func testCancelledRefreshLeavesNoFailureBehindAndKeepsThePreviousSnapshot() async throws {
        let session = EngineSessionModel(
            supervisor: EngineSupervisor(resources: .developmentBuild()))
        let calls = CallCounter()
        let cachedEvent = TimelineEvent(
            id: "evt-1", type: "scm.work-item.tag-added", kind: .request, occurredAt: t0,
            producer: "development", correlationId: "corr-1")

        let model = ProjectTimelineModel(session: session) { _ in
            if await calls.next() == 1 {
                return (events: [cachedEvent], executions: [])
            }
            // Long enough to still be sleeping when the test cancels it.
            try await Task.sleep(nanoseconds: 2_000_000_000)
            return (events: [], executions: [])
        }

        // A first, uncancelled refresh populates the cached snapshot.
        await model.refresh(projectId: "proj-1")
        XCTAssertEqual(model.state(for: "proj-1").events.map(\.id), ["evt-1"])

        // A second refresh, cancelled mid-flight.
        let task = Task { await model.refresh(projectId: "proj-1") }
        try await Task.sleep(nanoseconds: 50_000_000)
        task.cancel()
        await task.value

        let state = model.state(for: "proj-1")
        XCTAssertNil(
            state.errorMessage, "a cancelled fetch must not be recorded as an engine failure")
        XCTAssertFalse(state.isLoading)
        XCTAssertEqual(
            state.events.map(\.id), ["evt-1"],
            "the previous complete snapshot must survive a cancelled refresh untouched")
    }
}

private actor CallCounter {
    private var count = 0
    func next() -> Int {
        count += 1
        return count
    }
}
