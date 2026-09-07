import { describe, expect, it } from "vitest";
import { LiveUpdateHub, type StreamMessage } from "./hub.js";

/** Records what one connected client was handed, and how it ended. */
function recordingClient(options: { readonly throwOnSend?: boolean } = {}) {
  const frames: string[] = [];
  let ended = false;
  return {
    frames,
    ended: () => ended,
    client: {
      send: (frame: string): void => {
        if (options.throwOnSend === true) throw new Error("socket is gone");
        frames.push(frame);
      },
      end: (): void => {
        ended = true;
      },
    },
  };
}

function parse(frame: string): StreamMessage {
  return JSON.parse(frame.replace(/^data: /, "").trim()) as StreamMessage;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const anEvent = {
  type: "event.recorded",
  projectId: "demo",
  occurredAt: "2026-01-01T00:00:00.000Z",
} as const;

describe("LiveUpdateHub", () => {
  it("numbers messages monotonically from 1 across types and Projects", () => {
    const hub = new LiveUpdateHub("ses_1");
    const a = recordingClient();
    hub.connect(a.client);

    hub.publish({ ...anEvent, payload: { id: "evt_1" } });
    hub.publish({
      type: "execution.changed",
      projectId: "other",
      occurredAt: anEvent.occurredAt,
      payload: { id: "exe_1" },
    });

    expect(a.frames.map((frame) => parse(frame).sequence)).toEqual([1, 2]);
    expect(parse(a.frames[0]!).sessionId).toBe("ses_1");
  });

  it("keeps every client and spends no sequence when a payload cannot be serialized", () => {
    const hub = new LiveUpdateHub("ses_1");
    const a = recordingClient();
    hub.connect(a.client);

    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    hub.publish({ ...anEvent, payload: circular });

    // The unserializable message reached nobody, but it also cost nothing:
    // the client is still connected and the next message is still sequence 1,
    // so no client can ever see a gap it cannot explain.
    expect(a.frames).toEqual([]);
    expect(a.ended()).toBe(false);

    hub.publish({ ...anEvent, payload: { id: "evt_1" } });
    expect(a.frames.map((frame) => parse(frame).sequence)).toEqual([1]);
  });

  it("ends and drops only the client whose send fails, and keeps serving the others", () => {
    const hub = new LiveUpdateHub("ses_1");
    const healthy = recordingClient();
    const broken = recordingClient({ throwOnSend: true });
    hub.connect(healthy.client);
    hub.connect(broken.client);

    hub.publish({ ...anEvent, payload: { id: "evt_1" } });

    // The broken peer is ended rather than left holding an open connection
    // that never delivers again — a silently dead stream is one the client
    // cannot detect and recover from by rereading REST.
    expect(broken.ended()).toBe(true);
    expect(healthy.frames).toHaveLength(1);
    expect(healthy.ended()).toBe(false);

    hub.publish({ ...anEvent, payload: { id: "evt_2" } });
    expect(healthy.frames.map((frame) => parse(frame).sequence)).toEqual([1, 2]);
  });

  it("stops sending to a disconnected client without disturbing the rest", () => {
    const hub = new LiveUpdateHub("ses_1");
    const staying = recordingClient();
    const leaving = recordingClient();
    hub.connect(staying.client);
    const disconnect = hub.connect(leaving.client);

    disconnect();
    hub.publish({ ...anEvent, payload: { id: "evt_1" } });

    expect(leaving.frames).toEqual([]);
    expect(staying.frames).toHaveLength(1);
  });

  // findings-review #62-3: an idle connection is dead to the client's
  // inactivity timers (URLSession's 60 s, the shell's 5 min safety net), so
  // the hub probes it. The probe is an SSE comment — a `:` line the WHATWG
  // spec says conformant parsers ignore — which is what makes it free: no
  // message, no sequence, no new contract type.
  it("probes idle connections with a keep-alive comment that spends no sequence", async () => {
    const hub = new LiveUpdateHub("ses_1", 25); // injectable interval: no minute-long test
    const a = recordingClient();
    hub.connect(a.client);

    await sleep(100);

    expect(a.frames.length).toBeGreaterThan(0);
    expect(a.frames.every((frame) => frame.startsWith(":"))).toBe(true);

    // A real message still costs exactly sequence 1, not 2 — and the
    // probes that got here do not show up in its numbering.
    hub.publish({ ...anEvent, payload: { id: "evt_1" } });
    const dataFrames = a.frames.filter((frame) => frame.startsWith("data: "));
    expect(dataFrames.map((frame) => parse(frame).sequence)).toEqual([1]);
    expect(a.ended()).toBe(false);
    hub.closeAll();
  });

  it("closeAll stops the keep-alive probes", async () => {
    const hub = new LiveUpdateHub("ses_1", 25);
    const a = recordingClient();
    hub.connect(a.client);

    await sleep(100);
    const seen = a.frames.length;
    expect(seen).toBeGreaterThan(0);

    hub.closeAll();
    await sleep(100);
    expect(a.frames.length).toBe(seen);
  });

  it("ends every open client on closeAll so shutdown never waits on one", () => {
    const hub = new LiveUpdateHub("ses_1");
    const a = recordingClient();
    const b = recordingClient();
    hub.connect(a.client);
    hub.connect(b.client);

    hub.closeAll();

    expect(a.ended()).toBe(true);
    expect(b.ended()).toBe(true);

    hub.publish({ ...anEvent, payload: { id: "evt_1" } });
    expect(a.frames).toEqual([]);
    expect(b.frames).toEqual([]);
  });
});
