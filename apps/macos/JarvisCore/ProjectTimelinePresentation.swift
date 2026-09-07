import Foundation

/// Ticket #61: the Project's durable truth — Events and Executions from
/// ticket #59's journal and ledger — read as one chronological, correlated
/// timeline. Pure and data-driven, like `ProjectDetailPresentation`, because
/// `JarvisAppTests` cannot import `JarvisApp` (TESTING.md).
public struct ProjectTimelinePresentation: Sendable, Equatable {
    public enum Status: Sendable, Equatable {
        case loading
        /// Loaded at least once; a refresh is in flight over that previous,
        /// complete snapshot (still in `groups`). Distinct from `.loading` so
        /// the view keeps the rows on screen instead of blanking them —
        /// findings-review #61-2: a refresh must never flash a long Timeline
        /// to empty.
        case refreshing
        case loaded
        case empty
        case failed(String)
    }

    /// The Event a row is shown against: the Execution that names the Event
    /// which caused it, or the Event that names its causing parent. Built
    /// only from `ExecutionSummary.inputEventId`/`correlationId` and
    /// `EventSummary.causationId` — never re-derived from timestamps or
    /// Module Instance.
    public struct EventReference: Sendable, Equatable, Hashable {
        public let id: String
        public let type: String
        public let subject: String?
    }

    public struct Row: Identifiable, Sendable, Equatable {
        public enum Kind: Sendable, Equatable {
            case request
            case fact
            case execution
        }

        public let id: String
        public let kind: Kind
        /// The Event's `type`, or "Execution" for an Execution row.
        public let title: String
        public let moduleInstance: String
        /// The subject this row concerns. An Execution has no subject of its
        /// own on the wire, so it takes its causing Event's, when resolvable.
        public let subject: String?
        public let occurredAt: Date
        /// Set only for a completed or failed Execution: when it finished.
        /// Nil for an Event, and for an Execution still queued/running/
        /// cancelling — findings-review #61-7.
        public let completedAt: Date?
        public let executionStatus: TimelineExecution.Status?
        public let attempt: Int?
        /// Set only for an Execution row: the Event that caused it.
        public let causingEvent: EventReference?
        /// Set only for an Event row caused by another: its parent.
        public let parentEvent: EventReference?
        public let accessibilityLabel: String
    }

    public struct Group: Identifiable, Sendable, Equatable {
        public let id: String
        /// The chain's real correlationId, or nil when `id` is only the
        /// synthesized single-row key for an orphan Execution (no
        /// correlationId on the wire). Never string-sniff `id` to tell the
        /// two apart — findings-review #61-5: an invented internal key must
        /// never be displayed as a correlation id.
        public let correlationId: String?
        public let rows: [Row]
    }

    public let status: Status
    public let groups: [Group]

    public init(
        events: [TimelineEvent],
        executions: [TimelineExecution],
        isLoading: Bool,
        errorMessage: String?
    ) {
        if isLoading {
            // A refresh over an already-loaded Timeline still carries its
            // previous, complete snapshot (`ProjectTimelineModel.refresh`
            // keeps it while `isLoading` flips true) — show that snapshot
            // with a subdued cue rather than blanking it. Only a genuine
            // first load, with nothing cached yet, gets the full-pane
            // progress view. Findings-review #61-2.
            if events.isEmpty && executions.isEmpty {
                status = .loading
                groups = []
                return
            }
            groups = Self.buildGroups(events: events, executions: executions)
            status = .refreshing
            return
        }
        if let errorMessage {
            status = .failed(errorMessage)
            groups = []
            return
        }
        let built = Self.buildGroups(events: events, executions: executions)
        groups = built
        status = built.isEmpty ? .empty : .loaded
    }

    private static func buildGroups(
        events: [TimelineEvent],
        executions: [TimelineExecution]
    ) -> [Group] {
        let eventsById = Dictionary(events.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })

        func reference(forEventId eventId: String?) -> EventReference? {
            guard let eventId, let event = eventsById[eventId] else { return nil }
            return EventReference(id: event.id, type: event.type, subject: event.subjectRef)
        }

        let eventRows: [(correlationId: String, row: Row)] = events.map { event in
            let parent = reference(forEventId: event.causationId)
            let kind: Row.Kind = event.kind == .request ? .request : .fact
            return (
                event.correlationId,
                Row(
                    id: "event:\(event.id)",
                    kind: kind,
                    title: event.type,
                    moduleInstance: event.producer,
                    subject: event.subjectRef,
                    occurredAt: event.occurredAt,
                    completedAt: nil,
                    executionStatus: nil,
                    attempt: nil,
                    causingEvent: nil,
                    parentEvent: parent,
                    accessibilityLabel: accessibilityLabel(
                        kindLabel: kind == .request ? "Request" : "Fact",
                        title: event.type,
                        moduleInstance: event.producer,
                        subject: event.subjectRef,
                        occurredAt: event.occurredAt,
                        completedAt: nil,
                        executionDetail: nil,
                        relatedEvent: parent.map { ("caused by", $0) })
                ))
        }

        let executionRows: [(correlationId: String, row: Row)] = executions.map { execution in
            let causing = reference(forEventId: execution.inputEventId)
            // An orphan (no correlationId on the wire) still reads as its own
            // single-row chain rather than joining an unrelated group.
            let correlationId = execution.correlationId ?? "execution:\(execution.id)"
            let statusLabel = execution.status.displayLabel
            return (
                correlationId,
                Row(
                    id: "execution:\(execution.id)",
                    kind: .execution,
                    title: "Execution",
                    moduleInstance: execution.moduleInstanceId,
                    subject: causing?.subject,
                    occurredAt: execution.createdAt,
                    completedAt: execution.completedAt,
                    executionStatus: execution.status,
                    attempt: execution.attempt,
                    causingEvent: causing,
                    parentEvent: nil,
                    accessibilityLabel: accessibilityLabel(
                        kindLabel: "Execution",
                        title: "Execution",
                        moduleInstance: execution.moduleInstanceId,
                        subject: causing?.subject,
                        occurredAt: execution.createdAt,
                        completedAt: execution.completedAt,
                        executionDetail: (statusLabel, execution.attempt),
                        relatedEvent: causing.map { ("caused by", $0) })
                ))
        }

        // A chain's real correlationId, collected separately from the group
        // key below: an orphan Execution's key is synthesized
        // ("execution:<id>") and must never be mistaken for one — findings-
        // review #61-5.
        var realCorrelationIds: Set<String> = Set(events.map(\.correlationId))
        for execution in executions {
            if let correlationId = execution.correlationId {
                realCorrelationIds.insert(correlationId)
            }
        }

        var byCorrelation: [String: [Row]] = [:]
        var order: [String] = []
        for (correlationId, row) in eventRows + executionRows {
            if byCorrelation[correlationId] == nil { order.append(correlationId) }
            byCorrelation[correlationId, default: []].append(row)
        }

        return order.map { correlationId in
            let rows = byCorrelation[correlationId, default: []]
                // Chronological within a chain: cause before effect. Ties (an
                // Event and the Execution it caused, minted at the same
                // instant) break on id, so the order never depends on
                // dictionary/array iteration order and stays stable across
                // reloads.
                .sorted { lhs, rhs in
                    if lhs.occurredAt != rhs.occurredAt { return lhs.occurredAt < rhs.occurredAt }
                    return lhs.id < rhs.id
                }
            return Group(
                id: correlationId,
                correlationId: realCorrelationIds.contains(correlationId) ? correlationId : nil,
                rows: rows)
        }
        // Most recently active chain first, matching #59's own "newest
        // first" convention for the two lists this merges. A completed or
        // failed Execution's recency is its completion, not its start — a
        // long-running Execution that just finished must not read as stale
        // (findings-review #61-7). Ties break on correlationId for the same
        // stability reason rows do.
        .sorted { lhs, rhs in
            let lhsLatest = lhs.rows.map(recencyAnchor).max() ?? .distantPast
            let rhsLatest = rhs.rows.map(recencyAnchor).max() ?? .distantPast
            if lhsLatest != rhsLatest { return lhsLatest > rhsLatest }
            return lhs.id < rhs.id
        }
    }

    /// The instant a row counts as "active" for group recency: a finished
    /// Execution's completion, otherwise when it started/occurred.
    private static func recencyAnchor(_ row: Row) -> Date {
        row.completedAt ?? row.occurredAt
    }

    private static func accessibilityLabel(
        kindLabel: String,
        title: String,
        moduleInstance: String,
        subject: String?,
        occurredAt: Date,
        completedAt: Date?,
        executionDetail: (status: String, attempt: Int)?,
        relatedEvent: (relation: String, event: EventReference)?
    ) -> String {
        var parts = ["\(kindLabel) \(title)", "by \(moduleInstance)"]
        if let executionDetail {
            parts.append("state \(executionDetail.status)")
            parts.append("attempt \(executionDetail.attempt)")
        }
        if let subject {
            parts.append("concerning \(subject)")
        }
        // The same locale/time-zone formatting the row itself displays
        // (`Text(row.occurredAt, format: .dateTime)`), not UTC ISO-8601 —
        // findings-review #61-3: VoiceOver must announce the instant the
        // screen shows, not a different one.
        parts.append("at \(occurredAt.formatted(.dateTime))")
        if let completedAt {
            parts.append("completed at \(completedAt.formatted(.dateTime))")
        }
        if let relatedEvent {
            parts.append("\(relatedEvent.relation) \(relatedEvent.event.type)")
        }
        return parts.joined(separator: ", ")
    }
}
