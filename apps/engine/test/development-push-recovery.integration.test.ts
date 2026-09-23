import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  startReferenceWorkflowFixture,
  type ReferenceWorkflowFixture,
} from "./reference-workflow-fixture.js";

const fixtures: ReferenceWorkflowFixture[] = [];
const databases: Database.Database[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

describe("Development push crash recovery", () => {
  it.each([
    "after-development-push-before-checkpoint",
    "after-development-checkpoint-before-terminal",
  ])("finalizes %s without running the agent again", async (failpoint) => {
    const { fixture, database, commit, executionId } = await crash(failpoint);
    expect(
      database
        .prepare("SELECT count(*) AS n FROM execution_checkpoints WHERE type = 'branch.pushed'")
        .get(),
    ).toEqual({ n: failpoint.includes("before-checkpoint") ? 0 : 1 });
    await fixture.restart();
    await assertSuccess(fixture, database, commit);
    expect(database.prepare("SELECT status FROM executions WHERE id = ?").get(executionId)).toEqual(
      { status: "completed" },
    );
    expect(
      database
        .prepare("SELECT count(*) AS n FROM executions WHERE module_instance_id = 'development'")
        .get(),
    ).toEqual({ n: 3 });
    console.log(
      JSON.stringify({
        failpoint,
        sha: commit.sha,
        runtimeCalls: runtimeCalls(fixture),
        pullRequests: fixture.fakeGitHub.pullRequests.length,
      }),
    );
  });

  it("survives repeated recovery crashes, including after workspace cleanup, and terminal redelivery", async () => {
    const { fixture, database, commit } = await crash();
    for (const failpoint of [
      "after-development-checkpoint-before-terminal",
      "after-development-checkpoint-before-terminal",
      "after-development-cleanup-before-terminal",
    ]) {
      await fixture.restart({ JARVIS_FAILPOINT: failpoint });
      expect(await fixture.engine.waitForExit()).toBe(128);
      expect(runtimeCalls(fixture)).toBe(1);
      expect(remoteHead(fixture, commit.branch)).toBe(commit.sha);
      expect(fixture.fakeGitHub.pullRequests).toHaveLength(0);
    }
    await fixture.restart();
    await assertSuccess(fixture, database, commit);
    const delivery = database
      .prepare("SELECT event_id FROM deliveries WHERE module_id = 'jarvis.module.development'")
      .get() as { event_id: string };
    const response = await fixture.engine.call("/test/redeliver", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: fixture.projectId,
        eventId: delivery.event_id,
        moduleId: "jarvis.module.development",
        moduleInstanceId: "development",
      }),
    });
    expect(await response.json()).toMatchObject({
      redelivered: true,
      executionId: null,
      status: "completed",
    });
    await fixture.restart();
    await assertSuccess(fixture, database, commit);
  });

  it.each(["remote-divergent", "workspace-modified"])(
    "retains evidence and exposes a safe diagnostic for %s",
    async (scenario) => {
      const { fixture, database, commit, workspacePath } = await crash();
      if (scenario === "remote-divergent")
        remoteGit(fixture, ["update-ref", `refs/heads/${commit.branch}`, fixture.initialCommitSha]);
      if (scenario === "workspace-modified")
        writeFileSync(
          `${workspacePath}/user-work.txt`,
          "Work added by the user after the crash.\n",
        );
      await fixture.restart();
      const code = "git.recovery-required";
      await expect.poll(async () => (await deadLetters(fixture))[0]?.code).toBe(code);
      await assertFailureVisible(fixture, code);
      expect(runtimeCalls(fixture)).toBe(1);
      expect(fixture.fakeGitHub.pullRequests).toHaveLength(0);
      expect(remoteHead(fixture, commit.branch)).toBe(
        scenario === "remote-divergent" ? fixture.initialCommitSha : commit.sha,
      );
      expect(existsSync(workspacePath)).toBe(true);
      expect(
        database
          .prepare(
            "SELECT count(*) AS n FROM outbox WHERE json_extract(envelope, '$.type') IN ('development.implementation.completed', 'scm.change-request.creation-requested')",
          )
          .get(),
      ).toEqual({ n: 0 });
      if (scenario === "workspace-modified")
        expect(readFileSync(`${workspacePath}/user-work.txt`, "utf8")).toContain(
          "Work added by the user",
        );
      await fixture.restart();
      expect(existsSync(workspacePath)).toBe(true);
      expect(runtimeCalls(fixture)).toBe(1);
    },
  );

  it.each(["remote", "branch"])(
    "retries a temporarily unavailable %s without implementing again",
    async (unavailable) => {
      const { fixture, database, commit } = await crash();
      if (unavailable === "remote")
        renameSync(fixture.bareRemoteRoot, `${fixture.bareRemoteRoot}-offline`);
      else remoteGit(fixture, ["update-ref", "-d", `refs/heads/${commit.branch}`]);
      try {
        await fixture.restart();
        await assertFailureVisible(fixture, "git.recovery-unavailable");
        expect(runtimeCalls(fixture)).toBe(1);
        expect(fixture.fakeGitHub.pullRequests).toHaveLength(0);
      } finally {
        if (unavailable === "remote")
          renameSync(`${fixture.bareRemoteRoot}-offline`, fixture.bareRemoteRoot);
        else remoteGit(fixture, ["update-ref", `refs/heads/${commit.branch}`, commit.sha]);
      }
      await assertSuccess(fixture, database, commit);
      expect(
        (
          database
            .prepare(
              "SELECT count(*) AS n FROM executions WHERE module_instance_id = 'development' AND status = 'failed'",
            )
            .get() as { n: number }
        ).n,
      ).toBeGreaterThan(0);
    },
  );

  it("bounds missing-branch retries and replays the same intention after repair", async () => {
    const { fixture, database, commit, workspacePath } = await crash();
    remoteGit(fixture, ["update-ref", "-d", `refs/heads/${commit.branch}`]);
    await fixture.restart();
    await expect
      .poll(async () => (await deadLetters(fixture))[0], { timeout: 30000 })
      .toMatchObject({ code: "delivery.retry-exhausted", attempts: 5 });
    const dead = (await deadLetters(fixture))[0]!;
    expect(runtimeCalls(fixture)).toBe(1);
    expect(fixture.fakeGitHub.pullRequests).toHaveLength(0);
    expect(existsSync(workspacePath)).toBe(true);
    remoteGit(fixture, ["update-ref", `refs/heads/${commit.branch}`, commit.sha]);
    const response = await fixture.engine.call(
      `/v1/dead-letters/${encodeURIComponent(dead.deliveryId)}/replay`,
      { method: "POST" },
    );
    expect(response.status, await response.clone().text()).toBe(202);
    await assertSuccess(fixture, database, commit);
    expect(await deadLetters(fixture)).toEqual([]);
  }, 60000);

  it.each([false, true])(
    "does not release or use a live owner's workspace (directory missing: %s)",
    async (missing) => {
      const { fixture, database, commit, workspacePath } = await crash();
      const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      await new Promise<void>((resolve, reject) => {
        owner.once("spawn", resolve);
        owner.once("error", reject);
      });
      const exited = new Promise<void>((resolve) => owner.once("exit", () => resolve()));
      try {
        database
          .prepare("UPDATE workspace_leases SET owner_pid = ? WHERE status = 'active'")
          .run(owner.pid);
        if (missing) renameSync(workspacePath, `${fixture.repositoryRoot}-offline`);
        await fixture.restart();
        await assertFailureVisible(fixture, "workspace.release-failed");
        expect(database.prepare("SELECT status, owner_pid FROM workspace_leases").get()).toEqual({
          status: "active",
          owner_pid: owner.pid,
        });
        expect(existsSync(missing ? `${fixture.repositoryRoot}-offline` : workspacePath)).toBe(
          true,
        );
        expect(runtimeCalls(fixture)).toBe(1);
        expect(fixture.fakeGitHub.pullRequests).toHaveLength(0);
      } finally {
        owner.kill("SIGKILL");
        await exited;
        if (missing && existsSync(`${fixture.repositoryRoot}-offline`))
          renameSync(`${fixture.repositoryRoot}-offline`, workspacePath);
      }
      await fixture.restart();
      await assertSuccess(fixture, database, commit);
    },
  );
});

async function crash(failpoint = "after-development-push-before-checkpoint") {
  const fixture = await startReferenceWorkflowFixture("push-recovery", {
    JARVIS_FAILPOINT: failpoint,
  });
  fixtures.push(fixture);
  fixture.fakeGitHub.appendLabeledIssueEvent({
    owner: "Gasppacho",
    repository: "jarvis",
    issueNumber: 191,
    issueTitle: "Recover pushed change",
    issueBody: "Keep the existing pushed implementation.",
    label: "ready-to-dev",
    actor: "recovery-user",
    createdAt: new Date().toISOString(),
  });
  expect(await fixture.engine.waitForExit()).toBe(128);
  const database = new Database(`${fixture.engine.dataRoot}/jarvis.sqlite`);
  databases.push(database);
  const checkpoint = database
    .prepare(
      "SELECT execution_id, payload FROM execution_checkpoints WHERE type = 'commit.created'",
    )
    .get() as { execution_id: string; payload: string };
  const commit = JSON.parse(checkpoint.payload) as { branch: string; sha: string };
  const lease = database
    .prepare("SELECT workspace_path FROM workspace_leases WHERE execution_id = ?")
    .get(checkpoint.execution_id) as { workspace_path: string };
  expect(remoteHead(fixture, commit.branch)).toBe(commit.sha);
  expect(runtimeCalls(fixture)).toBe(1);
  expect(fixture.fakeGitHub.pullRequests).toHaveLength(0);
  return {
    fixture,
    database,
    commit,
    executionId: checkpoint.execution_id,
    workspacePath: lease.workspace_path,
  };
}

async function assertSuccess(
  fixture: ReferenceWorkflowFixture,
  database: Database.Database,
  commit: { branch: string; sha: string },
) {
  await expect.poll(() => fixture.fakeGitHub.pullRequests.length, { timeout: 15000 }).toBe(1);
  await expect
    .poll(() =>
      database
        .prepare("SELECT count(*) AS n FROM events WHERE type = 'scm.change-request.created'")
        .get(),
    )
    .toEqual({ n: 1 });
  expect(runtimeCalls(fixture)).toBe(1);
  expect(remoteHead(fixture, commit.branch)).toBe(commit.sha);
  expect(
    remoteGit(fixture, ["rev-list", "--count", `${fixture.initialCommitSha}..${commit.sha}`]),
  ).toBe("1");
  expect(
    remoteGit(fixture, ["for-each-ref", "--format=%(refname:short)", "refs/heads/agent/"]).split(
      "\n",
    ),
  ).toEqual([commit.branch]);
  expect(
    database.prepare("SELECT count(*) AS n FROM workspace_leases WHERE status <> 'released'").get(),
  ).toEqual({ n: 0 });
  const events = database
    .prepare(
      "SELECT type, envelope FROM events WHERE type IN ('development.implementation.requested', 'development.implementation.completed', 'scm.change-request.creation-requested', 'scm.change-request.created')",
    )
    .all() as { type: string; envelope: string }[];
  expect(events).toHaveLength(4);
  const envelopes = events.map(
    (event) =>
      JSON.parse(event.envelope) as {
        id: string;
        type: string;
        correlationId: string;
        causationId: string;
        idempotencyKey: string;
        payload: Record<string, unknown>;
      },
  );
  expect(new Set(envelopes.map((event) => event.correlationId)).size).toBe(1);
  const implementation = envelopes.find(
    (event) => event.type === "development.implementation.requested",
  )!;
  const completed = envelopes.find(
    (event) => event.type === "development.implementation.completed",
  )!;
  const creation = envelopes.find(
    (event) => event.type === "scm.change-request.creation-requested",
  )!;
  expect(completed.causationId).toBe(implementation.id);
  expect(creation.causationId).toBe(implementation.id);
  expect(creation.payload["title"]).toBe("Implement Recover pushed change");
  expect(completed.payload).toMatchObject({ headCommit: commit.sha });
  expect(completed.payload).not.toHaveProperty("validation");
  expect(
    database
      .prepare(
        "SELECT status, resource_ref FROM external_mappings WHERE project_id = ? AND module_instance_id = 'github' AND idempotency_key = ?",
      )
      .get(fixture.projectId, creation.idempotencyKey),
  ).toEqual({ status: "completed", resource_ref: fixture.fakeGitHub.pullRequests[0]!.htmlUrl });
  expect(
    fixture.fakeGitHub.requests.filter(
      (request) => request.method === "POST" && request.path.endsWith("/pulls"),
    ),
  ).toHaveLength(1);
}

async function assertFailureVisible(fixture: ReferenceWorkflowFixture, code: string) {
  await expect
    .poll(
      async () => {
        const response = await fixture.engine.call(`/v1/projects/${fixture.projectId}/events`);
        const text = await response.text();
        expect(text).not.toContain("ghs_reference_fixture");
        expect(text).not.toContain(fixture.repositoryRoot);
        return text.includes("development.implementation.failed");
      },
      { timeout: 5000 },
    )
    .toBe(true);
  const executions = await fixture.engine.call(`/v1/projects/${fixture.projectId}/executions`);
  const body = await executions.text();
  const diagnostic =
    code === "git.recovery-unavailable"
      ? "cannot currently be read"
      : code === "workspace.release-failed"
        ? "live process"
        : "before replay";
  expect(body).toContain(diagnostic);
  expect(body).not.toContain("ghs_reference_fixture");
  expect(body).not.toContain(fixture.repositoryRoot);
  expect(fixture.engine.stderr()).not.toContain("ghs_reference_fixture");
}

async function deadLetters(fixture: ReferenceWorkflowFixture) {
  const response = await fixture.engine.call(`/v1/projects/${fixture.projectId}/dead-letters`);
  return (
    (await response.json()) as { items: { deliveryId: string; code: string; attempts: number }[] }
  ).items;
}

function runtimeCalls(fixture: ReferenceWorkflowFixture): number {
  return readFileSync(fixture.runtimeCounterPath, "utf8").trim().split("\n").filter(Boolean).length;
}
function remoteHead(fixture: ReferenceWorkflowFixture, branch: string): string {
  return remoteGit(fixture, ["rev-parse", `refs/heads/${branch}`]);
}
function remoteGit(fixture: ReferenceWorkflowFixture, args: string[]): string {
  return execFileSync("git", ["--git-dir", fixture.bareRemoteRoot, ...args], {
    encoding: "utf8",
  }).trim();
}
