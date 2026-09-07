import Foundation
import JarvisAPI
import OpenAPIRuntime

/// Ticket #62: one live update from the Engine's `/v1/stream` (ticket #60),
/// decoded into the same domain types the REST fetch already produces
/// (`TimelineEvent`/`TimelineExecution`, `APIClient/Timeline.swift`) so an
/// incremental apply and a REST reload can never disagree on shape.
public struct TimelineStreamMessage: Sendable, Equatable {
    public enum Payload: Sendable, Equatable {
        case event(TimelineEvent)
        case execution(TimelineExecution)
    }

    /// Ticket #60: monotonic and gapless across every message of one Engine
    /// Session, whatever their type or Project — one counter, not one per
    /// type or Project, and restarting at 1 in a new Engine Session. A gap
    /// must be checked against every message the connection ever delivers,
    /// before filtering by `projectId`: a skip caused by another Project's
    /// message is not a gap (`ProjectTimelineModel.watchLive`).
    public let sequence: Int
    public let projectId: String?
    /// Ticket #60: the Engine Session that produced this message. A change
    /// mid-stream means a new Engine Session started — never a continuation
    /// of what came before.
    public let sessionId: String?
    public let payload: Payload

    init(sequence: Int, projectId: String?, sessionId: String?, payload: Payload) {
        self.sequence = sequence
        self.projectId = projectId
        self.sessionId = sessionId
        self.payload = payload
    }
}

/// Ticket #62: how the Timeline's live connection to `/v1/stream` currently
/// stands, so the screen can tell the user live from reconnecting from
/// failed rather than silently going stale.
public enum TimelineConnectionState: Sendable, Equatable {
    /// Connected and applying updates as they arrive.
    case live
    /// The connection dropped (or has not yet been made) and a reconnect
    /// attempt is in flight or about to be.
    case reconnecting
    /// Reconnecting was abandoned (the engine rejected the connection
    /// outright) rather than retried forever. The screen still shows
    /// whatever the last successful REST snapshot contained.
    case failed
}

extension TimelineStreamMessage {
    /// Decodes one SSE frame's `data:` line — `<StreamMessage JSON>` per the
    /// contract (ticket #60) — into the domain payload type its own `type`
    /// names. Returns nil for a message type this ticket does not consume
    /// (the wire enum is closed today, but OBSERVABILITY.md documents more
    /// types the engine may add later) rather than failing the whole
    /// connection over it.
    static func decode(fromDataLineJSON data: Data) throws -> TimelineStreamMessage? {
        let envelope = try streamDecoder.decode(WireEnvelope.self, from: data)
        switch envelope.payload {
        case .event(let event):
            return TimelineStreamMessage(
                sequence: envelope.sequence, projectId: envelope.projectId,
                sessionId: envelope.sessionId, payload: .event(event))
        case .execution(let execution):
            return TimelineStreamMessage(
                sequence: envelope.sequence, projectId: envelope.projectId,
                sessionId: envelope.sessionId, payload: .execution(execution))
        case .unrecognized:
            return nil
        }
    }

    /// The contract's `date-time` is RFC 3339; the engine always emits the
    /// fractional form (`new Date().toISOString()`), fixtures and examples
    /// may carry the whole-second form. `FlexibleISO8601DateTranscoder`
    /// accepts both — the same transcoder the generated REST client uses
    /// (`EngineClient`), so a stream row and its REST twin can never
    /// disagree about an instant. The pinned runtime's default transcoder
    /// (`.iso8601`, whole-second only) cannot parse the engine's own
    /// timestamps, which is why the client carries its own.
    private static let streamDecoder: JSONDecoder = {
        let decoder = JSONDecoder()
        let transcoder = FlexibleISO8601DateTranscoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let string = try container.decode(String.self)
            return try transcoder.decode(string)
        }
        return decoder
    }()
}

/// The wire shape of `StreamMessage` (contracts/openapi/local-api.v1.yaml).
/// `payload` decodes straight into the schema type `type` names — there is
/// no parallel envelope type here, only this one decode step; `TimelineEvent`/
/// `TimelineExecution` (ticket #61) still own the domain shape.
private struct WireEnvelope: Decodable {
    enum DecodedPayload {
        case event(TimelineEvent)
        case execution(TimelineExecution)
        case unrecognized
    }

    let sequence: Int
    let projectId: String?
    let sessionId: String?
    let payload: DecodedPayload

    private enum CodingKeys: String, CodingKey {
        case sequence, type, projectId, sessionId, payload
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sequence = try container.decode(Int.self, forKey: .sequence)
        projectId = try container.decodeIfPresent(String.self, forKey: .projectId)
        sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "event.recorded":
            let summary = try container.decode(
                Components.Schemas.EventSummary.self, forKey: .payload)
            payload = .event(TimelineEvent(payload: summary))
        case "execution.changed":
            let summary = try container.decode(
                Components.Schemas.ExecutionSummary.self, forKey: .payload)
            payload = .execution(TimelineExecution(payload: summary))
        default:
            payload = .unrecognized
        }
    }
}
