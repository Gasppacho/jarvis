import Database from "better-sqlite3";
import { seedActivatedConsumerProject } from "./activated-project-fixture.js";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startEngine, startFakeGitHubApi, type FakeGitHubApi, type Harness } from "./harness.js";
import { ExecutionCheckpointStore } from "../src/executions/checkpoints.js";
import type { components } from "../src/api/generated/local-api.js";
import { explain, localApiValidator } from "./contract.js";
import type { PortableProjectConfiguration } from "../../../packages/project-runtime/src/project-types.js";
import { SystemClock } from "../../../packages/kernel/src/clock.js";
import { WorkItemReadinessStore } from "../../../packages/modules/github/src/work-item-readiness.js";
import {
  makeRealGitRepositoryFixture,
  type RealGitRepositoryFixture,
} from "./repository-fixture.js";

const testBundlePath = fileURLToPath(
  new URL("../../../dist/engine/engine.test-bundle.mjs", import.meta.url),
);
const engines: Harness[] = [];
const roots: string[] = [];
const servers: FakeGitHubApi[] = [];
const githubEnvironments: Array<{
  readonly executable: string | undefined;
  readonly apiBaseUrl: string | undefined;
}> = [];

beforeEach(async () => {
  githubEnvironments.push({
    executable: process.env["JARVIS_GH_EXECUTABLE"],
    apiBaseUrl: process.env["JARVIS_GITHUB_API_BASE_URL"],
  });
  const root = mkdtempSync(join("/tmp", "jarvis-development-gh-"));
  roots.push(root);
  const executable = join(root, "gh");
  writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' 'ghs_development_fixture'\n", "utf8");
  chmodSync(executable, 0o755);
  const server = await startFakeGitHubApi();
  servers.push(server);
  process.env["JARVIS_GH_EXECUTABLE"] = executable;
  process.env["JARVIS_GITHUB_API_BASE_URL"] = server.baseUrl;
});

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  const environment = githubEnvironments.pop()!;
  if (environment.executable === undefined) delete process.env["JARVIS_GH_EXECUTABLE"];
  else process.env["JARVIS_GH_EXECUTABLE"] = environment.executable;
  if (environment.apiBaseUrl === undefined) delete process.env["JARVIS_GITHUB_API_BASE_URL"];
  else process.env["JARVIS_GITHUB_API_BASE_URL"] = environment.apiBaseUrl;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Development Module tracer bullet", () => {
  it("serializes three issues through real agents and PRs, preserving waiting identities across restart and suspension", async () => {
    const { engine, fixture } = await admissionFixture("serial", "await-signal");
    const database = new Database(join(engine.dataRoot, "jarvis.sqlite"));
    const observedEventIds: string[] = [];
    try {
      for (const number of [1, 2, 3]) {
        seedReadyIssue(number);
        const observedEventId = await publishObserved(
          engine,
          "serial",
          `github://Gasppacho/jarvis/issues/${number}`,
          1,
          "open",
          ["ready-to-dev"],
        );
        observedEventIds.push(observedEventId);
        await expect
          .poll(() =>
            database
              .prepare(
                "SELECT count(*) AS n FROM deliveries WHERE module_id = 'jarvis.module.development' AND event_id = ?",
              )
              .get(observedEventId),
          )
          .toEqual({ n: 1 });
      }
      await expect
        .poll(
          async () => (await admissionItems(engine, "serial")).map((item) => item.workItemRef),
          {
            timeout: 5_000,
          },
        )
        .toEqual(["github://Gasppacho/jarvis/issues/2", "github://Gasppacho/jarvis/issues/3"]);
      const waiting = await admissionItems(engine, "serial");
      // Upgrade compatibility: Requests emitted before #194 omitted tag,
      // but their original causal label Fact remains durable.
      database
        .prepare("UPDATE events SET envelope = json_remove(envelope, '$.payload.tag') WHERE id = ?")
        .run(waiting[0]!.eventId);
      const activeClaim = database
        .prepare(
          "SELECT lease_owner FROM deliveries WHERE module_id = 'jarvis.module.development' AND lease_owner IS NOT NULL",
        )
        .get();
      expect(activeClaim).toMatchObject({ lease_owner: expect.any(String) });
      // The test engine lease is 200ms; dispatching a further fact spans
      // another tick and must renew the same running handler's ownership.
      observedEventIds.push(
        await publishObserved(engine, "serial", "fixture://heartbeat", 1, "open", ["not-ready"]),
      );
      await expect
        .poll(() =>
          database
            .prepare(
              `SELECT count(*) AS n
               FROM executions
               JOIN events ON events.id = executions.input_event_id
               WHERE executions.project_id = 'serial'
                 AND executions.module_instance_id = 'development'
                 AND events.type = 'scm.work-item.observed'
                 AND events.id IN (${observedEventIds.map(() => "?").join(", ")})`,
            )
            .get(...observedEventIds),
        )
        .toEqual({ n: 4 });
      expect(
        database
          .prepare(
            "SELECT lease_owner FROM deliveries WHERE module_id = 'jarvis.module.development' AND lease_owner IS NOT NULL",
          )
          .get(),
      ).toEqual(activeClaim);
      await engine.call("/v1/projects/serial/development-admission/suspend", { method: "POST" });
      await releaseAdmissionAgent(engine, database, "serial", 1);
      await expect.poll(() => servers[0]!.pullRequests.length).toBe(1);
      expect(await admissionItems(engine, "serial")).toEqual(
        waiting.map((item) => ({ ...item, status: "suspended", reason: "admission-suspended" })),
      );

      await engine.dispose();
      await engine.waitForExit();
      const restarted = await startEngine({
        dataRoot: engine.dataRoot,
        enginePath: testBundlePath,
        env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
      });
      engines.push(restarted);
      expect(await admissionItems(restarted, "serial")).toEqual(
        waiting.map((item) => ({ ...item, status: "suspended", reason: "admission-suspended" })),
      );
      await restarted.call("/v1/projects/serial/development-admission/resume", { method: "POST" });
      for (const number of [2, 3]) {
        await releaseAdmissionAgent(restarted, database, "serial", number);
        await expect.poll(() => servers[0]!.pullRequests.length).toBe(number);
      }
      expect(await admissionItems(restarted, "serial")).toEqual([]);
      expect(
        database
          .prepare(
            "SELECT attempt_count FROM deliveries JOIN events ON events.id = deliveries.event_id WHERE deliveries.module_id = 'jarvis.module.development' AND events.type = 'development.implementation.requested'",
          )
          .all(),
      ).toEqual([{ attempt_count: 1 }, { attempt_count: 1 }, { attempt_count: 1 }]);
      expect(database.prepare("SELECT count(*) AS n FROM dead_letters").get()).toEqual({ n: 0 });
      expect(
        database
          .prepare(
            "SELECT count(*) AS n FROM executions JOIN events ON events.id = executions.input_event_id WHERE executions.module_id = 'jarvis.module.development' AND events.type = 'development.implementation.requested'",
          )
          .get(),
      ).toEqual({ n: 3 });
      expect(servers[0]!.pullRequests.map((pr) => pr.head)).toEqual(
        [1, 2, 3].map((number) =>
          expect.stringMatching(new RegExp(`^agent/${number}-ready-${number}-exec-`)),
        ),
      );
      for (const pr of servers[0]!.pullRequests)
        expect(git(fixture.remoteRoot, ["rev-parse", `refs/heads/${pr.head}`])).toMatch(
          /^[0-9a-f]{40}$/,
        );
      await restarted.call("/v1/projects/serial/development-admission/resume", { method: "POST" });
      expect(await admissionItems(restarted, "serial")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it.each(["closed", "label-removed", "blocked", "unavailable"] as const)(
    "rechecks %s candidates without starving another ready issue",
    async (change) => {
      const { engine } = await admissionFixture(`recheck-${change}`, "await-signal");
      const projectId = `recheck-${change}`;
      const database = new Database(join(engine.dataRoot, "jarvis.sqlite"));
      try {
        for (const number of [1, 2, 3]) {
          seedReadyIssue(number);
          await publishObserved(
            engine,
            projectId,
            `github://Gasppacho/jarvis/issues/${number}`,
            1,
            "open",
            ["ready-to-dev"],
          );
          await expect
            .poll(() =>
              database
                .prepare(
                  "SELECT count(*) AS n FROM deliveries JOIN events ON events.id = deliveries.event_id WHERE deliveries.module_id = 'jarvis.module.development' AND events.type = 'scm.work-item.observed'",
                )
                .get(),
            )
            .toEqual({ n: number });
        }
        if (change === "closed" || change === "label-removed") seedReadyIssue(2, change);
        else
          servers[0]!.scriptRoute(
            "GET",
            change === "blocked"
              ? "/repos/Gasppacho/jarvis/issues/2/dependencies/blocked_by?per_page=100&page=1"
              : "/repos/Gasppacho/jarvis/issues/2",
            {
              status: change === "blocked" ? 200 : 503,
              body:
                change === "blocked" ? [{ number: 9, state: "open" }] : { message: "unavailable" },
            },
          );
        await releaseAdmissionAgent(engine, database, projectId, 1);
        await expect
          .poll(
            async () =>
              (await admissionItems(engine, projectId)).find((item) =>
                item.workItemRef.endsWith("/2"),
              )?.status,
          )
          .toBe(
            change === "blocked"
              ? "blocked"
              : change === "unavailable"
                ? "impossible"
                : "ineligible",
          );
        await releaseAdmissionAgent(engine, database, projectId, 3);
        await expect.poll(() => servers[0]!.pullRequests.length).toBe(2);
        expect(
          database
            .prepare(
              "SELECT attempt_count FROM deliveries JOIN events ON events.id = deliveries.event_id WHERE deliveries.module_id = 'jarvis.module.development' AND events.type = 'development.implementation.requested' AND json_extract(events.envelope, '$.payload.workItemRef') LIKE '%/2'",
            )
            .get(),
        ).toEqual({ attempt_count: 0 });
        expect(database.prepare("SELECT count(*) AS n FROM dead_letters").get()).toEqual({ n: 0 });
        expect(servers[0]!.pullRequests.map((pr) => pr.head)).toEqual([
          expect.stringMatching(/^agent\/1-ready-1-exec-/),
          expect.stringMatching(/^agent\/3-ready-3-exec-/),
        ]);
        if (change === "blocked" || change === "unavailable") {
          seedReadyIssue(2);
          servers[0]!.scriptRoute("GET", "/repos/Gasppacho/jarvis/issues/2", {
            status: 200,
            body: {
              number: 2,
              title: "Ready 2",
              body: "Complete",
              state: "open",
              labels: [{ name: "ready-to-dev" }],
            },
          });
          servers[0]!.scriptRoute(
            "GET",
            "/repos/Gasppacho/jarvis/issues/2/dependencies/blocked_by?per_page=100&page=1",
            { status: 200, body: [{ number: 9, state: "closed" }] },
          );
          await engine.call(`/v1/projects/${projectId}/development-admission/resume`, {
            method: "POST",
          });
          await releaseAdmissionAgent(engine, database, projectId, 2);
          await expect.poll(() => servers[0]!.pullRequests.length).toBe(3);
        }
      } finally {
        database.close();
      }
    },
  );

  it("stages module removal without replacing a paused project's active snapshot", async () => {
    const projectId = "paused-module-removal";
    const { engine } = await admissionFixture(projectId, "await-signal");
    expect((await engine.call(`/v1/projects/${projectId}/pause`, { method: "POST" })).status).toBe(
      200,
    );
    await publishTag(engine, projectId, "pending", 1, "github://Gasppacho/jarvis/issues/1");
    const database = new Database(join(engine.dataRoot, "jarvis.sqlite"));
    try {
      await expect
        .poll(() =>
          database
            .prepare(
              "SELECT COUNT(*) AS n FROM deliveries WHERE project_id = ? AND consumed_at IS NULL",
            )
            .get(projectId),
        )
        .toEqual({ n: 1 });
      const detail = (await (await engine.call(`/v1/projects/${projectId}`)).json()) as {
        portableConfig: PortableProjectConfiguration;
      };
      const removal = await engine.call(`/v1/projects/${projectId}/configuration`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          portableConfig: {
            ...detail.portableConfig,
            modules: detail.portableConfig.modules.filter(
              (module) => module.moduleId !== "jarvis.module.development",
            ),
          },
          writeToRepository: false,
        }),
      });
      expect(removal.status, await removal.clone().text()).toBe(200);
      expect((await removal.json()) as { status: string }).toMatchObject({ status: "paused" });
      const activeSnapshot = database
        .prepare("SELECT resolved_project FROM project_resolved_compositions WHERE project_id = ?")
        .get(projectId) as { resolved_project: string };
      const resolved = JSON.parse(activeSnapshot.resolved_project) as {
        composition: PortableProjectConfiguration;
      };
      expect(
        resolved.composition.modules.some(
          (module) => module.moduleId === "jarvis.module.development",
        ),
      ).toBe(true);
    } finally {
      database.close();
    }
  });

  it("reawakens a fixed dormant candidate only after a newer eligible observation", async () => {
    const { engine } = await admissionFixture("fixed-reopen", "await-signal");
    const projectId = "fixed-reopen";
    const database = new Database(join(engine.dataRoot, "jarvis.sqlite"));
    const firstRef = "github://Gasppacho/jarvis/issues/1";
    const secondRef = "github://Gasppacho/jarvis/issues/2";
    try {
      for (const number of [1, 2]) {
        servers[0]!.seedIssue({
          owner: "Gasppacho",
          repository: "jarvis",
          issue: {
            number,
            title: `Fixed reopen ${number}`,
            body: "Complete untrusted work item",
            state: "open",
            labels: [{ name: "ready-to-dev" }],
            blockedBy: [],
          },
        });
      }
      await publishObserved(engine, projectId, firstRef, 1, "open", ["ready-to-dev"]);
      await expect.poll(() => activeAdmissionRef(database, projectId)).toBe(firstRef);
      await publishObserved(engine, projectId, secondRef, 1, "open", ["ready-to-dev"]);
      await expect
        .poll(() =>
          database
            .prepare(
              "SELECT count(*) AS n FROM deliveries WHERE project_id = ? AND module_id = 'jarvis.module.development'",
            )
            .get(projectId),
        )
        .toEqual({ n: 2 });

      servers[0]!.seedIssue({
        owner: "Gasppacho",
        repository: "jarvis",
        issue: {
          number: 2,
          title: "Fixed reopen 2",
          body: "Complete untrusted work item",
          state: "closed",
          labels: [],
          blockedBy: [],
        },
      });
      await publishObserved(engine, projectId, secondRef, 2, "closed", []);
      await releaseAdmissionAgent(engine, database, projectId, 1);
      await expect
        .poll(() => workItemReadinessStatus(database, projectId, secondRef))
        .toBe("blocked");
      await expect.poll(() => activeAdmissionRef(database, projectId)).toBeUndefined();
      const secondDelivery = database
        .prepare(
          `SELECT deliveries.consumed_at, deliveries.attempt_count
           FROM deliveries JOIN events ON events.id = deliveries.event_id
           WHERE deliveries.project_id = ?
             AND events.type = 'development.implementation.requested'
             AND json_extract(events.envelope, '$.payload.workItemRef') = ?`,
        )
        .get(projectId, secondRef) as {
        readonly consumed_at: string | null;
        readonly attempt_count: number;
      };
      if (secondDelivery !== undefined) {
        expect(secondDelivery).toEqual({ consumed_at: null, attempt_count: 0 });
      }
      expect(activeAdmissionRef(database, projectId)).toBeUndefined();

      servers[0]!.seedIssue({
        owner: "Gasppacho",
        repository: "jarvis",
        issue: {
          number: 2,
          title: "Fixed reopen 2",
          body: "Complete untrusted work item",
          state: "open",
          labels: [{ name: "ready-to-dev" }],
          blockedBy: [],
        },
      });
      await publishObserved(engine, projectId, secondRef, 3, "open", ["ready-to-dev"]);
      await expect
        .poll(() => workItemReadinessStatus(database, projectId, secondRef))
        .toBe("ready");
      await expect.poll(() => activeAdmissionRef(database, projectId)).toBe(secondRef);
      expect(
        database
          .prepare(
            `SELECT count(*) AS n FROM events
             WHERE project_id = ? AND type = 'development.implementation.requested'
               AND json_extract(envelope, '$.payload.workItemRef') = ?`,
          )
          .get(projectId, secondRef),
      ).toEqual({ n: 1 });
      await releaseAdmissionAgent(engine, database, projectId, 2);
    } finally {
      database.close();
    }
  });

  it("keeps other projects and facts progressing while a Development agent is active", async () => {
    const first = makeRealGitRepositoryFixture();
    const second = makeRealGitRepositoryFixture();
    roots.push(first.root, first.remoteRoot, second.root, second.remoteRoot);
    const engine = await startEngine({
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);
    await activateProject(engine, "admission-a", first, "ignore-terminate");
    await activateProject(engine, "admission-b", second);
    await publishTag(engine, "admission-a", "held");
    const running = await waitForExecution(engine, "admission-a", "development", "running");
    await waitForPid(
      join(
        engine.dataRoot,
        "projects",
        "admission-a",
        "workspaces",
        running.id,
        "fake-runtime-child.pid",
      ),
    );
    try {
      await publishTag(engine, "admission-b", "independent");
      await waitForExecution(engine, "admission-b", "development", "completed");
      await publishTag(engine, "admission-a", "queued");
      await expect
        .poll(async () => {
          const response = await engine.call("/v1/projects/admission-a/development-admission");
          return ((await response.json()) as { items: { workItemRef: string }[] }).items.map(
            (item) => item.workItemRef,
          );
        })
        .toEqual(["fixture://admission-a/queued"]);
    } finally {
      await engine.call(`/v1/executions/${running.id}/cancel`, { method: "POST" });
      await waitForExecution(engine, "admission-a", "development", "cancelled");
    }
  });

  it("keeps a closed GitHub Issue pending without a workspace, retry, or dead letter", async () => {
    const fixture = makeRealGitRepositoryFixture({
      remoteUrl: "git@github.com:Gasppacho/jarvis.git",
      additionalRemotes: [{ name: "github", url: "git@github.com:Gasppacho/jarvis.git" }],
    });
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-pending-closed-"));
    roots.push(dataRoot);
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);
    const missing = await engine.call("/v1/projects/missing/development-admission");
    expect(missing.status).toBe(404);
    expect((await missing.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "project.not-found" },
    });
    const github = servers[0]!;
    const workItemRef = "github://Gasppacho/jarvis/issues/44";
    github.seedIssue({
      owner: "Gasppacho",
      repository: "jarvis",
      issue: {
        number: 44,
        title: "Closed while waiting",
        body: "External body must not be persisted.",
        state: "closed",
        labels: [{ name: "ready-to-dev" }],
      },
    });

    await activateProject(
      engine,
      "development-pending-closed",
      fixture,
      false,
      300_000,
      1_048_576,
      { test: "node --test" },
      false,
      "origin",
      "runtime/fake-test",
      { github: true },
    );
    await publishObserved(engine, "development-pending-closed", workItemRef, 1, "open", [
      "ready-to-dev",
    ]);
    await waitForAdmission(dataRoot, "development-pending-closed", "ineligible");
    const admission = await engine.call(
      "/v1/projects/development-pending-closed/development-admission",
    );
    expect(admission.status, await admission.clone().text()).toBe(200);
    expect(await admission.json()).toMatchObject({
      suspended: false,
      items: [
        {
          workItemRef,
          status: "ineligible",
          reason: "work-item-closed",
        },
      ],
    });
    const suspended = await engine.call(
      "/v1/projects/development-pending-closed/development-admission/suspend",
      { method: "POST" },
    );
    expect(await suspended.json()).toMatchObject({ suspended: true });
    const resumed = await engine.call(
      "/v1/projects/development-pending-closed/development-admission/resume",
      { method: "POST" },
    );
    expect(await resumed.json()).toMatchObject({ suspended: false });

    github.seedIssue({
      owner: "Gasppacho",
      repository: "jarvis",
      issue: {
        number: 44,
        title: "Reopened after removal",
        body: "Complete",
        state: "open",
        labels: [{ name: "ready-to-dev" }],
      },
    });
    await engine.call("/v1/projects/development-pending-closed/development-admission/resume", {
      method: "POST",
    });

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM dead_letters WHERE module_instance_id = 'development'",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM workspace_leases").get()).toEqual({
        count: 0,
      });
      expect(
        database
          .prepare(
            `SELECT COALESCE(
               (SELECT attempt_count FROM deliveries
                JOIN events ON events.id = deliveries.event_id
                WHERE deliveries.project_id = ?
                  AND deliveries.module_instance_id = 'development'
                  AND events.type = 'development.implementation.requested'
                  AND json_extract(events.envelope, '$.payload.workItemRef') = ?),
               0
             ) AS attempt_count`,
          )
          .get("development-pending-closed", workItemRef),
      ).toEqual({ attempt_count: 0 });
      expect(
        database
          .prepare(
            "SELECT consumed_at FROM deliveries WHERE project_id = ? AND module_instance_id = 'development' AND event_id IN (SELECT id FROM events WHERE type = 'scm.work-item.observed' AND json_extract(envelope, '$.payload.workItemRef') = ?)",
          )
          .get("development-pending-closed", workItemRef),
      ).toMatchObject({ consumed_at: expect.any(String) });
    } finally {
      database.close();
    }
  });

  it("does not start a new Development workspace while admission is suspended, then resumes it", async () => {
    const fixture = makeRealGitRepositoryFixture({
      remoteUrl: "git@github.com:Gasppacho/jarvis.git",
      additionalRemotes: [{ name: "github", url: "git@github.com:Gasppacho/jarvis.git" }],
    });
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-suspended-"));
    roots.push(dataRoot);
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);
    const github = servers[0]!;
    const workItemRef = "github://Gasppacho/jarvis/issues/45";
    github.seedIssue({
      owner: "Gasppacho",
      repository: "jarvis",
      issue: {
        number: 45,
        title: "Suspended before start",
        body: "External body must not be persisted.",
        state: "open",
        labels: [{ name: "ready-to-dev" }],
      },
    });
    await activateProject(
      engine,
      "development-suspended",
      fixture,
      false,
      300_000,
      1_048_576,
      { test: "node --test" },
      false,
      "origin",
      "runtime/fake-test",
      { github: true },
    );
    const suspended = await engine.call(
      "/v1/projects/development-suspended/development-admission/suspend",
      { method: "POST" },
    );
    expect(suspended.status).toBe(200);
    await publishObserved(engine, "development-suspended", workItemRef, 1, "open", [
      "ready-to-dev",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM workspace_leases WHERE project_id = 'development-suspended'",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM executions WHERE project_id = 'development-suspended' AND module_instance_id = 'development'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }

    const resumed = await engine.call(
      "/v1/projects/development-suspended/development-admission/resume",
      { method: "POST" },
    );
    expect(resumed.status).toBe(200);
    const executions = await waitForExecutions(engine, "development-suspended", 2);
    expect(executions.some(({ moduleInstanceId }) => moduleInstanceId === "development")).toBe(
      true,
    );
  });

  it("reads the bound open GitHub Issue before allocating and running Development", async () => {
    const fixture = makeRealGitRepositoryFixture({
      remoteUrl: "git@github.com:Gasppacho/jarvis.git",
    });
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-work-item-"));
    roots.push(dataRoot);
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);
    const github = servers[0]!;
    const workItemRef = "github://Gasppacho/jarvis/issues/42";
    github.seedIssue({
      owner: "Gasppacho",
      repository: "jarvis",
      issue: {
        number: 42,
        title: "Read verified issue",
        body: "External untrusted body",
        state: "open",
        labels: [{ name: "ready-to-dev" }],
      },
    });

    await activateProject(engine, "development-work-item", fixture);
    await publishTag(engine, "development-work-item", "work-item", 1, workItemRef);
    const executions = await waitForExecutions(engine, "development-work-item", 1);
    const development = executions.find(
      ({ moduleInstanceId }) => moduleInstanceId === "development",
    );
    expect(development, JSON.stringify(executions)).toMatchObject({
      status: "failed",
      error: "The configured remote does not point to the committed working branch.",
    });
    expect(github.requests).toContainEqual({
      method: "GET",
      path: "/repos/Gasppacho/jarvis/issues/42",
      credential: "ghs_development_fixture",
    });
    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(
        database
          .prepare(
            "SELECT type FROM execution_checkpoints WHERE execution_id = ? ORDER BY sequence",
          )
          .all(development!.id),
      ).toEqual(expect.arrayContaining([{ type: "agent.started" }]));
      expect(
        database
          .prepare("SELECT message FROM dead_letters WHERE module_instance_id = 'development'")
          .get(),
      ).not.toMatchObject({ message: expect.stringContaining("External untrusted body") });
    } finally {
      database.close();
    }
  });

  it("runs a project-bound Codex Runtime through a fake executable", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-codex-"));
    roots.push(dataRoot);
    const executable = join(dataRoot, "fake-codex");
    writeFileSync(
      executable,
      `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.153.4\\n");
  process.exit(0);
}
if (process.argv.includes("login") && process.argv.includes("status")) {
  process.stderr.write("Logged in using ChatGPT\\n");
  process.exit(0);
}
fs.appendFileSync("run-order.txt", "agent\\n");
fs.writeFileSync("codex-runtime-change.txt", "Codex runtime change\\n");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ type: "item.completed", item: { type: "file_change", id: "change-1", changes: [{ path: "codex-runtime-change.txt" }] } });
emit({ type: "item.completed", item: { type: "agent_message", text: "Codex Runtime applied deterministic change." } });
emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
`,
      "utf8",
    );
    chmodSync(executable, 0o755);

    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);

    const database = new Database(join(dataRoot, "jarvis.sqlite"));
    database
      .prepare(
        `INSERT INTO runtime_descriptors
           (id, provider, display_name, executable_path, version, capabilities, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           display_name = excluded.display_name,
           executable_path = excluded.executable_path,
           version = excluded.version,
           capabilities = excluded.capabilities,
           status = excluded.status`,
      )
      .run(
        "runtime/codex-default",
        "codex",
        "Codex — default",
        executable,
        "0.153.4",
        JSON.stringify(["agent.execute"]),
        "available",
      );
    database.close();

    const before = repositoryState(fixture.root);
    const projectId = "development-codex";
    await activateProject(
      engine,
      projectId,
      fixture,
      false,
      300_000,
      1_048_576,
      {},
      false,
      "origin",
      "runtime/codex-default",
    );
    await publishTag(engine, projectId, "codex");
    const executions = await waitForExecutions(engine, projectId, 1);
    expect(
      executions.find(({ moduleInstanceId }) => moduleInstanceId === "development"),
      JSON.stringify(executions),
    ).toMatchObject({
      status: "completed",
    });
    expect(repositoryState(fixture.root)).toEqual(before);

    const readonly = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      const row = readonly
        .prepare(
          "SELECT result FROM inbox WHERE project_id = ? AND module_instance_id = 'development'",
        )
        .get(projectId) as { result: string } | undefined;
      expect(row).toBeDefined();
      const result = JSON.parse(row!.result) as {
        status: string;
        summary: string;
        changedFiles: string[];
        headBranch: string;
        headCommit: string;
      };
      expect(result).toMatchObject({
        status: "completed",
        summary: "Codex Runtime applied deterministic change.",
        changedFiles: ["codex-runtime-change.txt"],
      });
      expect(
        execFileSync(
          "git",
          ["--git-dir", fixture.remoteRoot, "show", `${result.headCommit}:run-order.txt`],
          { encoding: "utf8" },
        ),
      ).toBe("agent\n");
      expect(
        execFileSync(
          "git",
          ["--git-dir", fixture.remoteRoot, "rev-parse", `refs/heads/${result.headBranch}`],
          { encoding: "utf8" },
        ).trim(),
      ).toBe(result.headCommit);
    } finally {
      readonly.close();
    }
  });

  it("does not spawn Codex when its bound executable disappears before preflight", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-codex-preflight-"));
    roots.push(dataRoot);
    const executable = join(dataRoot, "gone-codex");
    const spawnMarker = join(dataRoot, "codex-spawned");
    writeFileSync(
      executable,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(spawnMarker)}, 'spawned')\n`,
      "utf8",
    );
    chmodSync(executable, 0o755);

    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);
    const database = new Database(join(dataRoot, "jarvis.sqlite"));
    database
      .prepare(
        `INSERT INTO runtime_descriptors
           (id, provider, display_name, executable_path, version, capabilities, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET executable_path = excluded.executable_path, status = excluded.status`,
      )
      .run(
        "runtime/codex-default",
        "codex",
        "Codex — default",
        executable,
        "0.153.4",
        JSON.stringify(["agent.execute"]),
        "available",
      );
    database.close();

    const projectId = "development-codex-preflight";
    await activateProject(
      engine,
      projectId,
      fixture,
      false,
      300_000,
      1_048_576,
      { test: "node --test" },
      false,
      "origin",
      "runtime/codex-default",
    );
    chmodSync(executable, 0o644);
    await publishTag(engine, projectId, "preflight");
    const executions = await waitForExecutions(engine, projectId, 1);
    const development = executions.find(
      ({ moduleInstanceId }) => moduleInstanceId === "development",
    );
    expect(development).toMatchObject({ status: "failed" });
    expect(existsSync(spawnMarker)).toBe(false);

    const readonly = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(readFailureEvent(readonly, projectId)).toMatchObject({
        payload: { code: "agent.runtime-preflight-failed", retryable: true },
      });
      expect(
        readonly
          .prepare("SELECT COUNT(*) AS count FROM execution_checkpoints WHERE execution_id = ?")
          .get(development!.id),
      ).toEqual({ count: 0 });
    } finally {
      readonly.close();
    }
  });

  it("retains a failed preparation without starting, committing, pushing, or requesting a PR", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-preparation-failure-"));
    roots.push(dataRoot);
    const projectId = "development-preparation-failure";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);

    writeFileSync(join(fixture.root, "pnpm-lock.yaml"), "lockfileVersion: invalid\n");
    execFileSync("git", ["add", "pnpm-lock.yaml"], { cwd: fixture.root });
    execFileSync("git", ["commit", "-m", "test: add invalid lockfile"], { cwd: fixture.root });
    await activateProject(engine, projectId, fixture);
    await publishTag(engine, projectId, "preparation-failure");
    const executions = await waitForExecutions(engine, projectId, 1);
    const development = executions.find(
      ({ moduleInstanceId }) => moduleInstanceId === "development",
    );
    expect(development).toMatchObject({ status: "failed" });

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(readFailureEvent(database, projectId)).toMatchObject({
        payload: { code: "project.preparation-failed", retryable: true },
      });
      expect(
        database
          .prepare(
            "SELECT type FROM execution_checkpoints WHERE execution_id = ? ORDER BY sequence",
          )
          .all(development!.id),
      ).toEqual([{ type: "preparation.started" }, { type: "preparation.failed" }]);
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM outbox
             WHERE project_id = ?
               AND json_extract(envelope, '$.type') IN ('development.implementation.completed', 'scm.change-request.creation-requested')`,
          )
          .get(projectId),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare("SELECT status FROM workspace_leases WHERE execution_id = ?")
          .get(development!.id),
      ).toEqual({ status: "retained" });
    } finally {
      database.close();
    }
  });

  it("runs the bound Fake Runtime in a real allocated worktree", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-"));
    roots.push(dataRoot);
    const projectId = "development-tracer";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);

    const before = repositoryState(fixture.root);
    const commands = {
      test: 'node -e "process.exit(7)"',
      build: 'node -e "process.exit(7)"',
    };
    await activateProject(engine, projectId, fixture, false, 300_000, 1_048_576, commands);
    const firstFact = await publishTag(engine, projectId);
    const firstExecutions = await waitForExecutions(engine, projectId, 1);
    expect(
      firstExecutions.filter((execution) => execution.moduleInstanceId === "development"),
    ).toHaveLength(1);
    expect(
      firstExecutions.every((execution) => execution.status === "completed"),
      JSON.stringify(firstExecutions),
    ).toBe(true);
    expect(repositoryState(fixture.root)).toEqual(before);

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      const requestEvent = database
        .prepare(
          `SELECT id FROM events
           WHERE project_id = ? AND type = 'development.implementation.requested'`,
        )
        .get(projectId) as { id: string } | undefined;
      expect(requestEvent).toBeDefined();
      const recorded = database
        .prepare(
          `SELECT result FROM inbox
           WHERE project_id = ? AND module_instance_id = 'development'`,
        )
        .get(projectId) as { result: string } | undefined;
      expect(recorded).toBeDefined();
      const recordedResult = JSON.parse(recorded!.result) as {
        headBranch: string;
        headCommit: string;
      };
      expect(recordedResult).toEqual({
        status: "completed",
        summary: "Fake Runtime applied deterministic change.",
        changedFiles: ["fake-runtime-change.txt"],
        headBranch: expect.stringMatching(
          /^agent\/fixture-development-tracer-first-implementation-/,
        ),
        headCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
      });
      const outputRows = database
        .prepare(
          `SELECT envelope FROM outbox
           WHERE project_id = ?
             AND json_extract(envelope, '$.type') IN ('development.implementation.completed', 'scm.change-request.creation-requested')
           ORDER BY rowid`,
        )
        .all(projectId) as { envelope: string }[];
      expect(outputRows).toHaveLength(1);
      const [completed] = outputRows.map(
        ({ envelope }) => JSON.parse(envelope) as Record<string, unknown>,
      );
      expect(completed).toMatchObject({
        type: "development.implementation.completed",
        version: 1,
        kind: "fact",
        repositoryId: "main",
        subject: { type: "pushed-branch", ref: `git://main/${recordedResult.headBranch}` },
        payload: {
          workItemRef: `fixture://${projectId}/first`,
          repositoryId: "main",
          baseBranch: "main",
          headBranch: recordedResult.headBranch,
          headCommit: recordedResult.headCommit,
          summary: "Fake Runtime applied deterministic change.",
        },
      });
      expect(completed).not.toHaveProperty("target");
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM outbox
             WHERE project_id = ? AND json_extract(envelope, '$.type') = 'scm.change-request.creation-requested'`,
          )
          .get(projectId),
      ).toEqual({ count: 0 });
      expect(
        git(fixture.root, ["rev-list", "--count", `${before.head}..${recordedResult.headCommit}`]),
      ).toBe("1");
      expect(
        execFileSync(
          "git",
          ["--git-dir", fixture.remoteRoot, "rev-parse", `${recordedResult.headCommit}^`],
          { encoding: "utf8" },
        ).trim(),
      ).toBe(before.head);
      const committedFiles = execFileSync(
        "git",
        [
          "--git-dir",
          fixture.remoteRoot,
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          recordedResult.headCommit,
        ],
        { encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .filter((file) => file !== "");
      expect(committedFiles.length).toBeGreaterThan(0);
      expect(committedFiles).toContain("fake-runtime-change.txt");
      const commitDetails = execFileSync(
        "git",
        ["show", "-s", "--format=%H%n%an%n%ae%n%cn%n%ce%n%B", recordedResult.headCommit],
        { cwd: fixture.root, encoding: "utf8" },
      );
      expect(commitDetails).toContain(`${recordedResult.headCommit}\nJarvis\njarvis@localhost`);
      expect(commitDetails).toContain(`Work Item: fixture://${projectId}/first`);
      expect(
        execFileSync(
          "git",
          ["--git-dir", fixture.remoteRoot, "rev-parse", `refs/heads/${recordedResult.headBranch}`],
          { encoding: "utf8" },
        ).trim(),
      ).toBe(recordedResult.headCommit);
      expect(
        database
          .prepare(
            `SELECT status FROM workspace_leases
             WHERE project_id = ? AND execution_id = ?`,
          )
          .get(
            projectId,
            firstExecutions.find((execution) => execution.moduleInstanceId === "development")!.id,
          ),
      ).toEqual({ status: "released" });
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM workspace_leases WHERE project_id = ? AND status = 'active'",
          )
          .get(projectId),
      ).toEqual({ count: 0 });

      const redelivery = await engine.call("/test/redeliver", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          moduleInstanceId: "development",
          moduleId: "jarvis.module.development",
          eventId: requestEvent!.id,
        }),
      });
      const redeliveryBody = (await redelivery.json()) as {
        redelivered: boolean;
        executionId: string | null;
      };
      expect(redeliveryBody).toMatchObject({ redelivered: true, executionId: null });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM outbox
             WHERE project_id = ?
               AND json_extract(envelope, '$.type') IN ('development.implementation.completed', 'scm.change-request.creation-requested')`,
          )
          .get(projectId),
      ).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM executions").get()).toEqual({
        count: 1,
      });
    } finally {
      database.close();
    }

    const secondFact = await publishTag(engine, projectId, "first", 2);
    const allExecutions = await waitForExecutions(engine, projectId, 2);
    const developmentRuns = allExecutions.filter(
      (execution) => execution.moduleInstanceId === "development",
    );
    expect(developmentRuns).toHaveLength(2);
    expect(repositoryState(fixture.root)).toEqual(before);
    expect(secondFact).not.toBe(firstFact);
  });

  it("durably records ordered agent checkpoints across a dropped stream and restart", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-agent-checkpoints-"));
    roots.push(dataRoot);
    const projectId = "development-checkpoints";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);

    await activateProject(engine, projectId, fixture);
    const liveStream = engine.openStream();
    liveStream.close();
    await publishTag(engine, projectId, "checkpointed");
    const executions = await waitForExecutions(engine, projectId, 1);
    const developmentExecution = executions.find(
      (execution) => execution.moduleInstanceId === "development",
    );
    expect(developmentExecution).toBeDefined();

    const trackedEngine = engines.indexOf(engine);
    if (trackedEngine >= 0) engines.splice(trackedEngine, 1);
    await engine.dispose();

    const restarted = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(restarted);

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      const checkpoints = new ExecutionCheckpointStore(database).list(
        projectId,
        developmentExecution!.id,
      );
      expect(checkpoints.map((checkpoint) => checkpoint.type)).toEqual([
        "agent.started",
        "agent.message",
        "commit.created",
        "branch.pushed",
      ]);
      expect(checkpoints.map((checkpoint) => checkpoint.sequence)).toEqual([1, 2, 3, 4]);
      expect(checkpoints.map((checkpoint) => checkpoint.sourceSequence)).toEqual([1, 2, 3, 4]);
      expect(checkpoints[1]?.payload).toEqual({
        message: "Fake Runtime applied deterministic change.",
      });
      expect(JSON.stringify(checkpoints)).not.toContain(fixture.root);
      expect(JSON.stringify(checkpoints)).not.toMatch(/\/(?:Users|home|private\/var)\//);

      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM outbox
             WHERE json_extract(envelope, '$.type') IN ('agent.started', 'agent.message')`,
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("rejects a clean worktree without creating an empty commit", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-no-changes-"));
    roots.push(dataRoot);
    const projectId = "development-no-changes";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1", JARVIS_FAKE_SCENARIO: "clean" },
    });
    engines.push(engine);

    await activateProject(engine, projectId, fixture, "clean");
    await publishTag(engine, projectId, "no-changes");
    const executions = await waitForExecutions(engine, projectId, 1);
    const development = executions.find(
      (execution) => execution.moduleInstanceId === "development",
    );
    expect(development).toMatchObject({ status: "failed" });
    expect(development).toBeDefined();

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(
        database
          .prepare(
            "SELECT code, message, attempts FROM dead_letters WHERE module_instance_id = 'development'",
          )
          .get(),
      ).toEqual({ code: "git.no-changes", message: expect.any(String), attempts: 1 });
      expect(
        database.prepare("SELECT 1 FROM inbox WHERE module_instance_id = 'development'").get(),
      ).toBeUndefined();
      expect(
        database
          .prepare(
            "SELECT type FROM execution_checkpoints WHERE execution_id = ? ORDER BY sequence",
          )
          .all(development!.id),
      ).toEqual([{ type: "agent.started" }]);
      expect(
        database
          .prepare("SELECT status FROM workspace_leases WHERE project_id = ? AND execution_id = ?")
          .get(projectId, development!.id),
      ).toEqual({ status: "retained" });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM outbox
             WHERE project_id = ?
               AND json_extract(envelope, '$.type') IN ('development.implementation.completed', 'scm.change-request.creation-requested')`,
          )
          .get(projectId),
      ).toEqual({ count: 0 });
      expect(readFailureEvent(database, projectId)).toMatchObject({
        type: "development.implementation.failed",
        version: 1,
        kind: "fact",
        payload: {
          workItemRef: `fixture://${projectId}/no-changes`,
          repositoryId: "main",
          code: "git.no-changes",
          message: expect.stringContaining(`Project ${projectId}`),
          retryable: false,
          workspaceRef: `workspace://${projectId}/${development!.id}`,
        },
      });
    } finally {
      database.close();
    }
  });

  it("fails when the repository push remote is unavailable", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-push-failure-"));
    roots.push(dataRoot);
    const projectId = "development-push-failure";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);
    const before = repositoryState(fixture.root);

    await activateProject(
      engine,
      projectId,
      fixture,
      false,
      300_000,
      1_048_576,
      { test: "node --test" },
      false,
      "unreachable",
    );
    execFileSync("git", ["remote", "set-url", "origin", join(dataRoot, "missing.git")], {
      cwd: fixture.root,
    });
    await publishTag(engine, projectId, "push-failure");
    const executions = await waitForExecutions(engine, projectId, 1);
    const development = executions.find(
      (execution) => execution.moduleInstanceId === "development",
    );
    expect(development).toMatchObject({ status: "failed" });
    expect(development).toBeDefined();
    expect(repositoryState(fixture.root)).toEqual(before);

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(
        database.prepare("SELECT 1 FROM inbox WHERE module_instance_id = 'development'").get(),
      ).toBeUndefined();
      expect(
        database
          .prepare(
            "SELECT attempt_count, next_attempt_at FROM deliveries WHERE module_instance_id = 'development'",
          )
          .get(),
      ).toMatchObject({ attempt_count: expect.any(Number), next_attempt_at: expect.any(String) });
      expect(readFailureEvent(database, projectId)).toMatchObject({
        type: "development.implementation.failed",
        payload: {
          workItemRef: `fixture://${projectId}/push-failure`,
          repositoryId: "main",
          code: "git.push-failed",
          message: expect.stringContaining(`Project ${projectId}`),
          retryable: true,
          workspaceRef: `workspace://${projectId}/${development!.id}`,
        },
      });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM outbox
             WHERE project_id = ?
               AND json_extract(envelope, '$.type') IN ('development.implementation.completed', 'scm.change-request.creation-requested')`,
          )
          .get(projectId),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            "SELECT type FROM execution_checkpoints WHERE execution_id = ? ORDER BY sequence",
          )
          .all(development!.id),
      ).toEqual([{ type: "agent.started" }, { type: "agent.message" }, { type: "commit.created" }]);
      expect(
        database
          .prepare("SELECT status FROM workspace_leases WHERE project_id = ? AND execution_id = ?")
          .get(projectId, development!.id),
      ).toEqual({ status: "retained" });
    } finally {
      database.close();
    }
  });

  it("cancels the real runtime child, drains it, and retains the cancelled workspace", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-cancel-"));
    roots.push(dataRoot);
    const projectId = "development-cancel";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: {
        JARVIS_ENABLE_TEST_HOOKS: "1",
        JARVIS_FAKE_SCENARIO: "ignore-terminate",
      },
    });
    engines.push(engine);

    await activateProject(engine, projectId, fixture, "ignore-terminate");
    const graphResponse = await engine.call(`/v1/projects/${projectId}/graph`);
    expect(graphResponse.status, await graphResponse.clone().text()).toBe(200);
    const graph = (await graphResponse.json()) as {
      nodes: { instanceId: string; enabled: boolean }[];
      edges: {
        kind: string;
        contract: { type: string; version: number; kind: string };
        from: { instanceId: string };
        to?: { instanceId: string };
        routing?: { status: string };
      }[];
      valid: boolean;
      issues: unknown[];
    };
    expect(graph).toMatchObject({ valid: true, issues: [] });
    expect(graph.nodes.map(({ instanceId }) => instanceId)).toEqual([
      "development",
      "request-worker",
    ]);
    expect(graph.nodes.every(({ enabled }) => enabled)).toBe(true);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "request",
          contract: expect.objectContaining({
            type: "development.implementation.requested",
            version: 1,
            kind: "request",
          }),
          from: expect.objectContaining({ instanceId: "development" }),
          to: expect.objectContaining({ instanceId: "development" }),
          routing: expect.objectContaining({ status: "resolved" }),
        }),
      ]),
    );
    await publishTag(engine, projectId, "cancelled");
    const running = await waitForExecution(engine, projectId, "development", "running");
    const workspacePath = join(dataRoot, "projects", projectId, "workspaces", running.id);
    const childPidPath = join(workspacePath, "fake-runtime-child.pid");
    const childPid = await waitForPid(childPidPath);

    const response = await engine.call(`/v1/executions/${running.id}/cancel`, { method: "POST" });
    expect(response.status).toBe(202);
    const cancelled = await waitForExecution(engine, projectId, "development", "cancelled");
    expect(cancelled.id).toBe(running.id);

    expect(existsSync(join(workspacePath, "fake-runtime-interrupt.txt"))).toBe(true);
    expect(existsSync(workspacePath)).toBe(true);
    await expectProcessGone(childPid);

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(
        database
          .prepare(
            `SELECT status FROM workspace_leases
             WHERE project_id = ? AND execution_id = ?`,
          )
          .get(projectId, running.id),
      ).toEqual({ status: "retained" });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM workspace_leases
             WHERE project_id = ? AND status = 'active'`,
          )
          .get(projectId),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM outbox
             WHERE json_extract(envelope, '$.type') IN ('development.implementation.completed', 'scm.change-request.creation-requested')`,
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM events
             WHERE project_id = ?
               AND json_extract(envelope, '$.type') IN ('development.implementation.completed', 'scm.change-request.creation-requested')`,
          )
          .get(projectId),
      ).toEqual({ count: 0 });
      expect(readFailureEvent(database, projectId)).toMatchObject({
        type: "development.implementation.failed",
        payload: {
          workItemRef: `fixture://${projectId}/cancelled`,
          repositoryId: "main",
          code: "agent.run-cancelled",
          message: expect.stringContaining(`Project ${projectId}`),
          retryable: false,
          workspaceRef: `workspace://${projectId}/${running.id}`,
        },
      });
    } finally {
      database.close();
    }
  });

  it("records a timed-out runtime distinctly and retains its workspace", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-timeout-"));
    roots.push(dataRoot);
    const projectId = "development-timeout";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: {
        JARVIS_ENABLE_TEST_HOOKS: "1",
        JARVIS_FAKE_SCENARIO: "ignore-terminate",
        JARVIS_DEVELOPMENT_TIMEOUT_MS: "100",
      },
    });
    engines.push(engine);

    await activateProject(engine, projectId, fixture, "ignore-terminate", 100);
    await publishTag(engine, projectId, "timed-out");
    const timedOut = await waitForExecution(engine, projectId, "development", "timed-out");
    const workspacePath = join(dataRoot, "projects", projectId, "workspaces", timedOut.id);

    expect(existsSync(workspacePath)).toBe(true);
    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(
        database.prepare("SELECT status FROM executions WHERE id = ?").get(timedOut.id),
      ).toEqual({
        status: "timed_out",
      });
      expect(
        database.prepare("SELECT status FROM inbox WHERE module_instance_id = 'development'").get(),
      ).toEqual({
        status: "timed_out",
      });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM workspace_leases
             WHERE project_id = ? AND status = 'active'`,
          )
          .get(projectId),
      ).toEqual({ count: 0 });
      expect(readFailureEvent(database, projectId)).toMatchObject({
        type: "development.implementation.failed",
        payload: {
          workItemRef: `fixture://${projectId}/timed-out`,
          repositoryId: "main",
          code: "agent.run-timed-out",
          message: expect.stringContaining(`Project ${projectId}`),
          retryable: true,
          workspaceRef: `workspace://${projectId}/${timedOut.id}`,
        },
      });
    } finally {
      database.close();
    }
  });

  it("publishes a classified agent runtime failure", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-agent-failure-"));
    roots.push(dataRoot);
    const projectId = "development-agent-failure";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1", JARVIS_FAKE_SCENARIO: "failure" },
    });
    engines.push(engine);

    await activateProject(engine, projectId, fixture, "failure");
    await publishTag(engine, projectId, "agent-failure");
    const executions = await waitForExecutions(engine, projectId, 1);
    const development = executions.find(
      (execution) => execution.moduleInstanceId === "development",
    );
    expect(development).toMatchObject({ status: "failed" });
    expect(development).toBeDefined();

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(readFailureEvent(database, projectId)).toMatchObject({
        type: "development.implementation.failed",
        payload: {
          workItemRef: `fixture://${projectId}/agent-failure`,
          repositoryId: "main",
          code: "agent.run-failed",
          message: expect.stringContaining(`Project ${projectId}`),
          retryable: false,
          workspaceRef: `workspace://${projectId}/${development!.id}`,
        },
      });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM outbox
             WHERE project_id = ?
               AND json_extract(envelope, '$.type') IN ('development.implementation.completed', 'scm.change-request.creation-requested')`,
          )
          .get(projectId),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("keeps the run successful when raw output exceeds its capture limit", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-output-limit-"));
    roots.push(dataRoot);
    const projectId = "development-output-limit";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: {
        JARVIS_ENABLE_TEST_HOOKS: "1",
        JARVIS_FAKE_SCENARIO: "oversized",
        JARVIS_DEVELOPMENT_OUTPUT_LIMIT_BYTES: "1024",
      },
    });
    engines.push(engine);

    await activateProject(engine, projectId, fixture, "oversized", 300_000, 1_024);
    await publishTag(engine, projectId, "output-limit");
    const executions = await waitForExecutions(engine, projectId, 1);
    const development = executions.find(
      (execution) => execution.moduleInstanceId === "development",
    );
    expect(development).toMatchObject({ status: "completed" });

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(
        database
          .prepare("SELECT status FROM workspace_leases WHERE execution_id = ?")
          .get(development!.id),
      ).toEqual({ status: "released" });
      expect(
        database.prepare("SELECT result FROM inbox WHERE module_instance_id = 'development'").get(),
      ).toMatchObject({
        result: expect.stringContaining('"status":"completed"'),
      });
      const result = database
        .prepare("SELECT result FROM inbox WHERE module_instance_id = 'development'")
        .get() as {
        result: string;
      };
      expect(JSON.parse(result.result)).toMatchObject({
        status: "completed",
      });
    } finally {
      database.close();
    }
  });
});

async function admissionFixture(projectId: string, scenario: string) {
  const dataRoot = mkdtempSync(join("/tmp", "jarvis-admission-"));
  roots.push(dataRoot);
  const fixture = makeRealGitRepositoryFixture({
    additionalRemotes: [{ name: "github", url: "git@github.com:Gasppacho/jarvis.git" }],
  });
  roots.push(fixture.root, fixture.remoteRoot);
  const engine = await startEngine({
    dataRoot,
    enginePath: testBundlePath,
    env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
  });
  engines.push(engine);
  await activateProject(
    engine,
    projectId,
    fixture,
    scenario,
    300_000,
    1_048_576,
    {},
    false,
    "origin",
    "runtime/fake-test",
    { github: true },
  );
  return { engine, fixture };
}

function seedReadyIssue(number: number, change?: "closed" | "label-removed") {
  servers[0]!.seedIssue({
    owner: "Gasppacho",
    repository: "jarvis",
    issue: {
      number,
      title: `Ready ${number}`,
      body: "Complete untrusted work item",
      state: change === "closed" ? "closed" : "open",
      labels: change === "label-removed" ? [] : [{ name: "ready-to-dev" }],
    },
  });
}

async function admissionItems(engine: Harness, projectId: string) {
  const response = await engine.call(`/v1/projects/${projectId}/development-admission`);
  expect(response.status).toBe(200);
  return (
    (await response.json()) as {
      items: {
        deliveryId: string;
        eventId: string;
        workItemRef: string;
        status: string;
        reason: string;
      }[];
    }
  ).items;
}

async function releaseAdmissionAgent(
  engine: Harness,
  database: Database.Database,
  projectId: string,
  number: number,
) {
  let executionId = "";
  await expect
    .poll(
      () => {
        const rows = database
          .prepare(
            `SELECT execution.id, json_extract(events.envelope, '$.payload.workItemRef') AS ref
      FROM executions execution JOIN events ON events.id = execution.input_event_id
      JOIN workspace_leases lease ON lease.execution_id = execution.id
      WHERE execution.project_id = ? AND execution.status = 'running' AND lease.status = 'active'`,
          )
          .all(projectId) as { id: string; ref: string }[];
        expect(rows.length).toBeLessThanOrEqual(1);
        executionId = rows[0]?.id ?? "";
        return rows[0]?.ref;
      },
      { timeout: 10_000 },
    )
    .toBe(`github://Gasppacho/jarvis/issues/${number}`);
  const pid = await waitForPid(
    join(engine.dataRoot, "projects", projectId, "workspaces", executionId, "fake-runtime.pid"),
  );
  process.kill(pid, "SIGUSR1");
}

async function activateProject(
  engine: Harness,
  projectId: string,
  fixture: RealGitRepositoryFixture,
  fakeScenario: string | false = false,
  _timeoutMs = 300_000,
  _outputLimitBytes = 1_048_576,
  _commands: Readonly<Record<string, string>> = {},
  _retainWorkspaceOnSuccess = false,
  _pushRemote = "origin",
  runtimeRef = "runtime/fake-test",
  admission: { readonly github?: boolean; readonly maxConcurrent?: number } = {},
): Promise<void> {
  const connection = await engine.call("/v1/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: `connection/github-work-items-${projectId}`,
      kind: "github",
      displayName: "Work Items",
      secretRef: "gh://WorkItems",
    }),
  });
  expect(connection.status, await connection.clone().text()).toBe(201);
  const validated = await engine.call(
    `/v1/connections/connection%2Fgithub-work-items-${projectId}/validate`,
    {
      method: "POST",
    },
  );
  expect(validated.status, await validated.clone().text()).toBe(200);
  const portableConfig = {
    apiVersion: "jarvis.dev/project/v1",
    kind: "Project",
    compositionMode: "fixed-modules" as const,
    metadata: { id: projectId, name: "Development tracer" },
    repositories: [{ id: "main", root: "." }],
    slots: {
      agentRuntime: { requires: "agent.execute" },
      tickets: { requires: "work-items.read" },
      ...(admission.github ? { sourceControl: { requires: "scm.change-request.manage" } } : {}),
    },
    modules: [
      {
        instanceId: "development",
        moduleId: "jarvis.module.development",
        enabled: true,
        runtimeSlot: "agentRuntime",
        bindings: { repository: "main", tickets: "tickets" },
        configuration: {
          readyLabel: "ready-to-dev",
        },
      },
      ...(admission.github
        ? [
            {
              instanceId: "github",
              moduleId: "jarvis.module.github",
              enabled: true,
              bindings: { sourceControl: "sourceControl", tickets: "tickets" },
              configuration: {
                repositories: ["main"],
                bootstrapLabelPolicy: "ignore-existing",
                pollIntervalSeconds: 60,
              },
            },
            {
              instanceId: "pull-request",
              moduleId: "jarvis.module.pull-request",
              enabled: true,
              runtimeSlot: "agentRuntime",
              bindings: {
                repository: "main",
                tickets: "tickets",
                sourceControl: "sourceControl",
              },
            },
          ]
        : [
            {
              instanceId: "request-worker",
              moduleId: "jarvis.module.test-request-worker",
              enabled: true,
            },
          ]),
    ],
  };
  const packageJsonPath = join(fixture.root, "package.json");
  const originalPackageJson = readFileSync(packageJsonPath, "utf8");
  const packageJson = JSON.parse(originalPackageJson) as Record<string, unknown>;
  writeFileSync(
    packageJsonPath,
    `${JSON.stringify({ ...packageJson, name: projectId }, null, 2)}\n`,
  );
  const imported = await engine.call("/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositoryPath: fixture.root }),
  });
  writeFileSync(packageJsonPath, originalPackageJson);
  expect(imported.status, await imported.clone().text()).toBe(201);
  const savedConfiguration = await engine.call(`/v1/projects/${projectId}/configuration`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ portableConfig, writeToRepository: false }),
  });
  expect(savedConfiguration.status, await savedConfiguration.clone().text()).toBe(200);
  const repositoryBinding = await engine.call(
    `/v1/projects/${projectId}/repositories/main/binding`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: realpathSync(fixture.root),
        bookmarkRef: "bookmark/development-tracer",
      }),
    },
  );
  expect(repositoryBinding.status, await repositoryBinding.clone().text()).toBe(200);
  const bindings = await engine.call(`/v1/projects/${projectId}/bindings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      apiVersion: "jarvis.dev/project-bindings/v1",
      kind: "ProjectBindings",
      projectId,
      repositories: {
        main: { path: realpathSync(fixture.root), bookmarkRef: "bookmark/development-tracer" },
      },
      slots: {
        agentRuntime: {
          kind: "runtime",
          ref: runtimeRef,
          ...(runtimeRef === "runtime/codex-default"
            ? { environment: { PATH: process.env["PATH"] ?? "/usr/bin" } }
            : fakeScenario !== false
              ? {
                  environment: {
                    JARVIS_FAKE_SCENARIO: fakeScenario,
                  },
                }
              : {}),
        },
        tickets: { kind: "connection", ref: `connection/github-work-items-${projectId}` },
        ...(admission.github
          ? {
              sourceControl: {
                kind: "connection",
                ref: `connection/github-work-items-${projectId}`,
              },
            }
          : {}),
      },
    }),
  });
  expect(bindings.status, await bindings.clone().text()).toBe(200);
  const reportResponse = await engine.call(`/v1/projects/${projectId}/validation-report`, {
    method: "POST",
  });
  const report = (await reportResponse.json()) as {
    valid: boolean;
    compositionFingerprint?: string;
  };
  expect(reportResponse.status).toBe(200);
  expect(report.valid, JSON.stringify(report)).toBe(true);
  if (!admission.github) {
    await seedActivatedConsumerProject(engine, projectId);
    return;
  }
  const preflightResponse = await engine.call(`/v1/projects/${projectId}/preflight`, {
    method: "POST",
  });
  const preflight = (await preflightResponse.json()) as {
    valid: boolean;
    compositionFingerprint?: string;
  };
  expect(preflightResponse.status).toBe(200);
  expect(preflight.valid, JSON.stringify(preflight)).toBe(true);
  const activated = await engine.call(`/v1/projects/${projectId}/preflight-activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ compositionFingerprint: preflight.compositionFingerprint }),
  });
  expect(activated.status, await activated.clone().text()).toBe(200);
}

async function publishTag(
  engine: Harness,
  projectId: string,
  suffix = "first",
  generation = 1,
  workItemRef = `fixture://${projectId}/${suffix}`,
): Promise<string> {
  const response = await engine.call("/test/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "development.implementation.requested",
      version: 1,
      kind: "request",
      projectId,
      repositoryId: "main",
      producer: {
        moduleId: "jarvis.module.development",
        moduleInstanceId: "development",
      },
      subject: { type: "work-item", ref: workItemRef },
      correlationId: `corr_${suffix}`,
      causationId: null,
      target: { moduleInstanceId: "development" },
      payload: { workItemRef, repositoryId: "main", baseBranch: "main" },
      idempotencyKey: `${projectId}:${workItemRef}:request:${generation}`,
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function waitForExecutions(
  engine: Harness,
  projectId: string,
  count: number,
): Promise<readonly { id: string; moduleInstanceId: string; status: string }[]> {
  const startedAt = Date.now();
  for (;;) {
    const response = await engine.call(`/v1/projects/${projectId}/executions`);
    const body = (await response.json()) as {
      items: { id: string; moduleInstanceId: string; status: string }[];
    };
    if (
      body.items.length >= count &&
      body.items.every((execution) =>
        ["completed", "failed", "cancelled", "timed-out"].includes(execution.status),
      )
    )
      return body.items;
    if (Date.now() - startedAt > 10_000)
      throw new Error("Development executions did not complete in time.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForExecution(
  engine: Harness,
  projectId: string,
  moduleInstanceId: string,
  status: string,
): Promise<{ id: string; moduleInstanceId: string; status: string }> {
  const startedAt = Date.now();
  for (;;) {
    const response = await engine.call(`/v1/projects/${projectId}/executions`);
    const body = (await response.json()) as {
      items: { id: string; moduleInstanceId: string; status: string }[];
    };
    const execution = body.items.find(
      (candidate) => candidate.moduleInstanceId === moduleInstanceId && candidate.status === status,
    );
    if (execution !== undefined) return execution;
    if (Date.now() - startedAt > 10_000) {
      throw new Error(`Development execution did not reach ${status} in time.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForAdmission(
  dataRoot: string,
  projectId: string,
  status: string,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      const row = database
        .prepare("SELECT status FROM development_admissions WHERE project_id = ?")
        .get(projectId) as { status: string } | undefined;
      if (row?.status === status) return;
    } finally {
      database.close();
    }
    if (Date.now() - startedAt > 5_000) throw new Error("Development admission did not settle.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function activeAdmissionRef(database: Database.Database, projectId: string): string | undefined {
  const row = database
    .prepare(
      `SELECT json_extract(events.envelope, '$.payload.workItemRef') AS ref
       FROM executions execution
       JOIN workspace_leases lease ON lease.execution_id = execution.id
       JOIN events ON events.id = execution.input_event_id
       WHERE execution.project_id = ? AND execution.status = 'running' AND lease.status = 'active'`,
    )
    .get(projectId) as { readonly ref: string } | undefined;
  return row?.ref;
}

function workItemReadinessStatus(
  database: Database.Database,
  projectId: string,
  workItemRef: string,
): string | undefined {
  const row = database
    .prepare(
      `SELECT status FROM github_work_item_readiness
       WHERE project_id = ? AND repository_id = 'main' AND work_item_ref = ?`,
    )
    .get(projectId, workItemRef) as { readonly status: string } | undefined;
  return row?.status;
}

async function publishObserved(
  engine: Harness,
  projectId: string,
  workItemRef: string,
  observationRevision: number,
  state: "open" | "closed",
  tags: readonly string[],
  title = "Fixed reopen 2",
): Promise<string> {
  const observedAt = `2026-09-14T00:00:0${observationRevision}.000Z`;
  const recordedRevision = recordObservation(
    engine,
    projectId,
    workItemRef,
    title,
    state,
    tags,
    observedAt,
  );
  const response = await engine.call("/test/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "scm.work-item.observed",
      version: 1,
      kind: "fact",
      projectId,
      repositoryId: "main",
      producer: { moduleId: "jarvis.module.github", moduleInstanceId: "github" },
      subject: { type: "work-item", ref: workItemRef },
      correlationId: `corr_fixed_observed_${observationRevision}`,
      causationId: null,
      idempotencyKey: `${projectId}:${workItemRef}:observed:${recordedRevision}`,
      payload: {
        repositoryId: "main",
        workItemRef,
        title,
        state,
        tags,
        dependencies: { status: "complete", openWorkItemRefs: [] },
        verification: "verified",
        reasonCode: null,
        observedAt,
        observationRevision: recordedRevision,
      },
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

function recordObservation(
  engine: Harness,
  projectId: string,
  workItemRef: string,
  title: string,
  state: "open" | "closed",
  tags: readonly string[],
  observedAt: string,
): number {
  const database = new Database(join(engine.dataRoot, "jarvis.sqlite"));
  try {
    return new WorkItemReadinessStore(database, new SystemClock()).recordObserved({
      projectId,
      repositoryId: "main",
      workItemRef,
      title,
      observation: {
        title,
        state,
        tags,
        dependencies: { status: "complete", openWorkItemRefs: [] },
        verification: "verified",
        reasonCode: null,
      },
      observedAt,
    });
  } finally {
    database.close();
  }
}

async function waitForPid(path: string): Promise<number> {
  const startedAt = Date.now();
  for (;;) {
    try {
      const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // The child writes the marker after the workspace is allocated.
    }
    if (Date.now() - startedAt > 10_000) throw new Error(`PID marker ${path} was not written.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function expectProcessGone(pid: number): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() - startedAt > 5_000) throw new Error(`Process ${pid} is still alive.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function repositoryState(repositoryPath: string): {
  readonly head: string;
  readonly branch: string;
  readonly status: string;
} {
  return {
    head: git(repositoryPath, ["rev-parse", "HEAD"]),
    branch: git(repositoryPath, ["branch", "--show-current"]),
    status: git(repositoryPath, ["status", "--porcelain"]),
  };
}

function readFailureEvent(database: Database.Database, projectId: string): Record<string, unknown> {
  const rows = database
    .prepare(
      `SELECT envelope FROM outbox
       WHERE project_id = ? AND json_extract(envelope, '$.type') = 'development.implementation.failed'`,
    )
    .all(projectId) as { envelope: string }[];
  expect(rows).toHaveLength(1);
  const event = JSON.parse(rows[0]!.envelope) as Record<string, unknown>;
  expect(JSON.stringify(event)).not.toMatch(/\/(?:Users|home|private\/var|tmp)\//);
  return event;
}

function git(repositoryPath: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: repositoryPath, encoding: "utf8" }).trim();
}

// Optional capture for the Swift contract/visual fixtures; ordinary test runs write nothing.
async function readExecutionDetail(
  engine: Harness,
  projectId: string,
  executionId: string,
  snapshot?: string,
): Promise<components["schemas"]["ExecutionDetailV1"]> {
  const response = await engine.call(`/v1/projects/${projectId}/executions/${executionId}/detail`);
  expect(response.status).toBe(200);
  const detail = (await response.json()) as components["schemas"]["ExecutionDetailV1"];
  const validate = localApiValidator("ExecutionDetailV1");
  expect(validate(detail), explain(validate)).toBe(true);
  const directory = process.env["JARVIS_DETAIL_SNAPSHOTS_DIR"];
  if (directory !== undefined && snapshot !== undefined) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${snapshot}.json`), JSON.stringify(detail, null, 2) + "\n");
  }
  return detail;
}
