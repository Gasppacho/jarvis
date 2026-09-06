import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine, type Harness } from "./harness.js";
import {
  SAMPLE_PROBE_MODULE_ID,
  SAMPLE_PROBE_PINGED,
} from "../src/executions/sample-probe-module.js";

/**
 * Ticket #58 (issue #58 "Test seam"): Application Harness restart scenarios —
 * publish, kill at each declared failpoint, restart the engine against the
 * same SQLite file, assert journal, Outbox, Delivery, Inbox, Execution
 * Ledger and the sample Module's side-effect counter. No mock: the real
 * built engine bundle, a real temporary SQLite file, real HTTP.
 *
 * `JARVIS_ENABLE_TEST_HOOKS=1` is what makes any of this reachable — see
 * `apps/engine/src/test-support/durability-test-routes.ts`'s module doc
 * comment for why that surface is test-only. `JARVIS_FAILPOINT=<id>` arms
 * exactly one of the four boundaries `apps/engine/src/test-support/
 * failpoint.ts` declares; unset (as a real launch always leaves it), every
 * one of those calls is inert — proven in the last `describe` block below.
 *
 * Review fix for ticket #58: the failpoint/test-hooks mechanism is compiled
 * out of the production entry entirely (tsup.config.ts's `__JARVIS_TEST_HOOKS__`
 * define; see apps/engine/test/failpoint-bundle.test.ts), so every scenario
 * here that needs it runs against the separate test entry instead. Only the
 * last test in this file — proving the routes are absent on a normal launch —
 * deliberately keeps the default (production) `enginePath`.
 */
const testBundlePath = fileURLToPath(
  new URL("../../../dist/engine/engine.test-bundle.mjs", import.meta.url),
);

const created: string[] = [];

async function dataRootFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-durability-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function openDb(dataRoot: string): Database.Database {
  return new Database(join(dataRoot, "jarvis.sqlite"));
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

const seedProject = (engine: Harness, id: string, moduleInstanceId = "probe-1") =>
  engine.call("/test/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, moduleInstanceId }),
  });

const publishPing = (engine: Harness, projectId: string) =>
  engine.call("/test/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pingInput(projectId)),
  });

describe("durability: crash recovery across the Outbox/Delivery/Execution pipeline", () => {
  it(
    "acceptance criteria 1+2: a failpoint deterministically stops the engine after the Outbox " +
      "commit and before dispatch; after restart the pending row is dispatched, journaled once, " +
      "the Delivery is created and the handler's side effect happens exactly once",
    async () => {
      const dataRoot = await dataRootFixture();

      const crashed = await startEngine({
        dataRoot,
        enginePath: testBundlePath,
        env: { JARVIS_ENABLE_TEST_HOOKS: "1", JARVIS_FAILPOINT: "after-outbox-commit" },
      });
      await seedProject(crashed, "proj-1");
      // The failpoint fires before the response is sent, so the connection is
      // reset rather than answered — the crash itself is the assertion, not
      // this call's outcome.
      const publish = publishPing(crashed, "proj-1").catch(() => undefined);
      const exitCode = await crashed.waitForExit();
      expect(exitCode).not.toBe(0);
      await publish;
      await crashed.dispose();

      const beforeRestart = openDb(dataRoot);
      try {
        expect(beforeRestart.prepare("SELECT status FROM outbox").get()).toMatchObject({
          status: "pending",
        });
        expect(beforeRestart.prepare("SELECT 1 FROM events").get()).toBeUndefined();
        expect(beforeRestart.prepare("SELECT 1 FROM deliveries").get()).toBeUndefined();
      } finally {
        beforeRestart.close();
      }

      const restarted = await startEngine({
        dataRoot,
        enginePath: testBundlePath,
        env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
      });
      try {
        await restarted.waitForStderr("delivery consumed");
      } finally {
        await restarted.dispose();
      }

      const afterRestart = openDb(dataRoot);
      try {
        expect(afterRestart.prepare("SELECT status FROM outbox").get()).toEqual({
          status: "dispatched",
        });
        expect(afterRestart.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
        expect(afterRestart.prepare("SELECT consumed_at FROM deliveries").get()).not.toEqual({
          consumed_at: null,
        });
        expect(afterRestart.prepare("SELECT status FROM inbox").get()).toEqual({
          status: "completed",
        });
        expect(afterRestart.prepare("SELECT status FROM executions").get()).toEqual({
          status: "completed",
        });
        expect(afterRestart.prepare("SELECT ping_count FROM sample_probe_state").get()).toEqual({
          ping_count: 1,
        });
      } finally {
        afterRestart.close();
      }
    },
  );

  it(
    "acceptance criterion 3: a crash after dispatch but before the handler's transaction " +
      "commits leaves no partial handler effect; after restart the Delivery is redelivered " +
      "and the Execution completes once",
    async () => {
      const dataRoot = await dataRootFixture();

      const crashed = await startEngine({
        dataRoot,
        enginePath: testBundlePath,
        env: { JARVIS_ENABLE_TEST_HOOKS: "1", JARVIS_FAILPOINT: "before-handler-commit" },
      });
      await seedProject(crashed, "proj-1");
      // This publish is unaffected by this failpoint and completes normally;
      // the crash happens later, inside the background loop's own consume.
      const published = (await (await publishPing(crashed, "proj-1")).json()) as { id: string };
      await crashed.waitForExit();
      await crashed.dispose();

      const beforeRestart = openDb(dataRoot);
      try {
        expect(
          beforeRestart.prepare("SELECT status FROM outbox WHERE event_id = ?").get(published.id),
        ).toEqual({ status: "dispatched" });
        expect(
          beforeRestart
            .prepare("SELECT consumed_at FROM deliveries WHERE event_id = ?")
            .get(published.id),
        ).toEqual({ consumed_at: null });
        expect(beforeRestart.prepare("SELECT 1 FROM inbox").get()).toBeUndefined();
        expect(beforeRestart.prepare("SELECT 1 FROM executions").get()).toBeUndefined();
        expect(beforeRestart.prepare("SELECT 1 FROM sample_probe_state").get()).toBeUndefined();
      } finally {
        beforeRestart.close();
      }

      const restarted = await startEngine({
        dataRoot,
        enginePath: testBundlePath,
        env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
      });
      try {
        await restarted.waitForStderr("delivery consumed");
      } finally {
        await restarted.dispose();
      }

      const afterRestart = openDb(dataRoot);
      try {
        expect(afterRestart.prepare("SELECT COUNT(*) AS n FROM inbox").get()).toEqual({ n: 1 });
        expect(afterRestart.prepare("SELECT COUNT(*) AS n FROM executions").get()).toEqual({
          n: 1,
        });
        expect(afterRestart.prepare("SELECT status FROM executions").get()).toEqual({
          status: "completed",
        });
        // Exactly once, not twice: the crashed attempt left nothing behind to double-count.
        expect(afterRestart.prepare("SELECT ping_count FROM sample_probe_state").get()).toEqual({
          ping_count: 1,
        });
      } finally {
        afterRestart.close();
      }
    },
  );

  it(
    "acceptance criterion 4: a crash after the handler's transaction commits but before the " +
      "Delivery is acknowledged results in a redelivery that returns the recorded terminal " +
      "result without re-running the side effect",
    async () => {
      const dataRoot = await dataRootFixture();

      const crashed = await startEngine({
        dataRoot,
        enginePath: testBundlePath,
        env: { JARVIS_ENABLE_TEST_HOOKS: "1", JARVIS_FAILPOINT: "after-handler-commit" },
      });
      await seedProject(crashed, "proj-1");
      const published = (await (await publishPing(crashed, "proj-1")).json()) as { id: string };
      await crashed.waitForExit();
      await crashed.dispose();

      const beforeRestart = openDb(dataRoot);
      try {
        // Handler transaction commits state, Execution, Inbox and Delivery
        // completion together (docs/architecture/PERSISTENCE.md "Consume and
        // publish"), so all of it is already durable at this crash point.
        expect(beforeRestart.prepare("SELECT status FROM executions").get()).toEqual({
          status: "completed",
        });
        expect(beforeRestart.prepare("SELECT ping_count FROM sample_probe_state").get()).toEqual({
          ping_count: 1,
        });
        expect(beforeRestart.prepare("SELECT consumed_at FROM deliveries").get()).not.toEqual({
          consumed_at: null,
        });
      } finally {
        beforeRestart.close();
      }

      // Nothing is left "unconsumed", so the automatic loop has nothing to
      // redeliver on its own — a genuine redelivery of an already-acked
      // Delivery has to be requested explicitly, exactly like a real
      // at-least-once redelivery would arrive from outside this engine.
      const restarted = await startEngine({
        dataRoot,
        enginePath: testBundlePath,
        env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
      });
      try {
        const redelivery = await restarted.call("/test/redeliver", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: "proj-1",
            moduleInstanceId: "probe-1",
            moduleId: SAMPLE_PROBE_MODULE_ID,
            eventId: published.id,
          }),
        });
        const outcome = (await redelivery.json()) as {
          redelivered: boolean;
          executionId: string | null;
          status: string;
          result: { pingCount: number };
        };
        expect(outcome.redelivered).toBe(true);
        expect(outcome.executionId).toBeNull();
        expect(outcome.status).toBe("completed");
        expect(outcome.result.pingCount).toBe(1);
      } finally {
        await restarted.dispose();
      }

      const afterRedelivery = openDb(dataRoot);
      try {
        expect(afterRedelivery.prepare("SELECT COUNT(*) AS n FROM executions").get()).toEqual({
          n: 1,
        });
        // The side effect was not re-run.
        expect(afterRedelivery.prepare("SELECT ping_count FROM sample_probe_state").get()).toEqual({
          ping_count: 1,
        });
      } finally {
        afterRedelivery.close();
      }
    },
  );

  it(
    "acceptance criterion 5: a dispatcher lease held by a killed process is reclaimable after " +
      "restart, so a crashed claim does not strand an Outbox row forever",
    async () => {
      const dataRoot = await dataRootFixture();
      const leaseMs = "200";

      const crashed = await startEngine({
        dataRoot,
        enginePath: testBundlePath,
        env: {
          JARVIS_ENABLE_TEST_HOOKS: "1",
          JARVIS_FAILPOINT: "after-outbox-claim",
          JARVIS_OUTBOX_LEASE_MS: leaseMs,
        },
      });
      await seedProject(crashed, "proj-1");
      await publishPing(crashed, "proj-1");
      await crashed.waitForExit();
      await crashed.dispose();

      const beforeRestart = openDb(dataRoot);
      try {
        const row = beforeRestart
          .prepare("SELECT status, lease_owner, lease_expires_at FROM outbox")
          .get() as { status: string; lease_owner: string | null; lease_expires_at: string | null };
        // Claimed (lease held) but never dispatched: the row must not be
        // silently re-claimable while that lease is still live.
        expect(row.status).toBe("pending");
        expect(row.lease_owner).not.toBeNull();
        expect(row.lease_expires_at).not.toBeNull();
      } finally {
        beforeRestart.close();
      }

      // Real wall-clock wait past the short lease configured above — the
      // production `SystemClock` this engine uses keeps advancing even while
      // the process is dead.
      await new Promise((resolve) => setTimeout(resolve, 400));

      const restarted = await startEngine({
        dataRoot,
        enginePath: testBundlePath,
        env: { JARVIS_ENABLE_TEST_HOOKS: "1", JARVIS_OUTBOX_LEASE_MS: leaseMs },
      });
      try {
        await restarted.waitForStderr("delivery consumed");
      } finally {
        await restarted.dispose();
      }

      const afterRestart = openDb(dataRoot);
      try {
        expect(afterRestart.prepare("SELECT status FROM outbox").get()).toEqual({
          status: "dispatched",
        });
        // Reclaimed and processed exactly once — not stranded, not duplicated.
        expect(afterRestart.prepare("SELECT ping_count FROM sample_probe_state").get()).toEqual({
          ping_count: 1,
        });
      } finally {
        afterRestart.close();
      }
    },
  );
});

describe("durability: the failpoint seam is inert outside tests", () => {
  it(
    "acceptance criterion 7: with JARVIS_FAILPOINT unset, the engine reaches every declared " +
      "boundary (publish, claim, before/after the handler commit) and never crashes",
    async () => {
      const dataRoot = await dataRootFixture();
      // Test hooks are enabled — the pipeline must actually run end to end,
      // reaching all four failpoint call sites — but no failpoint is armed,
      // exactly as a real launch (which never sets this variable at all)
      // leaves it.
      const engine = await startEngine({
        dataRoot,
        enginePath: testBundlePath,
        env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
      });
      try {
        await seedProject(engine, "proj-1");
        const response = await publishPing(engine, "proj-1");
        expect(response.status).toBe(201);

        await engine.waitForStderr("delivery consumed");

        // Still alive: none of the four failpoint call sites had any effect.
        const health = await engine.call("/v1/health");
        expect(health.status).toBe(200);
        expect(await health.json()).toMatchObject({ status: "ready" });
      } finally {
        await engine.dispose();
      }
    },
  );

  it("does not expose the /test/* durability-demo routes on a normally launched engine", async () => {
    const engine = await startEngine();
    try {
      const response = await engine.call("/test/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pingInput("proj-1")),
      });
      expect(response.status).toBe(404);
    } finally {
      await engine.dispose();
    }
  });
});
