import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine, type Harness } from "./harness.js";

const testBundlePath = fileURLToPath(
  new URL("../../../dist/engine/engine.test-bundle.mjs", import.meta.url),
);

const engines: Harness[] = [];
/** Crash scenarios restart a second engine against the same data root, so the
 * harness cannot own it: those roots are created and removed here instead. */
const dataRoots: string[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  await Promise.all(dataRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function waitForEvents(
  engine: Harness,
  projectId: string,
  count: number,
  timeoutMs = 5_000,
): Promise<readonly Record<string, unknown>[]> {
  const startedAt = Date.now();
  for (;;) {
    const response = await engine.call(`/v1/projects/${projectId}/events`);
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { readonly items: readonly Record<string, unknown>[] };
    if (body.items.length >= count) return body.items;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`project ${projectId} did not reach ${count} events`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForExecutions(
  engine: Harness,
  projectId: string,
  count: number,
  timeoutMs = 5_000,
): Promise<readonly Record<string, unknown>[]> {
  const startedAt = Date.now();
  for (;;) {
    const response = await engine.call(`/v1/projects/${projectId}/executions`);
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { readonly items: readonly Record<string, unknown>[] };
    if (body.items.length >= count) return body.items;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`project ${projectId} did not reach ${count} executions`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function tagAddedInput(projectId: string, tag: string, correlationId: string) {
  return {
    type: "scm.work-item.tag-added",
    version: 1,
    kind: "fact" as const,
    projectId,
    producer: { moduleId: "jarvis.module.github", moduleInstanceId: "github" },
    subject: { type: "work-item", ref: `github://acme/${projectId}/issues/8` },
    repositoryId: "main",
    correlationId,
    causationId: null,
    payload: {
      workItemRef: `github://acme/${projectId}/issues/8`,
      tag,
    },
  };
}

function implementationRequestInput(projectId: string, correlationId: string) {
  return {
    type: "development.implementation.requested",
    version: 1,
    kind: "request" as const,
    projectId,
    producer: {
      moduleId: "jarvis.module.automation-rules",
      moduleInstanceId: "automation-rules",
    },
    subject: { type: "work-item", ref: `github://acme/${projectId}/issues/64` },
    repositoryId: "main",
    correlationId,
    causationId: null,
    target: { moduleInstanceId: "missing-worker" },
    idempotencyKey: `${projectId}:missing-target`,
    payload: {
      workItemRef: `github://acme/${projectId}/issues/64`,
      repositoryId: "main",
      baseBranch: "main",
    },
  };
}

describe("Automation Rules Application Harness", () => {
  it("matches once, leaves no-match auditable, routes its request, and stays project-scoped", async () => {
    const engine = await startEngine({
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);

    for (const [projectId, targetMode, ruleTag] of [
      ["project-a", "binding", "agent:ready"],
      ["project-b", "direct", "agent:ready"],
      ["project-c", "binding", "agent:other"],
    ] as const) {
      const response = await engine.call("/test/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: projectId, kind: "automation", targetMode, ruleTag }),
      });
      expect(response.status).toBe(201);
    }

    const matchingResponse = await engine.call("/test/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tagAddedInput("project-a", "agent:ready", "corr_automation_project_a")),
    });
    expect(matchingResponse.status).toBe(201);
    const matchingEvent = (await matchingResponse.json()) as { readonly id: string };

    const directMatchingResponse = await engine.call("/test/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tagAddedInput("project-b", "agent:ready", "corr_automation_project_b")),
    });
    expect(directMatchingResponse.status).toBe(201);

    const unmatchedResponse = await engine.call("/test/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tagAddedInput("project-c", "agent:ready", "corr_automation_project_c")),
    });
    expect(unmatchedResponse.status).toBe(201);

    const projectAEvents = await waitForEvents(engine, "project-a", 2);
    const projectBEvents = await waitForEvents(engine, "project-b", 2);
    const projectCEvents = await waitForEvents(engine, "project-c", 1);
    const projectAExecutions = await waitForExecutions(engine, "project-a", 1);
    const projectBExecutions = await waitForExecutions(engine, "project-b", 1);
    const requests = (events: readonly Record<string, unknown>[]) =>
      events.filter(
        (event) =>
          event["type"] === "development.implementation.requested" && event["kind"] === "request",
      );

    expect(requests(projectAEvents)).toHaveLength(1);
    expect(requests(projectBEvents)).toHaveLength(1);
    expect(projectCEvents).toHaveLength(1);
    expect(projectBEvents.find((event) => event["kind"] === "fact")).toMatchObject({
      ["type"]: "scm.work-item.tag-added",
      ["kind"]: "fact",
      ["correlationId"]: "corr_automation_project_b",
      ["causationId"]: null,
    });
    expect(projectCEvents[0]).toMatchObject({
      ["type"]: "scm.work-item.tag-added",
      ["kind"]: "fact",
      ["correlationId"]: "corr_automation_project_c",
      ["causationId"]: null,
    });
    expect(
      projectAExecutions.filter((execution) => execution["moduleInstanceId"] === "request-worker"),
    ).toEqual([
      expect.objectContaining({ moduleInstanceId: "request-worker", status: "completed" }),
    ]);
    expect(
      projectBExecutions.filter((execution) => execution["moduleInstanceId"] === "request-worker"),
    ).toEqual([
      expect.objectContaining({ moduleInstanceId: "request-worker", status: "completed" }),
    ]);

    const database = new Database(`${engine.dataRoot}/jarvis.sqlite`);
    try {
      const requestRow = database
        .prepare(
          "SELECT id, envelope FROM events WHERE project_id = ? AND kind = 'request' AND type = ?",
        )
        .get("project-a", "development.implementation.requested") as
        { readonly id: string; readonly envelope: string } | undefined;
      expect(requestRow).toBeDefined();
      if (requestRow === undefined) throw new Error("project-a request was not journaled");
      expect(JSON.parse(requestRow.envelope)).toMatchObject({
        projectId: "project-a",
        correlationId: "corr_automation_project_a",
        causationId: matchingEvent.id,
        target: { binding: "implementation" },
      });

      const redeliveryResponse = await engine.call("/test/redeliver", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: "project-a",
          moduleInstanceId: "request-worker",
          moduleId: "jarvis.module.test-request-worker",
          eventId: requestRow.id,
        }),
      });
      expect(redeliveryResponse.status).toBe(200);
      expect(await redeliveryResponse.json()).toMatchObject({
        redelivered: true,
        status: "completed",
        executionId: null,
      });

      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM deliveries WHERE project_id = ? AND event_id = ?")
          .get("project-a", requestRow.id),
      ).toEqual({ count: 1 });
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM executions WHERE project_id = ? AND module_instance_id = ? AND input_event_id = ?",
          )
          .get("project-a", "request-worker", requestRow.id),
      ).toEqual({ count: 1 });

      expect(
        database
          .prepare(
            `SELECT module_instance_id, module_id
             FROM deliveries
             WHERE project_id = ? AND event_id = (
               SELECT id FROM events
               WHERE project_id = ? AND kind = 'request'
                 AND type = 'development.implementation.requested'
             )`,
          )
          .all("project-a", "project-a"),
      ).toEqual([
        { module_instance_id: "request-worker", module_id: "jarvis.module.test-request-worker" },
      ]);

      const projectBRequest = database
        .prepare(
          "SELECT envelope FROM events WHERE project_id = ? AND kind = 'request' AND type = ?",
        )
        .get("project-b", "development.implementation.requested") as
        { readonly envelope: string } | undefined;
      expect(projectBRequest).toBeDefined();
      expect(JSON.parse(projectBRequest?.envelope ?? "{}")).toMatchObject({
        projectId: "project-b",
        correlationId: "corr_automation_project_b",
        target: { moduleInstanceId: "request-worker" },
      });

      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM events WHERE project_id = ? AND kind = 'request'")
          .get("project-c"),
      ).toEqual({ count: 0 });

      const missingTargetResponse = await engine.call("/test/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          implementationRequestInput("project-a", "corr_automation_missing_target"),
        ),
      });
      expect(missingTargetResponse.status).toBe(201);
      const missingTargetEvent = (await missingTargetResponse.json()) as { readonly id: string };
      await engine.waitForStderr("request-consumer-not-found");

      // Invalid Request routing is logged and remains pending atomically:
      // there is no journal entry or Delivery to acknowledge.
      expect(
        database.prepare("SELECT id FROM events WHERE id = ?").get(missingTargetEvent.id),
      ).toBeUndefined();
      expect(
        database.prepare("SELECT status FROM outbox WHERE event_id = ?").get(missingTargetEvent.id),
      ).toEqual({ status: "pending" });
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM deliveries WHERE event_id = ?")
          .get(missingTargetEvent.id),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});

const IMPLEMENTATION_REQUESTED = "development.implementation.requested";

/** Rules that both match `agent:ready`, told apart only by the branch each one
 * statically configures — so the emitted Request names the Rule that won. Pass
 * `undefined` for the reference shape, which configures no `emit.payload` at
 * all and derives the whole payload. */
function rule(id: string, tag: string, baseBranch: string | undefined) {
  return {
    id,
    when: { eventType: "scm.work-item.tag-added", equals: { "payload.tag": tag } },
    emit: {
      type: IMPLEMENTATION_REQUESTED,
      target: { moduleInstanceId: "request-worker" },
      ...(baseBranch === undefined ? {} : { payload: { baseBranch } }),
    },
  };
}

const seedRuleSet = (engine: Harness, id: string, rules: readonly unknown[]) =>
  engine.call("/test/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, kind: "automation", targetMode: "direct", rules }),
  });

const injectTagAdded = (engine: Harness, projectId: string) =>
  engine.call("/test/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(tagAddedInput(projectId, "agent:ready", `corr_${projectId}`)),
  });

function requestEnvelopes(
  database: Database.Database,
  projectId: string,
): readonly Record<string, unknown>[] {
  return (
    database
      .prepare(
        "SELECT envelope FROM events WHERE project_id = ? AND kind = 'request' AND type = ? ORDER BY id",
      )
      .all(projectId, IMPLEMENTATION_REQUESTED) as readonly { readonly envelope: string }[]
  ).map((row) => JSON.parse(row.envelope) as Record<string, unknown>);
}

describe("Automation Rules Rule Set semantics", () => {
  it("stops at the first matching Rule, so order selects the emission and a contract-invalid one fails terminally", async () => {
    const engine = await startEngine({
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);

    // "later-match": the first Rule cannot match, so evaluation continues and
    // `alpha` — the first Rule that does match — wins over the equally
    // matching `beta` behind it.
    expect(
      (
        await seedRuleSet(engine, "later-match", [
          rule("never", "agent:never", "unreachable"),
          rule("alpha", "agent:ready", "alpha-branch"),
          rule("beta", "agent:ready", "beta-branch"),
        ])
      ).status,
    ).toBe(201);
    // The same two matching Rules in the opposite order: reordering the Rule
    // Set is the only difference, and it changes which Rule is selected.
    expect(
      (
        await seedRuleSet(engine, "reversed", [
          rule("beta", "agent:ready", "beta-branch"),
          rule("alpha", "agent:ready", "alpha-branch"),
        ])
      ).status,
    ).toBe(201);
    // A matching Rule whose static payload the Request contract rejects
    // (`additionalProperties: false`): the emission must be refused before
    // publication, not repaired.
    expect(
      (
        await seedRuleSet(engine, "invalid-output", [
          {
            id: "invalid",
            when: {
              eventType: "scm.work-item.tag-added",
              equals: { "payload.tag": "agent:ready" },
            },
            emit: {
              type: IMPLEMENTATION_REQUESTED,
              target: { moduleInstanceId: "request-worker" },
              payload: { notInTheContract: "s3cret-looking-configured-value" },
            },
          },
        ])
      ).status,
    ).toBe(201);

    expect(
      (await seedRuleSet(engine, "unknown-repo", [rule("alpha", "agent:ready", undefined)])).status,
    ).toBe(201);

    const laterMatchFact = (await (await injectTagAdded(engine, "later-match")).json()) as {
      readonly id: string;
    };
    expect((await injectTagAdded(engine, "reversed")).status).toBe(201);
    const invalidFact = (await (await injectTagAdded(engine, "invalid-output")).json()) as {
      readonly id: string;
    };

    // A Fact naming a repository this Project's composition does not carry:
    // the Rule configures no branch, and no project-scoped source supplies one.
    const unknownRepoFact = (await (
      await engine.call("/test/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...tagAddedInput("unknown-repo", "agent:ready", "corr_unknown_repository"),
          repositoryId: "not-in-this-composition",
        }),
      })
    ).json()) as { readonly id: string };

    await waitForExecutions(engine, "later-match", 2);
    await waitForExecutions(engine, "reversed", 2);
    await waitForExecutions(engine, "unknown-repo", 1);
    // The failing Project produces no Request, so its Rules Execution is the
    // only one it will ever have.
    await waitForExecutions(engine, "invalid-output", 1);

    const database = new Database(`${engine.dataRoot}/jarvis.sqlite`);
    try {
      expect(requestEnvelopes(database, "later-match")).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ baseBranch: "alpha-branch" }),
        }),
      ]);
      expect(requestEnvelopes(database, "reversed")).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ baseBranch: "beta-branch" }),
        }),
      ]);

      // A contract-invalid emission is an auditable terminal failure: the Fact
      // stays journaled, the Rules Execution is `failed`, and nothing partial
      // reaches the Outbox or a downstream consumer.
      expect(requestEnvelopes(database, "invalid-output")).toEqual([]);
      const failed = database
        .prepare(
          "SELECT status, error FROM executions WHERE project_id = ? AND module_instance_id = ?",
        )
        .get("invalid-output", "automation-rules") as {
        readonly status: string;
        readonly error: string;
      };
      expect(failed.status).toBe("failed");
      // The recorded diagnostic names the contract violation and nothing else:
      // it must not echo the offending configuration value back into the
      // Ledger (AGENTS.md invariant 10).
      expect(failed.error).toContain("/payload must NOT have additional properties");
      expect(failed.error).not.toContain("s3cret-looking-configured-value");
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM outbox WHERE project_id = ?")
          .get("invalid-output"),
      ).toEqual({ count: 1 });
      expect(
        database.prepare("SELECT id FROM events WHERE id = ?").get(invalidFact.id),
      ).toBeDefined();

      // The branch is rejected, never borrowed from another repository in the
      // composition: no Request, an auditable failed Execution, Fact retained.
      expect(requestEnvelopes(database, "unknown-repo")).toEqual([]);
      const unresolved = database
        .prepare(
          "SELECT status, error FROM executions WHERE project_id = ? AND module_instance_id = ?",
        )
        .get("unknown-repo", "automation-rules") as {
        readonly status: string;
        readonly error: string;
      };
      expect(unresolved.status).toBe("failed");
      expect(unresolved.error).toContain("baseBranch");
      expect(
        database.prepare("SELECT id FROM events WHERE id = ?").get(unknownRepoFact.id),
      ).toBeDefined();

      // Acceptance criterion 9: the same Fact delivered twice to the same
      // Rules Instance returns the recorded result and creates no second Rule
      // Match, Request or Execution.
      const redelivery = await engine.call("/test/redeliver", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: "later-match",
          moduleInstanceId: "automation-rules",
          moduleId: "jarvis.module.automation-rules",
          eventId: laterMatchFact.id,
        }),
      });
      expect(await redelivery.json()).toMatchObject({
        redelivered: true,
        status: "completed",
        executionId: null,
      });
      expect(requestEnvelopes(database, "later-match")).toHaveLength(1);
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM executions WHERE project_id = ? AND module_instance_id = ?",
          )
          .get("later-match", "automation-rules"),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("emits nothing when a crash precedes the Rules handler's commit, then emits exactly once after restart", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "jarvis-rules-"));
    dataRoots.push(dataRoot);

    const crashed = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1", JARVIS_FAILPOINT: "before-handler-commit" },
    });
    expect(
      (await seedRuleSet(crashed, "crash-before", [rule("alpha", "agent:ready", "alpha-branch")]))
        .status,
    ).toBe(201);
    // The publish itself is unaffected; the engine dies later, inside the
    // background loop's own consume of the Rules Delivery.
    expect((await injectTagAdded(crashed, "crash-before")).status).toBe(201);
    await crashed.waitForExit();
    await crashed.dispose();

    const beforeRestart = new Database(join(dataRoot, "jarvis.sqlite"));
    try {
      // No business decision survived the rolled-back transaction.
      expect(requestEnvelopes(beforeRestart, "crash-before")).toEqual([]);
      expect(beforeRestart.prepare("SELECT COUNT(*) AS count FROM executions").get()).toEqual({
        count: 0,
      });
      expect(beforeRestart.prepare("SELECT 1 FROM inbox").get()).toBeUndefined();
    } finally {
      beforeRestart.close();
    }

    const restarted = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(restarted);
    await waitForExecutions(restarted, "crash-before", 2);

    const afterRestart = new Database(join(dataRoot, "jarvis.sqlite"));
    try {
      // The pending Delivery was processed once, not twice.
      expect(requestEnvelopes(afterRestart, "crash-before")).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ baseBranch: "alpha-branch" }),
        }),
      ]);
      expect(
        afterRestart
          .prepare("SELECT COUNT(*) AS count FROM executions WHERE module_instance_id = ?")
          .get("automation-rules"),
      ).toEqual({ count: 1 });
    } finally {
      afterRestart.close();
    }
  });

  it("keeps its one Request durable when a crash follows the Rules handler's commit", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "jarvis-rules-"));
    dataRoots.push(dataRoot);

    const crashed = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1", JARVIS_FAILPOINT: "after-handler-commit" },
    });
    expect(
      (await seedRuleSet(crashed, "crash-after", [rule("alpha", "agent:ready", "alpha-branch")]))
        .status,
    ).toBe(201);
    const fact = (await (await injectTagAdded(crashed, "crash-after")).json()) as {
      readonly id: string;
    };
    await crashed.waitForExit();
    await crashed.dispose();

    const restarted = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(restarted);
    // The Rules Execution committed before the crash; the Request it published
    // was still an undispatched Outbox row, which this restart drains.
    await waitForExecutions(restarted, "crash-after", 2);

    // The Delivery was acknowledged in the same committed transaction, so the
    // loop has nothing to retry: a genuine at-least-once redelivery has to be
    // requested explicitly, exactly as one would arrive from outside.
    const redelivery = await restarted.call("/test/redeliver", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "crash-after",
        moduleInstanceId: "automation-rules",
        moduleId: "jarvis.module.automation-rules",
        eventId: fact.id,
      }),
    });
    expect(await redelivery.json()).toMatchObject({
      redelivered: true,
      status: "completed",
      executionId: null,
    });

    const database = new Database(join(dataRoot, "jarvis.sqlite"));
    try {
      expect(requestEnvelopes(database, "crash-after")).toEqual([
        expect.objectContaining({
          causationId: fact.id,
          payload: expect.objectContaining({ baseBranch: "alpha-branch" }),
        }),
      ]);
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM executions WHERE module_instance_id = ?")
          .get("automation-rules"),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });
});
