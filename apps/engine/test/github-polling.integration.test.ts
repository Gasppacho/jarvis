import Database from "better-sqlite3";
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
    await bindAndActivate(engine, project.id, project.path);
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

  it("publishes ordered label facts, advances the cursor, and delivers them in-project", async () => {
    const fakeGitHub = await startFakeGitHubApi();
    servers.push(fakeGitHub);
    const executableRoot = mkdtempSync(join(tmpdir(), "jarvis-publishing-gh-"));
    roots.push(executableRoot);
    const executable = join(executableRoot, "gh");
    writeFileSync(executable, "#!/bin/sh\necho ghs_publishing_sentinel\n", "utf8");
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
    const project = await createProject(engine, true);
    await bindAndActivate(engine, project.id, project.path);
    await waitForRequest(fakeGitHub, "/repos/Gasppacho/jarvis/issues/events");

    const seeded = [
      ["first", "2026-09-11T09:00:00.000Z"],
      ["second", "2026-09-11T09:01:00.000Z"],
      ["third", "2026-09-11T09:02:00.000Z"],
    ] as const;
    for (const [tag, createdAt] of seeded) {
      fakeGitHub.appendLabeledIssueEvent({
        owner: "Gasppacho",
        repository: "jarvis",
        issueNumber: 15,
        issueTitle: `Poll ${tag}`,
        label: tag,
        actor: "octocat",
        createdAt,
      });
    }

    await waitForFactCount(engine, project.id, 3);

    const database = new Database(`${engine.dataRoot}/jarvis.sqlite`);
    try {
      const rows = database
        .prepare(
          `SELECT envelope FROM events
           WHERE project_id = ? AND type = 'scm.work-item.tag-added'
           ORDER BY rowid ASC`,
        )
        .all(project.id) as { readonly envelope: string }[];
      const envelopes = rows.map((row) => JSON.parse(row.envelope) as Record<string, unknown>);
      expect(
        envelopes.map((event) => (event["payload"] as Record<string, unknown>)["tag"]),
      ).toEqual(["first", "second", "third"]);
      expect(envelopes[0]).toMatchObject({
        projectId: project.id,
        repositoryId: "main",
        producer: { moduleId: "jarvis.module.github", moduleInstanceId: "github" },
        subject: {
          type: "work-item",
          ref: "github://Gasppacho/jarvis/issues/15",
        },
        causationId: null,
        payload: {
          workItemRef: "github://Gasppacho/jarvis/issues/15",
          tag: "first",
          title: "Poll first",
          actorRef: "github://users/octocat",
        },
      });
      expect(new Set(envelopes.map((event) => event["correlationId"])).size).toBe(3);
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM outbox WHERE project_id = ?")
          .get(project.id),
      ).toEqual({ count: 3 });
      expect(
        database
          .prepare(
            `SELECT external_event_id, event_timestamp
             FROM github_cursors
             WHERE project_id = ? AND module_instance_id = ? AND repository_id = ?`,
          )
          .get(project.id, "github", "main"),
      ).toEqual({
        external_event_id: "3",
        event_timestamp: "2026-09-11T09:02:00.000Z",
      });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM deliveries d JOIN events e ON e.id = d.event_id
             WHERE d.project_id = ? AND e.type = 'scm.work-item.tag-added'`,
          )
          .get(project.id),
      ).toEqual({ count: 3 });
    } finally {
      database.close();
    }
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

async function createProject(
  engine: Harness,
  withSubscriber = false,
): Promise<{ readonly id: string; readonly path: string }> {
  const projectPath = makeNodeRepositoryFixture({
    projectYaml: stringifyYaml(projectConfig(withSubscriber)),
  });
  roots.push(projectPath);
  const response = await engine.call("/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositoryPath: projectPath }),
  });
  const body = (await response.json()) as { readonly id?: string };
  expect(response.status, JSON.stringify(body)).toBe(201);
  expect(body.id).toBe("polling-project");
  return { id: body.id!, path: projectPath };
}

async function bindAndActivate(
  engine: Harness,
  projectId: string,
  repositoryPath: string,
): Promise<void> {
  const repositoryBinding = await engine.call(
    `/v1/projects/${projectId}/repositories/main/binding`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: repositoryPath,
        bookmarkRef: `bookmark/${projectId}/main`,
      }),
    },
  );
  expect(repositoryBinding.status, await repositoryBinding.clone().text()).toBe(200);
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
        tickets: { kind: "connection", ref: "connection/github-polling" },
        agentRuntime: { kind: "runtime", ref: "runtime/fake-test" },
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

function projectConfig(withSubscriber = false): Record<string, unknown> {
  const configuration = parseYaml(
    readFileSync(join(ROOT, "examples/project/.jarvis/project.yaml"), "utf8"),
  ) as Record<string, unknown>;
  const exampleModules = configuration["modules"];
  const developmentModule = Array.isArray(exampleModules)
    ? exampleModules.find(
        (module): module is Record<string, unknown> =>
          typeof module === "object" &&
          module !== null &&
          (module as Record<string, unknown>)["instanceId"] === "development",
      )
    : undefined;
  configuration["metadata"] = { id: "polling-project", name: "Polling Project" };
  configuration["slots"] = {
    sourceControl: { requires: "scm.change-request.manage" },
    tickets: { requires: "work-items.read" },
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
        pollIntervalSeconds: 15,
        repositories: ["Gasppacho/jarvis", "Other/repo"],
      },
    },
    ...(withSubscriber
      ? [
          {
            instanceId: "automation-rules",
            moduleId: "jarvis.module.automation-rules",
            enabled: true,
            configuration: {
              rules: [
                {
                  id: "never-match",
                  when: {
                    eventType: "scm.work-item.tag-added",
                    equals: { "payload.tag": "never-match" },
                  },
                  emit: {
                    type: "development.implementation.requested",
                    target: { moduleInstanceId: "development" },
                  },
                },
              ],
            },
          },
          ...(developmentModule === undefined ? [] : [developmentModule]),
        ]
      : []),
  ];
  return configuration;
}

async function waitForFactCount(
  engine: Harness,
  projectId: string,
  count: number,
): Promise<
  readonly {
    readonly type: string;
    readonly correlationId: string;
  }[]
> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const response = await engine.call(`/v1/projects/${projectId}/events`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly items: readonly {
        readonly type: string;
        readonly correlationId: string;
      }[];
    };
    const facts = body.items.filter((event) => event.type === "scm.work-item.tag-added");
    if (facts.length >= count) return facts;
    if (Date.now() >= deadline) {
      throw new Error(`project ${projectId} did not reach ${count} facts\n${engine.stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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
