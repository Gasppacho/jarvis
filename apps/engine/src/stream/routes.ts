import type { FastifyInstance } from "fastify";
import type { LiveUpdateHub } from "./hub.js";
import { CORRELATION_HEADER } from "../http/correlation.js";

/**
 * How many bytes of undelivered Live Updates one connection may have queued
 * in the engine's memory before it is dropped (issue #60 code review,
 * finding 2). A `StreamMessage` is a few hundred bytes, so a megabyte is
 * thousands of unread messages — far beyond any transient stall, and only
 * reachable by a client that has stopped reading altogether (a suspended or
 * wedged shell). Dropping it is the right policy rather than a hardship: the
 * documented recovery is to reconnect and reread the REST timeline
 * (docs/contracts/LOCAL_API_V1.md), so the client loses nothing durable,
 * whereas keeping it would grow the long-lived engine process without bound.
 */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * Ticket #60: `GET /v1/stream`. Loopback + bearer auth is already enforced by
 * `http/server.ts`'s global `onRequest` hook before this handler ever runs,
 * so nothing here repeats that check. The handler writes the SSE prelude
 * itself (`reply.hijack()`) rather than returning a value, because a
 * Server-Sent Events response never resolves the way a normal JSON response
 * does.
 */
export function registerStreamRoutes(app: FastifyInstance, hub: LiveUpdateHub): void {
  app.get("/v1/stream", (request, reply) => {
    // Tells Fastify this handler owns the raw response from here on — no
    // serializer, no onSend hook will run, and the request never resolves
    // its "handled" state on its own (docs/architecture/OBSERVABILITY.md
    // "Real-time channel").
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      // Hijacking bypasses the reply object, so the header the global
      // `onRequest` hook set with `reply.header(...)` (http/server.ts) never
      // reaches the wire unless it is written here. Without it this is the
      // one operation whose response an operator cannot correlate against
      // engine logs (issue #60 code review, finding 4).
      [CORRELATION_HEADER]: request.correlationId,
    });
    // Node buffers response headers until the first `write`/`end` unless
    // told otherwise, so a caller opening the stream would see nothing at
    // all — not even a connected socket — until the first Live Update
    // happens to fire. Flushing here is what makes "the connection is open"
    // observable immediately, independent of when the first message arrives.
    reply.raw.flushHeaders();

    const send = (frame: string): void => {
      reply.raw.write(frame);
      // `write` queues in process memory when the peer is not reading, and
      // reports nothing but its own return value. Throwing here hands this
      // connection back to the hub, which ends and drops it — bounding what
      // one stalled client can cost the engine (constraint: a misbehaving
      // stream must cost nothing).
      if (reply.raw.writableLength > MAX_BUFFERED_BYTES) {
        throw new Error("jarvis-engine: stream client is too far behind; dropping it.");
      }
    };
    const disconnect = hub.connect({
      send,
      end: () => reply.raw.end(),
    });

    // Fires on a client disconnect, on `end()` above, or if the socket is
    // destroyed outright — the only place this connection is ever removed,
    // so a dropped client never leaves a registered listener behind
    // (constraint: "a disconnected client must not leak").
    request.raw.on("close", disconnect);
  });
}
