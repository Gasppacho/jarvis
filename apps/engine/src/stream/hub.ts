/**
 * Ticket #60 ("You are introducing that [an in-process emitter] — there is
 * no in-process emitter, event bus, or pub/sub of any kind in the engine
 * today"): the one in-memory fan-out point for Live Updates, owned by the
 * Engine Session (main.ts constructs exactly one `LiveUpdateHub` per process,
 * keyed by `config.sessionId` — the same id the ready handshake already
 * reports to the shell, which is why this ticket adds no second session
 * concept).
 *
 * `sequence` is the counter issue #60 says the Engine Session has no such
 * counter today: private, starts at 1, increments once per published
 * message regardless of type or Project (acceptance criterion "monotonic and
 * gapless ... whatever their type or Project" — a single counter, not one per
 * type or Project).
 */

/** The Local API contract's declared vocabulary (contracts/openapi/
 * local-api.v1.yaml `StreamMessage.type` enum) — the only two types this
 * engine ever emits. Health, project/module status and execution log
 * messages (docs/architecture/OBSERVABILITY.md "Real-time channel") are out
 * of this ticket's scope. */
export type StreamMessageType = "event.recorded" | "execution.changed";

export interface StreamMessage {
  readonly sequence: number;
  readonly type: StreamMessageType;
  readonly occurredAt: string;
  readonly projectId: string | null;
  readonly sessionId: string;
  /** The REST summary shape for the row this message reports (`EventSummary`
   * or `ExecutionSummary`, contracts/openapi/local-api.v1.yaml) — left as
   * `object` rather than `Record<string, unknown>` so a concrete summary
   * interface, which carries no index signature, is assignable here without
   * a cast. */
  readonly payload: object;
}

export interface PublishLiveUpdateInput {
  readonly type: StreamMessageType;
  readonly projectId: string;
  readonly occurredAt: string;
  readonly payload: object;
}

/** The port the event loop depends on, so `dispatch-loop.ts` (and its unit
 * tests) need not know `LiveUpdateHub`'s concrete shape. */
export interface LiveUpdatePort {
  publish(input: PublishLiveUpdateInput): void;
}

/** The SSE wire form of one message: a single `data:` field terminated by a
 * blank line. Lives here rather than in `stream/routes.ts` so the encoding
 * happens once per message instead of once per connected client. */
export function encodeFrame(message: StreamMessage): string {
  return `data: ${JSON.stringify(message)}\n\n`;
}

/** The keep-alive probe for idle connections (findings-review #62-3): an
 * SSE comment — a `:` line that the WHATWG "Server-sent events" spec says
 * conformant parsers ignore. That is what makes it free: it carries no
 * message and spends no sequence number, while a byte on the wire keeps the
 * client-side inactivity timers (URLSession's, the shell's own 5-minute
 * safety net, docs/contracts/LOCAL_API_V1.md) from killing a healthy but
 * quiet connection. A stream the engine has genuinely stopped keeping
 * alive reads as dead to the shell, and the shell's reload-and-reconnect
 * recovers from that. */
export const KEEPALIVE_FRAME = ": keep-alive\n\n";

interface Client {
  /** Takes the already-encoded SSE frame, not the message: encoding happens
   * once per `publish` rather than once per client, so a payload that cannot
   * be serialized fails before any client is touched instead of failing
   * identically for every one of them (issue #60 code review, finding 1). */
  readonly send: (frame: string) => void;
  readonly end: () => void;
}

/**
 * One instance per Engine process, living exactly as long as the server
 * does. `publish` is called from the dispatch loop after a commit (never
 * before — see dispatch-loop.ts and delivery-consumer.ts for where each
 * fact is read out of already-durable state) and must never be able to
 * affect that caller: every failure path here is swallowed, per the
 * constraint that "a dropped or absent stream must cost nothing durable" and
 * "must never be able to fail a transaction or block the dispatch loop".
 */
export class LiveUpdateHub implements LiveUpdatePort {
  private sequence = 0;
  private readonly clients = new Map<symbol, Client>();
  private keepaliveTimer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly sessionId: string,
    /** How often idle connections are probed (findings-review #62-3).
     * Injectable so tests do not sleep a minute; the production default
     * (15 s) sits well under every client-side inactivity timer. */
    private readonly keepaliveIntervalMs = 15_000,
  ) {}

  public publish(input: PublishLiveUpdateInput): void {
    try {
      // The sequence is only spent once the frame is known to encode: a
      // message that cannot be serialized must not consume a number, or the
      // stream would show a gap that no client could ever explain
      // (acceptance criterion "monotonic ... without gaps").
      const sequence = this.sequence + 1;
      const message: StreamMessage = {
        sequence,
        type: input.type,
        occurredAt: input.occurredAt,
        projectId: input.projectId,
        sessionId: this.sessionId,
        payload: input.payload,
      };

      let frame: string;
      try {
        frame = encodeFrame(message);
      } catch {
        // Encoded once, before the fan-out: an unserializable payload is the
        // same failure for every client, so encoding per client would drop
        // all of them at once and mute the stream for the rest of the Engine
        // Session (issue #60 code review, finding 1). Skipping the message
        // keeps every connection alive and costs nothing durable — the row
        // itself is already committed and still readable over REST.
        return;
      }
      this.sequence = sequence;

      for (const [id, client] of this.clients) {
        try {
          client.send(frame);
        } catch {
          // This client alone is broken: its socket vanished between the
          // loop's read of `this.clients` and now, or it is too far behind
          // to keep (stream/routes.ts). Drop it, but end the response first
          // — a client left holding an open connection that never delivers
          // again cannot detect the gap and reload over REST, which is the
          // recovery path docs/contracts/LOCAL_API_V1.md promises it.
          this.dropClient(id);
        }
      }
    } catch {
      // Never propagate into the dispatch loop (constraint: emission must
      // never fail a transaction or block dispatch) — a broken subscriber is
      // a stream-layer problem, not a durable one.
    }
  }

  /** Registers one connection; returns the function that removes it
   * (idempotent — safe to call once from the request's own "close" and once
   * more from `closeAll`). */
  public connect(client: Client): () => void {
    const id = Symbol("jarvis-stream-client");
    this.clients.set(id, client);
    this.startKeepaliveTimer();
    return () => {
      this.clients.delete(id);
      this.stopKeepaliveTimerIfIdle();
    };
  }

  /** Engine shutdown (main.ts): ends every open stream before `app.close()`
   * runs, so a long-lived SSE response — which Fastify's default
   * `forceCloseConnections: "idle"` does not consider idle — can never leave
   * shutdown waiting on it. */
  public closeAll(): void {
    this.stopKeepaliveTimer();
    for (const id of this.clients.keys()) this.dropClient(id);
  }

  /** Removes one client and best-effort closes its response. All send-failure
   * paths use the same cleanup so a client cannot remain registered after its
   * socket stops accepting frames. */
  private dropClient(id: symbol): void {
    const client = this.clients.get(id);
    this.clients.delete(id);
    if (client === undefined) return;
    try {
      client.end();
    } catch {
      /* the connection is already gone */
    }
  }

  // The keep-alive probes (findings-review #62-3). One timer for the whole
  // hub — the frame is identical for every client — started on the first
  // connection, stopped when the last one leaves or on `closeAll`.
  private startKeepaliveTimer(): void {
    if (this.keepaliveTimer !== null) return;
    this.keepaliveTimer = setInterval(() => this.emitKeepalive(), this.keepaliveIntervalMs);
    // Never let the probe hold the process open at shutdown: `closeAll`
    // clears it explicitly, and an unref'd timer cannot keep Node alive.
    this.keepaliveTimer.unref();
  }

  private stopKeepaliveTimer(): void {
    if (this.keepaliveTimer === null) return;
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  private stopKeepaliveTimerIfIdle(): void {
    if (this.clients.size === 0) this.stopKeepaliveTimer();
  }

  private emitKeepalive(): void {
    for (const [id, client] of this.clients) {
      try {
        client.send(KEEPALIVE_FRAME);
      } catch {
        // The same broken-socket handling as `publish`: end and drop this
        // client alone, keep serving the rest.
        this.dropClient(id);
      }
    }
    this.stopKeepaliveTimerIfIdle();
  }
}
