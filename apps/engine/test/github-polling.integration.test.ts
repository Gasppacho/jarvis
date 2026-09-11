import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine, startFakeGitHubApi, type FakeGitHubApi, type Harness } from "./harness.js";
import { makeNodeRepositoryFixture } from "./repository-fixture.js";
import type { ProjectBindings } from "../../../packages/project-runtime/src/project-types.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TEST_BUNDLE = fileURLToPath(
  new URL("../../../dist/engine/engine.test-bundle.mjs", import.meta.url),
);
const engines: Harness[] = [];
const roots: string[] = [];
const servers: FakeGitHubApi[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GitHub polling Application Harness", () => {
  it("polls an active Project's repositories with its bound credential and emits no event", async () => {
    const fakeGitHub = await startFakeGitHubApi();
    servers.push(fakeGitHub);
    const credential = "ghs_polling_sentinel";
    const rotatedCredential = "ghs_polling_rotated";
    const executableRoot = mkdtempSync(join(tmpdir(), "jarvis-polling-gh-"));
    roots.push(executableRoot);
    const executable = join(executableRoot, "gh");
    const credentialFile = join(executableRoot, "credential");
    writeFileSync(credentialFile, `${credential}\n`, "utf8");
    writeFileSync(
      executable,
      `#!/bin/sh
case "$*" in
  *"--user PollingAccount"*) cat '${credentialFile}';;
  *) exit 1;;
esac
`,
      "utf8",
    );
    chmodSync(executable, 0o755);

    const engine = await startEngine({
      enginePath: TEST_BUNDLE,
      env: {
        JARVIS_ENABLE_TEST_HOOKS: "1",
        JARVIS_GH_EXECUTABLE: executable,
        JARVIS_GITHUB_API_BASE_URL: fakeGitHub.baseUrl,
        JARVIS_GITHUB_POLL_INTERVAL_MS: "25",
      },
    });
    engines.push(engine);

    await registerConnection(engine);
    const project = await createProject(engine);
    await bindAndActivate(engine, project.id);
    fakeGitHub.appendLabeledIssueEvent({
      owner: "Gasppacho",
      repository: "jarvis",
      issueNumber: 15,
      issueTitle: "Poll labels",
      label: "agent:ready",
      actor: "octocat",
      createdAt: "2026-09-11T09:00:00.000Z",
    });
    fakeGitHub.appendLabeledIssueEvent({
      owner: "Other",
      repository: "repo",
      issueNumber: 16,
      issueTitle: "Poll another repository",
      label: "agent:ready",
      actor: "octocat",
      createdAt: "2026-09-11T09:01:00.000Z",
    });

    await waitForRequest(fakeGitHub, "/repos/Gasppacho/jarvis/issues/events");
    await waitForRequest(fakeGitHub, "/repos/Other/repo/issues/events");
    expect(issueEventRequests(fakeGitHub)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/repos/Gasppacho/jarvis/issues/events",
          credential,
        }),
        expect.objectContaining({
          path: "/repos/Other/repo/issues/events",
          credential,
        }),
      ]),
    );

    writeFileSync(credentialFile, `${rotatedCredential}\n`, "utf8");
    await waitForCredential(fakeGitHub, rotatedCredential);
    expect(issueEventRequests(fakeGitHub)).toEqual(
      expect.arrayContaining([expect.objectContaining({ credential: rotatedCredential })]),
    );

    const eventsResponse = await engine.call(`/v1/projects/${project.id}/events`);
    expect(eventsResponse.status).toBe(200);
    const events = (await eventsResponse.json()) as { items: readonly unknown[] };
    expect(events.items).toEqual([]);

    const health = await engine.call("/v1/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ready" });
  });
});

async function registerConnection(engine: Harness): Promise<void> {
  const created = await engine.call("/v1/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "connection/github-polling",
      kind: "github",
      displayName: "PollingAccount",
      secretRef: "gh://PollingAccount",
    }),
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const validated = await engine.call("/v1/connections/connection%2Fgithub-polling/validate", {
    method: "POST",
  });
  expect(validated.status, await validated.clone().text()).toBe(200);
}

async function createProject(engine: Harness): Promise<{ readonly id: string }> {
  const projectPath = makeNodeRepositoryFixture({ projectYaml: stringifyYaml(projectConfig()) });
  roots.push(projectPath);
  const response = await engine.call("/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositoryPath: projectPath }),
  });
  const body = (await response.json()) as { readonly id?: string };
  expect(response.status, JSON.stringify(body)).toBe(201);
  expect(body.id).toBe("polling-project");
  return { id: body.id! };
}

async function bindAndActivate(engine: Harness, projectId: string): Promise<void> {
  const bindingsResponse = await engine.call(`/v1/projects/${projectId}/bindings`);
  expect(bindingsResponse.status).toBe(200);
  const bindings = (await bindingsResponse.json()) as ProjectBindings;
  const saved = await engine.call(`/v1/projects/${projectId}/bindings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...bindings,
      slots: {
        ...bindings.slots,
        sourceControl: { kind: "connection", ref: "connection/github-polling" },
      },
    }),
  });
  expect(saved.status, await saved.clone().text()).toBe(200);

  const reportResponse = await engine.call(`/v1/projects/${projectId}/validation-report`, {
    method: "POST",
  });
  const report = (await reportResponse.json()) as {
    readonly valid: boolean;
    readonly compositionFingerprint?: string;
  };
  expect(reportResponse.status, JSON.stringify(report)).toBe(200);
  expect(report.valid, JSON.stringify(report)).toBe(true);
  const activated = await engine.call(`/v1/projects/${projectId}/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ compositionFingerprint: report.compositionFingerprint }),
  });
  expect(activated.status, await activated.clone().text()).toBe(200);
}

function projectConfig(): Record<string, unknown> {
  const configuration = parseYaml(
    readFileSync(join(ROOT, "examples/project/.jarvis/project.yaml"), "utf8"),
  ) as Record<string, unknown>;
  configuration["metadata"] = { id: "polling-project", name: "Polling Project" };
  configuration["slots"] = {
    sourceControl: { requires: "scm.change-request.manage" },
  };
  configuration["modules"] = [
    {
      instanceId: "github",
      moduleId: "jarvis.module.github",
      enabled: true,
      bindings: { sourceControl: "sourceControl" },
      configuration: {
        bootstrapLabelPolicy: "ignore-existing",
        pollIntervalSeconds: 15,
        repositories: ["Gasppacho/jarvis", "Other/repo"],
      },
    },
  ];
  return configuration;
}

async function waitForRequest(fakeGitHub: FakeGitHubApi, path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (fakeGitHub.requests.some((request) => request.path.startsWith(path))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Fake GitHub did not receive ${path}.`);
}

function issueEventRequests(
  fakeGitHub: FakeGitHubApi,
): readonly FakeGitHubApi["requests"][number][] {
  return fakeGitHub.requests.filter((request) => request.path.includes("/issues/events"));
}

async function waitForCredential(fakeGitHub: FakeGitHubApi, credential: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (issueEventRequests(fakeGitHub).some((request) => request.credential === credential)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Fake GitHub did not receive credential ${credential}.`);
}
