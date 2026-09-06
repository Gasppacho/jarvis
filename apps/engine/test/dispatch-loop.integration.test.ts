import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine } from "./harness.js";
import { SAMPLE_PROBE_PINGED } from "../src/executions/sample-probe-module.js";

/**
 * Review fix (major) for ticket #58: `apps/engine/src/events/dispatch-loop.ts`
 * wrapped `consumer.consume(delivery)` in try/catch but not
 * `deps.dispatcher.dispatchPending()`, and the loop runs unconditionally
 * with no `uncaughtException` handler. A single malformed Outbox row makes
 * `OutboxDispatcher`'s `requireEnvelope` throw, which used to take the whole
 * process down; the row stays `pending`, so a restart reclaims and rethrows
 * on it again — a permanent crash loop needing manual DB surgery.
 */
const testBundlePath = fileURLToPath(
  new URL("../../../dist/engine/engine.test-bundle.mjs", import.meta.url),
);

const created: string[] = [];

async function dataRootFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-dispatch-loop-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function openDb(dataRoot: string): Database.Database {
  return new Database(join(dataRoot, "jarvis.sqlite"));
}

async function waitForOutboxStatus(
  dataRoot: string,
  eventId: string,
  status: string,
  timeoutMs = 5_000,
): Promise<void> {
  const startedAt = Date.now();
  let last: string | undefined;
  for (;;) {
    const db = openDb(dataRoot);
    try {
      const row = db.prepare("SELECT status FROM outbox WHERE event_id = ?").get(eventId) as
        { status: string } | undefined;
      last = row?.status;
      if (last === status) return;
    } finally {
      db.close();
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `outbox row ${eventId} did not reach status "${status}" within ${timeoutMs}ms (last seen: ${last ?? "missing"})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function pingInput(projectId: string) {
  return {
    type: SAMPLE_PROBE_PINGED.type,
    version: SAMPLE_PROBE_PINGED.version,
    kind: SAMPLE_PROBE_PINGED.kind,
    projectId,
    producer: { moduleId: "jarvis.module.github", moduleInstanceId: "github" },
    subject: { type: "work-item", ref: `github://acme/${projectId}/issues/1` },
    correlationId: "corr_01K0000000000000000000",
    causationId: null,
    payload: {},
  };
}

describe("dispatch loop: a bad Outbox row cannot crash-loop the engine", () => {
  it(
    "a malformed Outbox row is logged and skipped, not thrown; healthy rows published " +
      "before and after it still dispatch",
    async () => {
      const dataRoot = await dataRootFixture();
      // Short lease: the malformed row's batch also leases whatever healthy
      // row follows it in creation order, so that row is only reclaimable
      // once the lease expires — kept short so the test does not wait long.
      const engine = await startEngine({
        dataRoot,
        enginePath: testBundlePath,
        env: { JARVIS_ENABLE_TEST_HOOKS: "1", JARVIS_OUTBOX_LEASE_MS: "200" },
      });
      try {
        await engine.call("/test/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "proj-1", moduleInstanceId: "probe-1" }),
        });

        const publish = (projectId: string) =>
          engine
            .call("/test/events", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(pingInput(projectId)),
            })
            .then((response) => response.json() as Promise<{ id: string }>);

        const before = await publish("proj-1");

        // A malformed Outbox row, inserted directly — the shape a corrupt
        // write or a future producer bug could leave behind. `envelope` is
        // not valid JSON, so `OutboxDispatcher`'s `requireEnvelope` throws
        // the moment the dispatcher reaches it.
        const db = openDb(dataRoot);
        db.pragma("busy_timeout = 5000");
        try {
          db.prepare(
            `INSERT INTO outbox (event_id, project_id, envelope, status, created_at)
             VALUES (@eventId, @projectId, @envelope, 'pending', @createdAt)`,
          ).run({
            eventId: "evt_malformed",
            projectId: "proj-1",
            envelope: "not valid json",
            createdAt: new Date().toISOString(),
          });
        } finally {
          db.close();
        }

        const after = await publish("proj-1");

        // The engine keeps answering through several ticks that reach the
        // malformed row — proof the crash this fix targets does not happen.
        await new Promise((resolve) => setTimeout(resolve, 500));
        const health = await engine.call("/v1/health");
        expect(health.status).toBe(200);
        expect(await health.json()).toMatchObject({ status: "ready" });

        // Healthy rows on both sides of the malformed one still dispatch:
        // `before` ahead of it in the same or an earlier claim, `after` once
        // the short lease above expires and a later tick reclaims it.
        await waitForOutboxStatus(dataRoot, before.id, "dispatched");
        await waitForOutboxStatus(dataRoot, after.id, "dispatched");

        // The malformed row is never silently marked dispatched — actually
        // resolving it is #17's retries/backoff/dead-letters, out of scope
        // here. This loop only guarantees it does not take anything else
        // down with it.
        const finalDb = openDb(dataRoot);
        try {
          expect(
            finalDb.prepare("SELECT status FROM outbox WHERE event_id = ?").get("evt_malformed"),
          ).toEqual({ status: "pending" });
        } finally {
          finalDb.close();
        }
      } finally {
        await engine.dispose();
      }
    },
  );
});
