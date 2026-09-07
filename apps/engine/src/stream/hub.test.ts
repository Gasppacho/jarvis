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
