import Database from "better-sqlite3";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectBindings } from "../../../packages/project-runtime/src/project-types.js";
import { startEngine, startFakeGitHubApi, type FakeGitHubApi, type Harness } from "./harness.js";
import { makeNodeRepositoryFixture } from "./repository-fixture.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const testBundlePath = fileURLToPath(
  new URL("../../../dist/engine/engine.test-bundle.mjs", import.meta.url),
);
const engines: Harness[] = [];
const roots: string[] = [];
const repositories: string[] = [];
const servers: FakeGitHubApi[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const path of [...repositories.splice(0), ...roots.splice(0)]) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("GitHub Change Request creation Application Harness", () => {
  it("creates one PR per targeted project and rejects non-GitHub refs before the API", async () => {
    const fakeGitHub = await startFakeGitHubApi();
    servers.push(fakeGitHub);
    const credentialA = "ghs_project_a_sentinel";
    const credentialB = "ghs_project_b_sentinel";
    const executableRoot = mkdtempSync(join(tmpdir(), "jarvis-gh-credentials-"));
    roots.push(executableRoot);
    const executable = join(executableRoot, "gh");
    writeFileSync(
      executable,
      `#!/bin/sh
case "$*" in
  *"--user AccountA"*) printf '%s\\n' '${credentialA}';;
  *"--user AccountB"*) printf '%s\\n' '${credentialB}';;
  *) exit 1;;
esac
`,
      "utf8",
    );
    chmodSync(executable, 0o755);

    const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-github-change-request-"));
    roots.push(dataRoot);
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: {
        JARVIS_ENABLE_TEST_HOOKS: "1",
        JARVIS_GH_EXECUTABLE: executable,
        JARVIS_GITHUB_API_BASE_URL: fakeGitHub.baseUrl,
      },
    });
    engines.push(engine);

    await registerGitHubConnection(engine, "connection/github-a", "AccountA");
    await registerGitHubConnection(engine, "connection/github-b", "AccountB");
    const projectA = await createGitHubProject(engine, "project-a");
    const projectB = await createGitHubProject(engine, "project-b");
    await bindAndActivate(engine, projectA, "connection/github-a");
    await bindAndActivate(engine, projectB, "connection/github-b");

    const createdA = await publishCreationRequest(
      engine,
      projectA.id,
      "github://QServices/repo/issues/42",
    );
    const createdB = await publishCreationRequest(
      engine,
      projectB.id,
      "github://QServices/repo/issues/43",
    );
    await waitForExecution(engine, projectA.id, createdA.id, "completed");
    await waitForExecution(engine, projectB.id, createdB.id, "completed");

    const redelivery = await engine.call("/test/redeliver", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: projectA.id,
        moduleInstanceId: "github",
        moduleId: "jarvis.module.github",
        eventId: createdA.id,
      }),
    });
    expect(redelivery.status, await redelivery.clone().text()).toBe(200);
    expect(await redelivery.json()).toMatchObject({
      redelivered: true,
      executionId: null,
      status: "completed",
    });

    const createdASecond = await publishCreationRequest(
      engine,
      projectA.id,
      "github://QServices/repo/issues/45",
    );
    await waitForExecution(engine, projectA.id, createdASecond.id, "completed");

    const invalid = await publishCreationRequest(
      engine,
      projectA.id,
      "gitlab://QServices/repo/issues/44",
    );
    await waitForExecution(engine, projectA.id, invalid.id, "failed");
    await rejectCreationRequestWithoutIdempotencyKey(
      engine,
      projectA.id,
      "github://QServices/repo/issues/46",
    );

    expect(fakeGitHub.pullRequests).toHaveLength(3);
    expect(fakeGitHub.pullRequests).toEqual([
      expect.objectContaining({
        number: 1,
        base: "main",
        head: "agent/project-a/issue-42",
        draft: false,
      }),
      expect.objectContaining({
        number: 2,
        base: "main",
        head: "agent/project-b/issue-43",
        draft: false,
      }),
      expect.objectContaining({
        number: 3,
        base: "main",
        head: "agent/project-a/issue-45",
        draft: false,
      }),
    ]);
    expect(fakeGitHub.requests.filter((request) => request.method === "POST")).toHaveLength(3);
    expect(
      fakeGitHub.requests
        .filter((request) => request.method === "POST")
        .map((request) => request.credential),
    ).toEqual(expect.arrayContaining([credentialA, credentialA, credentialB]));

    const eventsA = await waitForEvents(engine, projectA.id, 5);
    const eventsB = await waitForEvents(engine, projectB.id, 2);
    expect(eventsA.filter((event) => event["type"] === "scm.change-request.created")).toHaveLength(
      2,
    );
    expect(eventsA).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "scm.change-request.created",
          kind: "fact",
          producer: "github",
          subjectRef: "github://QServices/repo/pulls/1",
          correlationId: expect.stringMatching(/^corr_/),
          causationId: createdA.id,
        }),
        expect.objectContaining({
          type: "scm.change-request.created",
          subjectRef: "github://QServices/repo/pulls/3",
          causationId: createdASecond.id,
        }),
      ]),
    );
    expect(eventsB).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          producer: "github",
          subjectRef: "github://QServices/repo/pulls/2",
          causationId: createdB.id,
        }),
      ]),
    );
    expect(eventsA.some((event) => event["type"] === "scm.change-request.created")).toBe(true);
    expect(eventsA.some((event) => event["type"] === "scm.change-request.creation-failed")).toBe(
      false,
    );
    expect(fakeGitHub.requests.some((request) => request.path.includes("issues/44"))).toBe(false);

    await engine.dispose();
    engines.splice(engines.indexOf(engine), 1);
    const database = new Database(join(dataRoot, "jarvis.sqlite"));
    try {
      const createdFacts = database
        .prepare(
          "SELECT project_id, envelope FROM events WHERE type = 'scm.change-request.created' ORDER BY rowid",
        )
        .all() as readonly { readonly project_id: string; readonly envelope: string }[];
      expect(createdFacts.map(({ project_id }) => project_id)).toEqual([
        "project-a",
        "project-b",
        "project-a",
      ]);
      expect(JSON.parse(createdFacts[0]!.envelope)).toMatchObject({
        projectId: "project-a",
        subject: { type: "change-request", ref: "github://QServices/repo/pulls/1" },
        payload: {
          externalNumber: 1,
          url: `${fakeGitHub.baseUrl}/repos/QServices/repo/pull/1`,
          repositoryId: "main",
          workItemRef: "github://QServices/repo/issues/42",
        },
      });
      const mappings = database
        .prepare(
          `SELECT project_id, module_instance_id, idempotency_key, status, resource_ref
           FROM external_mappings ORDER BY rowid`,
        )
        .all();
      expect(mappings).toEqual([
        {
          project_id: "project-a",
          module_instance_id: "github",
          idempotency_key: "project-a:github://QServices/repo/issues/42",
          status: "completed",
          resource_ref: `${fakeGitHub.baseUrl}/repos/QServices/repo/pull/1`,
        },
        {
          project_id: "project-b",
          module_instance_id: "github",
          idempotency_key: "project-b:github://QServices/repo/issues/43",
          status: "completed",
          resource_ref: `${fakeGitHub.baseUrl}/repos/QServices/repo/pull/2`,
        },
        {
          project_id: "project-a",
          module_instance_id: "github",
          idempotency_key: "project-a:github://QServices/repo/issues/45",
          status: "completed",
          resource_ref: `${fakeGitHub.baseUrl}/repos/QServices/repo/pull/3`,
        },
      ]);
      expect(JSON.stringify(createdFacts)).not.toContain(credentialA);
      expect(JSON.stringify(createdFacts)).not.toContain(credentialB);
    } finally {
      database.close();
    }
    const durable = readdirSync(dataRoot)
      .filter((name) => name.startsWith("jarvis.sqlite"))
      .map((name) => readFileSync(join(dataRoot, name), "utf8"))
      .join("\n");
    expect(durable).not.toContain(credentialA);
    expect(durable).not.toContain(credentialB);
  });

  it("recovers a durable mapping after the fact boundary crashes", async () => {
    const fakeGitHub = await startFakeGitHubApi();
    servers.push(fakeGitHub);
    const credential = "ghs_mapping_recovery_sentinel";
    const executableRoot = mkdtempSync(join(tmpdir(), "jarvis-gh-credentials-"));
    roots.push(executableRoot);
    const executable = join(executableRoot, "gh");
    writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${credential}'\n`, "utf8");
    chmodSync(executable, 0o755);

    const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-github-mapping-recovery-"));
    roots.push(dataRoot);
    const crashed = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: {
        JARVIS_ENABLE_TEST_HOOKS: "1",
        JARVIS_FAILPOINT: "after-external-mapping-before-fact",
        JARVIS_GH_EXECUTABLE: executable,
        JARVIS_GITHUB_API_BASE_URL: fakeGitHub.baseUrl,
      },
    });
    engines.push(crashed);

    await registerGitHubConnection(crashed, "connection/github", "Account");
    const project = await createGitHubProject(crashed, "project-recovery");
    await bindAndActivate(crashed, project, "connection/github");
    const published = await publishCreationRequest(
      crashed,
      project.id,
      "github://QServices/repo/issues/42",
    );
    const exitCode = await crashed.waitForExit();
    expect(exitCode).not.toBe(0);
    await crashed.dispose();
    engines.splice(engines.indexOf(crashed), 1);

    const beforeRestart = new Database(join(dataRoot, "jarvis.sqlite"));
    try {
      expect(
        beforeRestart
          .prepare("SELECT COUNT(*) AS count FROM events WHERE project_id = ?")
          .get(project.id),
      ).toEqual({ count: 1 });
      expect(
        beforeRestart
          .prepare("SELECT COUNT(*) AS count FROM deliveries WHERE project_id = ? AND event_id = ?")
          .get(project.id, published.id),
      ).toEqual({ count: 1 });
      expect(
        beforeRestart
          .prepare(
            `SELECT status, resource_ref FROM external_mappings
             WHERE project_id = 'project-recovery' AND module_instance_id = 'github'`,
          )
          .get(),
      ).toEqual({
        status: "completed",
        resource_ref: `${fakeGitHub.baseUrl}/repos/QServices/repo/pull/1`,
      });
      expect(
        beforeRestart
          .prepare("SELECT 1 FROM events WHERE type = 'scm.change-request.created'")
          .get(),
      ).toBeUndefined();
      expect(beforeRestart.prepare("SELECT status FROM executions").get()).toEqual({
        status: "running",
      });
      expect(
        beforeRestart
          .prepare("SELECT consumed_at, lease_owner, lease_expires_at FROM deliveries")
          .get(),
      ).toMatchObject({
        consumed_at: null,
        lease_owner: expect.any(String),
        lease_expires_at: expect.any(String),
      });
    } finally {
      beforeRestart.close();
    }

    const restarted = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: {
        JARVIS_ENABLE_TEST_HOOKS: "1",
        JARVIS_GH_EXECUTABLE: executable,
        JARVIS_GITHUB_API_BASE_URL: fakeGitHub.baseUrl,
      },
    });
    engines.push(restarted);
    await waitForExecution(restarted, project.id, published.id, "completed");
    const redelivery = await restarted.call("/test/redeliver", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        moduleInstanceId: "github",
        moduleId: "jarvis.module.github",
        eventId: published.id,
      }),
    });
    expect(redelivery.status, await redelivery.clone().text()).toBe(200);
    expect(await redelivery.json()).toMatchObject({ redelivered: true, executionId: null });

    const events = await waitForEvents(restarted, project.id, 2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "scm.change-request.created",
          subjectRef: "github://QServices/repo/pulls/1",
        }),
      ]),
    );
    expect(fakeGitHub.pullRequests).toHaveLength(1);
    expect(
      fakeGitHub.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/pulls"),
      ),
    ).toHaveLength(1);
    expect(
      fakeGitHub.requests.filter(
        (request) => request.method === "GET" && request.path.includes("/pulls"),
      ),
    ).toHaveLength(0);
    expect(fakeGitHub.requests.some((request) => request.credential === credential)).toBe(true);

    const recovered = new Database(join(dataRoot, "jarvis.sqlite"));
    try {
      expect(
        recovered
          .prepare(
            `SELECT COUNT(*) AS count FROM inbox
             WHERE project_id = ? AND module_instance_id = ? AND event_id = ?`,
          )
          .get(project.id, "github", published.id),
      ).toEqual({ count: 1 });
      expect(recovered.prepare("SELECT COUNT(*) AS count FROM dead_letters").get()).toEqual({
        count: 0,
      });
      expect(
        recovered.prepare("SELECT attempt, status FROM executions ORDER BY attempt").all(),
      ).toEqual([{ attempt: 1, status: "completed" }]);
      expect(
        recovered
          .prepare("SELECT attempt, COUNT(*) AS count FROM executions GROUP BY attempt")
          .all(),
      ).toEqual([{ attempt: 1, count: 1 }]);
      expect(
        recovered
          .prepare("SELECT COUNT(*) AS count FROM events WHERE project_id = ?")
          .get(project.id),
      ).toEqual({ count: 2 });
      expect(
        recovered
          .prepare("SELECT COUNT(*) AS count FROM deliveries WHERE project_id = ? AND event_id = ?")
          .get(project.id, published.id),
      ).toEqual({ count: 1 });
    } finally {
      recovered.close();
    }
  });

  it("reclaims a leased retry after restart without repeating the attempt or external resource", async () => {
    const fakeGitHub = await startFakeGitHubApi();
    servers.push(fakeGitHub);
    const credential = "ghs_delivery_lease_recovery_sentinel";
    const executableRoot = mkdtempSync(join(tmpdir(), "jarvis-gh-credentials-"));
    roots.push(executableRoot);
    const executable = join(executableRoot, "gh");
    writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${credential}'\n`, "utf8");
    chmodSync(executable, 0o755);

    const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-delivery-lease-recovery-"));
    roots.push(dataRoot);
    const leaseMs = "3000";
    const first = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: {
        JARVIS_ENABLE_TEST_HOOKS: "1",
        JARVIS_DELIVERY_LEASE_MS: leaseMs,
        JARVIS_GH_EXECUTABLE: executable,
        JARVIS_GITHUB_API_BASE_URL: fakeGitHub.baseUrl,
      },
    });
    engines.push(first);

    await registerGitHubConnection(first, "connection/github", "Account");
    const project = await createGitHubProject(first, "project-delivery-lease-recovery");
    await bindAndActivate(first, project, "connection/github");
    const failFirstAttempt = fakeGitHub.scriptRoute("POST", "/repos/QServices/repo/pulls", {
      status: 500,
      body: { message: "transient provider failure" },
    });
    const published = await publishCreationRequest(
      first,
      project.id,
      "github://QServices/repo/issues/47",
    );
    await waitForExecution(first, project.id, published.id, "failed");

    const afterRetry = new Database(join(dataRoot, "jarvis.sqlite"));
    try {
      expect(
        afterRetry
          .prepare(
            `SELECT attempt_count, consumed_at, next_attempt_at
             FROM deliveries WHERE event_id = ?`,
          )
          .get(published.id),
      ).toMatchObject({ attempt_count: 1, consumed_at: null });
      expect(afterRetry.prepare("SELECT COUNT(*) AS count FROM dead_letters").get()).toEqual({
        count: 0,
      });
    } finally {
      afterRetry.close();
    }
    await first.dispose();
    engines.splice(engines.indexOf(first), 1);
    failFirstAttempt();

    const crashed = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: {
        JARVIS_ENABLE_TEST_HOOKS: "1",
        JARVIS_FAILPOINT: "after-external-mapping-before-fact",
        JARVIS_DELIVERY_LEASE_MS: leaseMs,
        JARVIS_GH_EXECUTABLE: executable,
        JARVIS_GITHUB_API_BASE_URL: fakeGitHub.baseUrl,
      },
    });
    engines.push(crashed);
    const crashExitCode = await crashed.waitForExit();
    expect(crashExitCode).not.toBe(0);
    await crashed.dispose();
    engines.splice(engines.indexOf(crashed), 1);

    const leaseHeld = new Database(join(dataRoot, "jarvis.sqlite"));
    let leaseOwner: string;
    let leaseExpiresAt: string;
    try {
      const delivery = leaseHeld
        .prepare(
          `SELECT attempt_count, consumed_at, lease_owner, lease_expires_at
           FROM deliveries WHERE event_id = ?`,
        )
        .get(published.id) as {
        attempt_count: number;
        consumed_at: string | null;
        lease_owner: string | null;
        lease_expires_at: string | null;
      };
      expect(delivery).toMatchObject({ attempt_count: 1, consumed_at: null });
      expect(delivery.lease_owner).toEqual(expect.stringMatching(/^delivery-/));
      expect(delivery.lease_expires_at).not.toBeNull();
      expect(Date.parse(delivery.lease_expires_at!)).toBeGreaterThan(Date.now());
      leaseOwner = delivery.lease_owner!;
      leaseExpiresAt = delivery.lease_expires_at!;
      expect(
        leaseHeld.prepare("SELECT attempt, status FROM executions ORDER BY attempt, id").all(),
      ).toEqual([
        { attempt: 1, status: "failed" },
        { attempt: 2, status: "running" },
      ]);
    } finally {
      leaseHeld.close();
    }

    const restarted = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: {
        JARVIS_ENABLE_TEST_HOOKS: "1",
        JARVIS_DELIVERY_LEASE_MS: leaseMs,
        JARVIS_GH_EXECUTABLE: executable,
        JARVIS_GITHUB_API_BASE_URL: fakeGitHub.baseUrl,
      },
    });
    engines.push(restarted);

    // The restarted loop ticks every 200ms, but the killed worker's Delivery
    // lease is still live. Several ticks must observe the same owner before
    // expiry; claiming it here would create a second worker for attempt 2.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const whileLeaseIsLive = new Database(join(dataRoot, "jarvis.sqlite"));
    try {
      expect(
        whileLeaseIsLive
          .prepare(
            "SELECT attempt_count, consumed_at, lease_owner, lease_expires_at FROM deliveries",
          )
          .get(),
      ).toEqual({
        attempt_count: 1,
        consumed_at: null,
        lease_owner: leaseOwner,
        lease_expires_at: leaseExpiresAt,
      });
      expect(whileLeaseIsLive.prepare("SELECT COUNT(*) AS count FROM executions").get()).toEqual({
        count: 2,
      });
      expect(whileLeaseIsLive.prepare("SELECT COUNT(*) AS count FROM inbox").get()).toEqual({
        count: 0,
      });
    } finally {
      whileLeaseIsLive.close();
    }

    await waitForExecution(restarted, project.id, published.id, "completed", 10_000);
    await waitForEvents(restarted, project.id, 2);

    const recovered = new Database(join(dataRoot, "jarvis.sqlite"));
    try {
      expect(
        recovered.prepare("SELECT attempt, status FROM executions ORDER BY attempt, id").all(),
      ).toEqual([
        { attempt: 1, status: "failed" },
        { attempt: 2, status: "completed" },
      ]);
      expect(
        recovered
          .prepare("SELECT attempt, COUNT(*) AS count FROM executions GROUP BY attempt")
          .all(),
      ).toEqual([
        { attempt: 1, count: 1 },
        { attempt: 2, count: 1 },
      ]);
      expect(
        recovered
          .prepare(
            `SELECT COUNT(*) AS count FROM inbox
             WHERE project_id = ? AND module_instance_id = ? AND event_id = ?`,
          )
          .get(project.id, "github", published.id),
      ).toEqual({ count: 1 });
      expect(recovered.prepare("SELECT COUNT(*) AS count FROM dead_letters").get()).toEqual({
        count: 0,
      });
      expect(
        recovered
          .prepare(
            `SELECT attempt_count, consumed_at, lease_owner, lease_expires_at
             FROM deliveries WHERE event_id = ?`,
          )
          .get(published.id),
      ).toMatchObject({ attempt_count: 2, consumed_at: expect.any(String) });
      expect(
        recovered
          .prepare("SELECT COUNT(*) AS count FROM events WHERE project_id = ?")
          .get(project.id),
      ).toEqual({ count: 2 });
      expect(
        recovered
          .prepare("SELECT COUNT(*) AS count FROM deliveries WHERE project_id = ? AND event_id = ?")
          .get(project.id, published.id),
      ).toEqual({ count: 1 });
    } finally {
      recovered.close();
    }
    expect(fakeGitHub.pullRequests).toHaveLength(1);
    expect(
      fakeGitHub.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/pulls"),
      ),
    ).toHaveLength(2); // one transient failure, then the one successful creation
  });

  it("adopts a pull request after creation crashes before mapping", async () => {
    const fakeGitHub = await startFakeGitHubApi();
    servers.push(fakeGitHub);
    const credential = "ghs_lookup_recovery_sentinel";
    const executableRoot = mkdtempSync(join(tmpdir(), "jarvis-gh-credentials-"));
    roots.push(executableRoot);
    const executable = join(executableRoot, "gh");
    writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${credential}'\n`, "utf8");
    chmodSync(executable, 0o755);

    const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-github-lookup-recovery-"));
    roots.push(dataRoot);
    const crashed = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: {
        JARVIS_ENABLE_TEST_HOOKS: "1",
        JARVIS_FAILPOINT: "after-github-create-before-external-mapping",
        JARVIS_GH_EXECUTABLE: executable,
        JARVIS_GITHUB_API_BASE_URL: fakeGitHub.baseUrl,
      },
    });
    engines.push(crashed);

    await registerGitHubConnection(crashed, "connection/github", "Account");
    const project = await createGitHubProject(crashed, "project-lookup-recovery");
    await bindAndActivate(crashed, project, "connection/github");
    const published = await publishCreationRequest(
      crashed,
      project.id,
      "github://QServices/repo/issues/42",
    );
    const exitCode = await crashed.waitForExit();
    expect(exitCode).not.toBe(0);
    await crashed.dispose();
    engines.splice(engines.indexOf(crashed), 1);

    const beforeRestart = new Database(join(dataRoot, "jarvis.sqlite"));
    try {
      expect(
        beforeRestart
          .prepare(
            `SELECT status, resource_ref FROM external_mappings
             WHERE project_id = 'project-lookup-recovery' AND module_instance_id = 'github'`,
          )
          .get(),
      ).toEqual({ status: "attempted", resource_ref: null });
      expect(
        beforeRestart
          .prepare("SELECT 1 FROM events WHERE type = 'scm.change-request.created'")
          .get(),
      ).toBeUndefined();
    } finally {
      beforeRestart.close();
    }
    expect(fakeGitHub.pullRequests).toHaveLength(1);

    const restarted = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: {
        JARVIS_ENABLE_TEST_HOOKS: "1",
        JARVIS_GH_EXECUTABLE: executable,
        JARVIS_GITHUB_API_BASE_URL: fakeGitHub.baseUrl,
      },
    });
    engines.push(restarted);
    await waitForExecution(restarted, project.id, published.id, "completed");
    const events = await waitForEvents(restarted, project.id, 2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "scm.change-request.created",
          subjectRef: "github://QServices/repo/pulls/1",
        }),
      ]),
    );
    expect(fakeGitHub.pullRequests).toHaveLength(1);
    expect(
      fakeGitHub.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/pulls"),
      ),
    ).toHaveLength(1);
    const lookups = fakeGitHub.requests.filter(
      (request) => request.method === "GET" && request.path.includes("/pulls?head="),
    );
    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.path).toContain("head=agent%2Fproject-lookup-recovery%2Fissue-42");
    expect(fakeGitHub.requests.some((request) => request.credential === credential)).toBe(true);

    const afterRestart = new Database(join(dataRoot, "jarvis.sqlite"));
    try {
      expect(
        afterRestart
          .prepare(
            `SELECT status, resource_ref FROM external_mappings
             WHERE project_id = 'project-lookup-recovery' AND module_instance_id = 'github'`,
          )
          .get(),
      ).toEqual({
        status: "completed",
        resource_ref: `${fakeGitHub.baseUrl}/repos/QServices/repo/pull/1`,
      });
    } finally {
      afterRestart.close();
    }
  });

  it("publishes redacted classified failures and retries an attempted request", async () => {
    const fakeGitHub = await startFakeGitHubApi();
    servers.push(fakeGitHub);
    const credential = "ghs_failure_secret";
    const executableRoot = mkdtempSync(join(tmpdir(), "jarvis-gh-credentials-"));
    roots.push(executableRoot);
    const executable = join(executableRoot, "gh");
    writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${credential}'\n`, "utf8");
    chmodSync(executable, 0o755);

    const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-github-failures-"));
    roots.push(dataRoot);
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: {
        JARVIS_ENABLE_TEST_HOOKS: "1",
        JARVIS_GH_EXECUTABLE: executable,
        JARVIS_GITHUB_API_BASE_URL: fakeGitHub.baseUrl,
      },
    });
    engines.push(engine);

    await registerGitHubConnection(engine, "connection/github", "Account");
    const project = await createGitHubProject(engine, "project-failures");
    await bindAndActivate(engine, project, "connection/github");

    const failureCases = [
      {
        workItemRef: "github://QServices/repo/issues/401",
        response: { status: 401, body: { message: credential } },
        code: "github.unauthorized",
        retryable: false,
      },
      {
        workItemRef: "github://QServices/repo/issues/402",
        response: { status: 422, body: { message: "Head branch not found" } },
        code: "github.branch-not-found",
        retryable: false,
      },
      {
        workItemRef: "github://QServices/repo/issues/403",
        response: { status: 422, body: { message: "Validation Failed" } },
        code: "github.change-request-invalid",
        retryable: false,
      },
      {
        workItemRef: "github://QServices/repo/issues/404",
        response: { status: 403, body: { message: "API rate limit exceeded" } },
        code: "github.rate-limited",
        retryable: true,
      },
      {
        workItemRef: "github://QServices/repo/issues/405",
        response: { status: 500, body: { message: "opaque provider detail" } },
        code: "github.change-request-create-failed",
        retryable: true,
      },
    ] as const;
    const failedEvents: string[] = [];
    for (const failureCase of failureCases) {
      const restore = fakeGitHub.scriptRoute(
        "POST",
        "/repos/QServices/repo/pulls",
        failureCase.response,
      );
      try {
        const published = await publishCreationRequest(engine, project.id, failureCase.workItemRef);
        failedEvents.push(published.id);
        await waitForExecution(engine, project.id, published.id, "failed");
      } finally {
        restore();
      }
    }

    const retried = await publishCreationRequest(engine, project.id, failureCases[0]!.workItemRef);
    await waitForExecution(engine, project.id, retried.id, "completed");
    const events = await waitForEvents(engine, project.id, 12);
    const failures = events.filter(
      (event) => event["type"] === "scm.change-request.creation-failed",
    );
    expect(failures).toHaveLength(5);
    expect(events.filter((event) => event["type"] === "scm.change-request.created")).toEqual([
      expect.objectContaining({ subjectRef: "github://QServices/repo/pulls/1" }),
    ]);
    expect(fakeGitHub.pullRequests).toHaveLength(1);
    expect(
      fakeGitHub.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/pulls"),
      ),
    ).toHaveLength(6);
    expect(
      fakeGitHub.requests.filter(
        (request) => request.method === "GET" && request.path.includes("/pulls?head="),
      ),
    ).toHaveLength(1);

    await engine.dispose();
    engines.splice(engines.indexOf(engine), 1);
    const database = new Database(join(dataRoot, "jarvis.sqlite"));
    try {
      const inbox = database
        .prepare("SELECT event_id, status, result FROM inbox ORDER BY rowid")
        .all() as readonly {
        readonly event_id: string;
        readonly status: string;
        readonly result: string;
      }[];
      const failurePayloads = database
        .prepare(
          "SELECT envelope FROM events WHERE type = 'scm.change-request.creation-failed' ORDER BY rowid",
        )
        .all() as readonly { readonly envelope: string }[];
      expect(
        failurePayloads.map(
          ({ envelope }) => (JSON.parse(envelope) as { payload: Record<string, unknown> }).payload,
        ),
      ).toEqual(
        failureCases.map(({ workItemRef, code, retryable }) => ({
          repositoryId: "main",
          workItemRef,
          code,
          message: expect.stringContaining(
            `GitHub could not create a Change Request for repository main and Work Item ${workItemRef}:`,
          ),
          retryable,
        })),
      );
      expect(JSON.stringify(failurePayloads)).not.toContain(credential);
      expect(JSON.stringify(failurePayloads)).not.toContain("opaque provider detail");
      // Permanent provider failures are dead-lettered; retryable failures are
      // retried and the eventual successful attempt is the only Inbox row.
      expect(inbox).toHaveLength(1);
      expect(inbox.some(({ event_id }) => failedEvents.includes(event_id))).toBe(false);
      expect(
        database.prepare("SELECT code, attempts FROM dead_letters ORDER BY rowid").all(),
      ).toEqual([
        { code: "github.unauthorized", attempts: 1 },
        { code: "github.branch-not-found", attempts: 1 },
        { code: "github.change-request-invalid", attempts: 1 },
      ]);
      expect(
        database
          .prepare(
            `SELECT status, COUNT(*) AS count FROM external_mappings
             WHERE project_id = 'project-failures' GROUP BY status ORDER BY status`,
          )
          .all(),
      ).toEqual([
        { status: "attempted", count: 4 },
        { status: "completed", count: 1 },
      ]);
      expect(JSON.stringify(inbox)).not.toContain(credential);
    } finally {
      database.close();
    }
  });
});

async function registerGitHubConnection(
  engine: Harness,
  id: string,
  account: string,
): Promise<void> {
  const response = await engine.call("/v1/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id,
      kind: "github",
      displayName: account,
      secretRef: `gh://${account}`,
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const validation = await engine.call(`/v1/connections/${encodeURIComponent(id)}/validate`, {
    method: "POST",
  });
  expect(validation.status, await validation.clone().text()).toBe(200);
}

async function createGitHubProject(
  engine: Harness,
  id: string,
): Promise<{ readonly id: string; readonly repositoryPath: string }> {
  const repositoryPath = makeNodeRepositoryFixture({
    projectYaml: stringifyYaml(githubProjectConfiguration(id)),
  });
  repositories.push(repositoryPath);
  const response = await engine.call("/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositoryPath }),
  });
  const body = (await response.json()) as { readonly id?: string; readonly error?: unknown };
  expect(response.status, JSON.stringify(body)).toBe(201);
  expect(body.id).toBe(id);
  return { id: body.id!, repositoryPath };
}

async function bindAndActivate(
  engine: Harness,
  project: { readonly id: string; readonly repositoryPath: string },
  connectionRef: string,
): Promise<void> {
  const repositoryBinding = await engine.call(
    `/v1/projects/${project.id}/repositories/main/binding`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: realpathSync(project.repositoryPath),
        bookmarkRef: `bookmark/${project.id}`,
      }),
    },
  );
  expect(repositoryBinding.status, await repositoryBinding.clone().text()).toBe(200);
  const bindingsResponse = await engine.call(`/v1/projects/${project.id}/bindings`);
  expect(bindingsResponse.status, await bindingsResponse.clone().text()).toBe(200);
  const bindings = (await bindingsResponse.json()) as ProjectBindings;
  const bound = await engine.call(`/v1/projects/${project.id}/bindings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...bindings,
      // The Development Module is a route producer in this fixture; its
      // runtime is never invoked by the test event.
      slots: {
        ...bindings.slots,
        sourceControl: { kind: "connection", ref: connectionRef },
        agentRuntime: { kind: "runtime", ref: "runtime/fake-test" },
      },
    }),
  });
  expect(bound.status, await bound.clone().text()).toBe(200);

  const reportResponse = await engine.call(`/v1/projects/${project.id}/validation-report`, {
    method: "POST",
  });
  const report = (await reportResponse.json()) as {
    readonly valid: boolean;
    readonly compositionFingerprint?: string;
  };
  expect(reportResponse.status, JSON.stringify(report)).toBe(200);
  expect(report.valid, JSON.stringify(report)).toBe(true);
  const activated = await engine.call(`/v1/projects/${project.id}/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ compositionFingerprint: report.compositionFingerprint }),
  });
  expect(activated.status, await activated.clone().text()).toBe(200);
}

async function publishCreationRequest(
  engine: Harness,
  projectId: string,
  workItemRef: string,
  idempotencyKey = `${projectId}:${workItemRef}`,
): Promise<{ readonly id: string }> {
  const response = await sendCreationRequest(engine, projectId, workItemRef, idempotencyKey);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { readonly id: string };
}

async function rejectCreationRequestWithoutIdempotencyKey(
  engine: Harness,
  projectId: string,
  workItemRef: string,
): Promise<void> {
  const response = await sendCreationRequest(engine, projectId, workItemRef, null);
  expect(response.status, await response.clone().text()).toBe(400);
}

async function sendCreationRequest(
  engine: Harness,
  projectId: string,
  workItemRef: string,
  idempotencyKey: string | null,
): Promise<Response> {
  const issueNumber = /\/issues\/([1-9]\d*)$/.exec(workItemRef)?.[1] ?? "42";
  const response = await engine.call("/test/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "scm.change-request.creation-requested",
      version: 1,
      kind: "request",
      projectId,
      repositoryId: "main",
      producer: { moduleId: "jarvis.module.development", moduleInstanceId: "development" },
      subject: {
        type: "pushed-branch",
        ref: `git://repository/${projectId}/agent/issue-42`,
      },
      correlationId: `corr_${projectId}`,
      causationId: null,
      target: { binding: "sourceControl" },
      ...(idempotencyKey === null
        ? {}
        : { idempotencyKey: idempotencyKey ?? `${projectId}:${workItemRef}` }),
      payload: {
        repositoryId: "main",
        workItemRef,
        baseBranch: "main",
        headBranch: `agent/${projectId}/issue-${issueNumber}`,
        headCommit: "abc1234",
        title: "feat: create pull request",
        description: "A deterministic test pull request.",
      },
    }),
  });
  return response;
}

async function waitForEvents(
  engine: Harness,
  projectId: string,
  count: number,
  timeoutMs = 5_000,
): Promise<readonly Record<string, unknown>[]> {
  const startedAt = Date.now();
  for (;;) {
    const response = await engine.call(`/v1/projects/${projectId}/events`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { readonly items: readonly Record<string, unknown>[] };
    if (body.items.length >= count) return body.items;
    if (Date.now() - startedAt > timeoutMs)
      throw new Error(`project ${projectId} did not reach ${count} events`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForExecution(
  engine: Harness,
  projectId: string,
  eventId: string,
  status: "completed" | "failed",
  timeoutMs = 5_000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const response = await engine.call(`/v1/projects/${projectId}/executions`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly items: readonly { readonly inputEventId: string; readonly status: string }[];
    };
    if (body.items.some((item) => item.inputEventId === eventId && item.status === status)) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`event ${eventId} did not reach ${status}: ${JSON.stringify(body.items)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function githubProjectConfiguration(id: string): Record<string, unknown> {
  const configuration = parseYaml(
    readFileSync(join(ROOT, "examples/project/.jarvis/project.yaml"), "utf8"),
  ) as Record<string, unknown>;
  configuration["metadata"] = { id, name: id };
  configuration["slots"] = {
    sourceControl: { requires: "scm.change-request.manage" },
    agentRuntime: { requires: "agent.execute" },
  };
  configuration["modules"] = [
    {
      instanceId: "github",
      moduleId: "jarvis.module.github",
      enabled: true,
      bindings: { sourceControl: "sourceControl" },
      configuration: {
        bootstrapLabelPolicy: "ignore-existing",
        pollIntervalSeconds: 60,
        repositories: ["main"],
      },
    },
    {
      instanceId: "development",
      moduleId: "jarvis.module.development",
      enabled: true,
      runtimeSlot: "agentRuntime",
      bindings: { repository: "main", sourceControl: "sourceControl" },
      configuration: {
        validationOrder: ["test"],
        maxRepairCycles: 0,
        retainWorkspaceOnSuccess: false,
        timeoutMs: 300000,
        outputLimitBytes: 1048576,
        environmentAllowlist: [],
      },
    },
  ];
  return configuration;
}
