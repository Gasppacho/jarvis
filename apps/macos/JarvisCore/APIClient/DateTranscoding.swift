import Foundation
import OpenAPIRuntime

/// The engine stamps every `occurredAt` with `new Date().toISOString()` —
/// always three fractional digits (`2026-09-07T10:15:30.123Z`). The
/// contract's `date-time` (RFC 3339, LOCAL_API_V1.md) also admits the
/// whole-second form, and the examples, fixtures and older rows may carry
/// it. The pinned runtime's two built-in transcoders each accept exactly
/// one of the two forms — `.iso8601` (the `Configuration` default) rejects
/// the fractional one, `.iso8601WithFractionalSeconds` rejects the
/// whole-second one — so the client must accept both, for the REST reads
/// and for the live stream alike (`TimelineStream.streamDecoder`), or a
/// stream row and its REST twin could not be reconciled by id at all.
///
/// `DateTranscoder` is `Sendable`; `ISO8601DateFormatter` is not (Apple
/// documents `DateFormatter` subclasses as not thread-safe), so a lock
/// guards both — the same pattern the runtime's own transcoder uses.
public final class FlexibleISO8601DateTranscoder: DateTranscoder, @unchecked Sendable {
    #if FullFoundation || canImport(Darwin)
    private let lock = NSLock()
    private let fractional: ISO8601DateFormatter
    private let wholeSecond: ISO8601DateFormatter
    #else
    // FoundationEssentials on non-Darwin platforms does not expose
    // ISO8601DateFormatter. The runtime's format-style transcoders provide
    // the same two RFC 3339 forms there, and are Sendable themselves.
    private let fractional: any DateTranscoder = .iso8601WithFractionalSeconds
    private let wholeSecond: any DateTranscoder = .iso8601
    #endif

    public init() {
        #if FullFoundation || canImport(Darwin)
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        self.fractional = fractional
        self.wholeSecond = ISO8601DateFormatter()
        #endif
    }

    /// Encodes in the whole-second form, matching the existing REST client's
    /// stable wire representation. Decoding accepts both forms; callers that
    /// need to preserve sub-second precision should retain the original Date
    /// rather than round-tripping it through this encoder.
    public func encode(_ date: Date) throws -> String {
        #if FullFoundation || canImport(Darwin)
        lock.lock()
        defer { lock.unlock() }
        return wholeSecond.string(from: date)
        #else
        return try wholeSecond.encode(date)
        #endif
    }

    public func decode(_ dateString: String) throws -> Date {
        #if FullFoundation || canImport(Darwin)
        lock.lock()
        defer { lock.unlock() }
        if let date = fractional.date(from: dateString) { return date }
        if let date = wholeSecond.date(from: dateString) { return date }
        #else
        if let date = try? fractional.decode(dateString) { return date }
        if let date = try? wholeSecond.decode(dateString) { return date }
        #endif
        throw DecodingError.dataCorrupted(
            .init(
                codingPath: [],
                debugDescription:
                    "Expected an ISO-8601 date string (whole-second or fractional), got \"\(dateString)\"."))
    }
}