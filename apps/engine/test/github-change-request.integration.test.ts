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

    const invalid = await publishCreationRequest(
      engine,
      projectA.id,
      "gitlab://QServices/repo/issues/44",
    );
    await waitForExecution(engine, projectA.id, invalid.id, "failed");

    expect(fakeGitHub.pullRequests).toHaveLength(2);
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
        head: "agent/project-b/issue-42",
        draft: false,
      }),
    ]);
    expect(fakeGitHub.requests.filter((request) => request.method === "POST")).toEqual([
      expect.objectContaining({ credential: credentialA }),
      expect.objectContaining({ credential: credentialB }),
    ]);

    const eventsA = await waitForEvents(engine, projectA.id, 2);
    const eventsB = await waitForEvents(engine, projectB.id, 2);
    expect(eventsA.filter((event) => event["type"] === "scm.change-request.created")).toEqual([
      expect.objectContaining({
        type: "scm.change-request.created",
        kind: "fact",
        producer: "github",
        subjectRef: "github://QServices/repo/pulls/1",
        correlationId: expect.stringMatching(/^corr_/),
        causationId: createdA.id,
      }),
    ]);
    expect(eventsB.filter((event) => event["type"] === "scm.change-request.created")).toEqual([
      expect.objectContaining({
        producer: "github",
        subjectRef: "github://QServices/repo/pulls/2",
        causationId: createdB.id,
      }),
    ]);
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
          "SELECT project_id, envelope FROM events WHERE type = 'scm.change-request.created' ORDER BY project_id",
        )
        .all() as readonly { readonly project_id: string; readonly envelope: string }[];
      expect(createdFacts.map(({ project_id }) => project_id)).toEqual(["project-a", "project-b"]);
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
): Promise<{ readonly id: string }> {
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
      idempotencyKey: `${projectId}:${workItemRef}`,
      payload: {
        repositoryId: "main",
        workItemRef,
        baseBranch: "main",
        headBranch: `agent/${projectId}/issue-42`,
        headCommit: "abc1234",
        title: "feat: create pull request",
        description: "A deterministic test pull request.",
      },
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { readonly id: string };
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
