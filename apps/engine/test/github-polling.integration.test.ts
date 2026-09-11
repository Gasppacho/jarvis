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
    await new Promise((resolve) => setTimeout(resolve, 100));

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
            `SELECT idempotency_key, resource_ref
             FROM external_mappings
             WHERE project_id = ? AND module_instance_id = ?
             ORDER BY idempotency_key`,
          )
          .all(project.id, "github"),
      ).toEqual([
        { idempotency_key: "1", resource_ref: expect.stringMatching(/^evt_/) },
        { idempotency_key: "2", resource_ref: expect.stringMatching(/^evt_/) },
        { idempotency_key: "3", resource_ref: expect.stringMatching(/^evt_/) },
      ]);
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

  it.each([
    ["ignore-existing", 0],
    ["emit-existing", 1],
  ] as const)(
    "applies the %s bootstrap policy once",
    async (bootstrapLabelPolicy, expectedFacts) => {
      const fakeGitHub = await startFakeGitHubApi();
      servers.push(fakeGitHub);
      const executableRoot = mkdtempSync(join(tmpdir(), "jarvis-bootstrap-gh-"));
      roots.push(executableRoot);
      const executable = join(executableRoot, "gh");
      writeFileSync(executable, "#!/bin/sh\necho ghs_bootstrap_sentinel\n", "utf8");
      chmodSync(executable, 0o755);
      fakeGitHub.appendLabeledIssueEvent({
        owner: "Gasppacho",
        repository: "jarvis",
        issueNumber: 20,
        issueTitle: "Open issue",
        label: "agent:ready",
        actor: "octocat",
        createdAt: "2026-09-11T09:00:00.000Z",
        issueState: "open",
      });
      fakeGitHub.appendLabeledIssueEvent({
        owner: "Gasppacho",
        repository: "jarvis",
        issueNumber: 21,
        issueTitle: "Closed issue",
        label: "agent:ready",
        actor: "octocat",
        createdAt: "2026-09-11T09:01:00.000Z",
        issueState: "closed",
      });

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
      const project = await createProject(engine, false, bootstrapLabelPolicy);
      await bindAndActivate(engine, project.id, project.path);
      await waitForRequest(fakeGitHub, "/repos/Gasppacho/jarvis/issues/events");
      if (expectedFacts > 0) await waitForFactCount(engine, project.id, expectedFacts);
      else await new Promise((resolve) => setTimeout(resolve, 100));

      const database = new Database(`${engine.dataRoot}/jarvis.sqlite`);
      try {
        expect(
          database
            .prepare(
              `SELECT COUNT(*) AS count
               FROM events WHERE project_id = ? AND type = 'scm.work-item.tag-added'`,
            )
            .get(project.id),
        ).toEqual({ count: expectedFacts });
        expect(
          database
            .prepare(
              `SELECT external_event_id, event_timestamp
               FROM github_cursors
               WHERE project_id = ? AND module_instance_id = ? AND repository_id = ?`,
            )
            .get(project.id, "github", "main"),
        ).toEqual({
          external_event_id: "2",
          event_timestamp: "2026-09-11T09:01:00.000Z",
        });
      } finally {
        database.close();
      }
    },
  );

  it.each(["after-github-poll-read", "after-github-poll-mapping"] as const)(
    "recovers one label after %s without a duplicate or partial cursor",
    async (armedFailpoint) => {
      const fakeGitHub = await startFakeGitHubApi();
      servers.push(fakeGitHub);
      const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-polling-crash-"));
      roots.push(dataRoot);
      const executableRoot = mkdtempSync(join(tmpdir(), "jarvis-polling-crash-gh-"));
      roots.push(executableRoot);
      const executable = join(executableRoot, "gh");
      writeFileSync(executable, "#!/bin/sh\necho ghs_polling_crash_sentinel\n", "utf8");
      chmodSync(executable, 0o755);
      const baseEnv = {
        JARVIS_ENABLE_TEST_HOOKS: "1",
        JARVIS_GH_EXECUTABLE: executable,
        JARVIS_GITHUB_API_BASE_URL: fakeGitHub.baseUrl,
        JARVIS_GITHUB_POLL_INTERVAL_MS: "25",
      };

      const initial = await startEngine({ dataRoot, enginePath: TEST_BUNDLE, env: baseEnv });
      engines.push(initial);
      await registerConnection(initial);
      const project = await createProject(initial);
      await bindAndActivate(initial, project.id, project.path);
      await waitForRequest(fakeGitHub, "/repos/Gasppacho/jarvis/issues/events");
      await waitForCursor(dataRoot, "bootstrap-empty");

      const drafted = await initial.call(`/v1/projects/${project.id}/configuration`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          portableConfig: projectConfig(),
          writeToRepository: false,
        }),
      });
      expect(drafted.status, await drafted.clone().text()).toBe(200);
      await initial.dispose();

      const event = fakeGitHub.appendLabeledIssueEvent({
        owner: "Gasppacho",
        repository: "jarvis",
        issueNumber: 15,
        issueTitle: "Crash recovery",
        label: "agent:ready",
        actor: "octocat",
        createdAt: "2026-09-11T10:01:00.000Z",
      });

      const crashing = await startEngine({
        dataRoot,
        enginePath: TEST_BUNDLE,
        env: { ...baseEnv, JARVIS_FAILPOINT: armedFailpoint },
      });
      engines.push(crashing);
      await bindAndActivate(crashing, project.id, project.path);
      const exitCode = await crashing.waitForExit();
      expect(exitCode).not.toBe(0);
      await crashing.dispose();

      const beforeRestart = new Database(`${dataRoot}/jarvis.sqlite`);
      try {
        expect(
          beforeRestart
            .prepare(
              `SELECT external_event_id, event_timestamp
               FROM github_cursors
               WHERE project_id = ? AND module_instance_id = ? AND repository_id = ?`,
            )
            .get(project.id, "github", "main"),
        ).toEqual({
          external_event_id: "bootstrap-empty",
          event_timestamp: "1970-01-01T00:00:00.000Z",
        });
        expect(
          beforeRestart
            .prepare("SELECT COUNT(*) AS count FROM external_mappings WHERE project_id = ?")
            .get(project.id),
        ).toEqual({ count: 0 });
        expect(
          beforeRestart
            .prepare("SELECT COUNT(*) AS count FROM outbox WHERE project_id = ?")
            .get(project.id),
        ).toEqual({ count: 0 });
      } finally {
        beforeRestart.close();
      }

      const restarted = await startEngine({ dataRoot, enginePath: TEST_BUNDLE, env: baseEnv });
      engines.push(restarted);
      await waitForFactCount(restarted, project.id, 1);

      const afterRestart = new Database(`${dataRoot}/jarvis.sqlite`);
      try {
        expect(
          afterRestart
            .prepare(
              `SELECT COUNT(*) AS count
               FROM events WHERE project_id = ? AND type = 'scm.work-item.tag-added'`,
            )
            .get(project.id),
        ).toEqual({ count: 1 });
        expect(
          afterRestart
            .prepare(
              `SELECT idempotency_key, resource_ref
               FROM external_mappings
               WHERE project_id = ? AND module_instance_id = ?`,
            )
            .get(project.id, "github"),
        ).toEqual({
          idempotency_key: String(event.id),
          resource_ref: expect.stringMatching(/^evt_/),
        });
        expect(
          afterRestart
            .prepare(
              `SELECT external_event_id, event_timestamp
               FROM github_cursors
               WHERE project_id = ? AND module_instance_id = ? AND repository_id = ?`,
            )
            .get(project.id, "github", "main"),
        ).toEqual({
          external_event_id: String(event.id),
          event_timestamp: event.created_at,
        });
      } finally {
        afterRestart.close();
      }
    },
  );

  it.each([
    ["server-error", { status: 500, body: { message: "opaque provider failure" } }, "unavailable"],
    ["rate-limit", { status: 429, body: { message: "rate limit" } }, "rate-limited"],
    [
      "credential-refused",
      { status: 401, body: { message: "ghs_polling_failure_secret" } },
      "credential-refused",
    ],
    ["malformed", { status: 200, body: { message: "raw provider secret" } }, "unclassified"],
  ] as const)(
    "classifies %s without moving the cursor or leaking provider details",
    async (_caseName, response, reason) => {
      const fakeGitHub = await startFakeGitHubApi();
      servers.push(fakeGitHub);
      const executableRoot = mkdtempSync(join(tmpdir(), "jarvis-polling-failure-gh-"));
      roots.push(executableRoot);
      const executable = join(executableRoot, "gh");
      writeFileSync(executable, "#!/bin/sh\necho ghs_polling_failure_credential\n", "utf8");
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
      await waitForCursor(engine.dataRoot, "bootstrap-empty");

      const event = fakeGitHub.appendLabeledIssueEvent({
        owner: "Gasppacho",
        repository: "jarvis",
        issueNumber: 15,
        issueTitle: "Polling failure",
        label: "agent:ready",
        actor: "octocat",
        createdAt: "2026-09-11T10:01:00.000Z",
      });
      const scriptedPath = "/repos/Gasppacho/jarvis/issues/events?per_page=100&page=1";
      const restore = fakeGitHub.scriptRoute("GET", scriptedPath, response);
      try {
        await engine.waitForStderr(
          `jarvis-engine: GitHub polling failed project=${project.id} moduleInstance=github repository=Gasppacho/jarvis reason=${reason}`,
        );
        expect(
          issueEventRequests(fakeGitHub).filter((request) => request.path === scriptedPath),
        ).toHaveLength(1);
        expect(engine.stderr()).not.toContain("ghs_polling_failure_secret");
        expect(engine.stderr()).not.toContain("raw provider secret");

        const health = await engine.call("/v1/health");
        expect(health.status).toBe(200);
        expect(await health.json()).toMatchObject({ status: "ready" });

        const database = new Database(`${engine.dataRoot}/jarvis.sqlite`);
        try {
          expect(
            database
              .prepare(
                `SELECT external_event_id, event_timestamp
                 FROM github_cursors
                 WHERE project_id = ? AND module_instance_id = ? AND repository_id = ?`,
              )
              .get(project.id, "github", "main"),
          ).toEqual({
            external_event_id: "bootstrap-empty",
            event_timestamp: "1970-01-01T00:00:00.000Z",
          });
          expect(
            database
              .prepare("SELECT COUNT(*) AS count FROM external_mappings WHERE project_id = ?")
              .get(project.id),
          ).toEqual({ count: 0 });
          expect(
            database
              .prepare("SELECT COUNT(*) AS count FROM events WHERE project_id = ?")
              .get(project.id),
          ).toEqual({ count: 0 });
        } finally {
          database.close();
        }
      } finally {
        restore();
      }

      await waitForFactCount(engine, project.id, 1);
      const database = new Database(`${engine.dataRoot}/jarvis.sqlite`);
      try {
        expect(
          database
            .prepare(
              `SELECT COUNT(*) AS count
               FROM events WHERE project_id = ? AND type = 'scm.work-item.tag-added'`,
            )
            .get(project.id),
        ).toEqual({ count: 1 });
        expect(
          database
            .prepare(
              `SELECT external_event_id, event_timestamp
               FROM github_cursors
               WHERE project_id = ? AND module_instance_id = ? AND repository_id = ?`,
            )
            .get(project.id, "github", "main"),
        ).toEqual({
          external_event_id: String(event.id),
          event_timestamp: event.created_at,
        });
      } finally {
        database.close();
      }
    },
  );

  it("keeps one cursor and one portable repository ID per configured remote", async () => {
    const fakeGitHub = await startFakeGitHubApi();
    servers.push(fakeGitHub);
    const executableRoot = mkdtempSync(join(tmpdir(), "jarvis-polling-multi-gh-"));
    roots.push(executableRoot);
    const executable = join(executableRoot, "gh");
    writeFileSync(executable, "#!/bin/sh\necho ghs_polling_multi_sentinel\n", "utf8");
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
    const project = await createProject(
      engine,
      false,
      "ignore-existing",
      multiRepositoryConfig(["Gasppacho/jarvis", "Other/repo", "Unowned/repo"]),
    );
    await bindAndActivate(engine, project.id, project.path);
    await waitForRequest(fakeGitHub, "/repos/Gasppacho/jarvis/issues/events");
    await waitForRequest(fakeGitHub, "/repos/Other/repo/issues/events");
    await waitForCursor(engine.dataRoot, "bootstrap-empty", project.id, "main");
    await waitForCursor(engine.dataRoot, "bootstrap-empty", project.id, "secondary");

    fakeGitHub.appendLabeledIssueEvent({
      owner: "Gasppacho",
      repository: "jarvis",
      issueNumber: 15,
      issueTitle: "Main repository",
      label: "main-label",
      actor: "octocat",
      createdAt: "2026-09-11T10:01:00.000Z",
    });
    fakeGitHub.appendLabeledIssueEvent({
      owner: "Other",
      repository: "repo",
      issueNumber: 16,
      issueTitle: "Secondary repository",
      label: "secondary-label",
      actor: "octocat",
      createdAt: "2026-09-11T10:02:00.000Z",
    });
    fakeGitHub.appendLabeledIssueEvent({
      owner: "Unowned",
      repository: "repo",
      issueNumber: 17,
      issueTitle: "Undeclared repository",
      label: "unowned-label",
      actor: "octocat",
      createdAt: "2026-09-11T10:03:00.000Z",
    });

    await waitForFactCount(engine, project.id, 2);
    const database = new Database(`${engine.dataRoot}/jarvis.sqlite`);
    try {
      const rows = database
        .prepare(
          `SELECT envelope
           FROM events
           WHERE project_id = ? AND type = 'scm.work-item.tag-added'
           ORDER BY rowid`,
        )
        .all(project.id) as { readonly envelope: string }[];
      const envelopes = rows.map((row) => JSON.parse(row.envelope) as Record<string, unknown>);
      expect(
        envelopes
          .map((event) => ({
            repositoryId: event["repositoryId"],
            tag: (event["payload"] as Record<string, unknown>)["tag"],
          }))
          .sort((left, right) =>
            String(left.repositoryId).localeCompare(String(right.repositoryId)),
          ),
      ).toEqual([
        { repositoryId: "main", tag: "main-label" },
        { repositoryId: "secondary", tag: "secondary-label" },
      ]);
      expect(
        database
          .prepare(
            `SELECT repository_id, external_event_id
             FROM github_cursors
             WHERE project_id = ? ORDER BY repository_id`,
          )
          .all(project.id),
      ).toEqual([
        { repository_id: "main", external_event_id: "1" },
        { repository_id: "secondary", external_event_id: "2" },
      ]);
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM events WHERE project_id = ? AND type = 'scm.work-item.tag-added'`,
          )
          .get(project.id),
      ).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it("bootstraps a repository added later without disturbing its existing cursor", async () => {
    const fakeGitHub = await startFakeGitHubApi();
    servers.push(fakeGitHub);
    const executableRoot = mkdtempSync(join(tmpdir(), "jarvis-polling-added-gh-"));
    roots.push(executableRoot);
    const executable = join(executableRoot, "gh");
    writeFileSync(executable, "#!/bin/sh\necho ghs_polling_added_sentinel\n", "utf8");
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
    const project = await createProject(
      engine,
      false,
      "ignore-existing",
      multiRepositoryConfig(["Gasppacho/jarvis"]),
    );
    await bindAndActivate(engine, project.id, project.path);
    await waitForRequest(fakeGitHub, "/repos/Gasppacho/jarvis/issues/events");
    await waitForCursor(engine.dataRoot, "bootstrap-empty", project.id, "main");

    fakeGitHub.appendLabeledIssueEvent({
      owner: "Other",
      repository: "repo",
      issueNumber: 20,
      issueTitle: "Existing secondary issue",
      label: "existing-secondary",
      actor: "octocat",
      createdAt: "2026-09-11T10:06:00.000Z",
    });
    const addedConfig = multiRepositoryConfig(["Gasppacho/jarvis", "Other/repo"]);
    const drafted = await engine.call(`/v1/projects/${project.id}/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ portableConfig: addedConfig, writeToRepository: false }),
    });
    expect(drafted.status, await drafted.clone().text()).toBe(200);
    await bindAndActivate(engine, project.id, project.path);
    await waitForCursor(engine.dataRoot, "1", project.id, "secondary");

    const beforeNewLabel = await engine.call(`/v1/projects/${project.id}/events`);
    expect(((await beforeNewLabel.json()) as { readonly items: readonly unknown[] }).items).toEqual(
      [],
    );
    await waitForCursor(engine.dataRoot, "bootstrap-empty", project.id, "main");

    const newEvent = fakeGitHub.appendLabeledIssueEvent({
      owner: "Other",
      repository: "repo",
      issueNumber: 20,
      issueTitle: "Existing secondary issue",
      label: "new-secondary",
      actor: "octocat",
      createdAt: "2026-09-11T10:07:00.000Z",
    });
    await waitForFactCount(engine, project.id, 1);
    const database = new Database(`${engine.dataRoot}/jarvis.sqlite`);
    try {
      expect(
        database
          .prepare(
            `SELECT repository_id, external_event_id, event_timestamp
             FROM github_cursors
             WHERE project_id = ? AND repository_id = 'secondary'`,
          )
          .get(project.id),
      ).toEqual({
        repository_id: "secondary",
        external_event_id: String(newEvent.id),
        event_timestamp: newEvent.created_at,
      });
    } finally {
      database.close();
    }
  });

  it("keeps two Projects' GitHub timelines and credentials isolated", async () => {
    const fakeGitHub = await startFakeGitHubApi();
    servers.push(fakeGitHub);
    const executableRoot = mkdtempSync(join(tmpdir(), "jarvis-polling-isolation-gh-"));
    roots.push(executableRoot);
    const executable = join(executableRoot, "gh");
    writeFileSync(
      executable,
      `#!/bin/sh
case "$*" in
  *"--user ProjectA"*) echo token_project_a;;
  *"--user ProjectB"*) echo token_project_b;;
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
    await registerConnection(engine, "ProjectA", "connection/github-a");
    await registerConnection(engine, "ProjectB", "connection/github-b");
    const projectA = await createProject(
      engine,
      false,
      "ignore-existing",
      projectConfig(false, "ignore-existing", "project-a", ["Gasppacho/jarvis"]),
    );
    const projectB = await createProject(
      engine,
      false,
      "ignore-existing",
      projectConfig(false, "ignore-existing", "project-b", ["Other/repo"]),
    );
    await bindAndActivate(engine, projectA.id, projectA.path, "connection/github-a");
    await bindAndActivate(engine, projectB.id, projectB.path, "connection/github-b");
    await waitForRequest(fakeGitHub, "/repos/Gasppacho/jarvis/issues/events");
    await waitForRequest(fakeGitHub, "/repos/Other/repo/issues/events");
    await waitForCursor(engine.dataRoot, "bootstrap-empty", projectA.id);
    await waitForCursor(engine.dataRoot, "bootstrap-empty", projectB.id);

    fakeGitHub.appendLabeledIssueEvent({
      owner: "Gasppacho",
      repository: "jarvis",
      issueNumber: 18,
      issueTitle: "Project A issue",
      label: "project-a-label",
      actor: "octocat",
      createdAt: "2026-09-11T10:04:00.000Z",
    });
    fakeGitHub.appendLabeledIssueEvent({
      owner: "Other",
      repository: "repo",
      issueNumber: 19,
      issueTitle: "Project B issue",
      label: "project-b-label",
      actor: "octocat",
      createdAt: "2026-09-11T10:05:00.000Z",
    });

    await waitForFactCount(engine, projectA.id, 1);
    await waitForFactCount(engine, projectB.id, 1);
    const requestsA = issueEventRequests(fakeGitHub).filter((request) =>
      request.path.includes("/repos/Gasppacho/jarvis/issues/events"),
    );
    const requestsB = issueEventRequests(fakeGitHub).filter((request) =>
      request.path.includes("/repos/Other/repo/issues/events"),
    );
    expect(new Set(requestsA.map((request) => request.credential))).toEqual(
      new Set(["token_project_a"]),
    );
    expect(new Set(requestsB.map((request) => request.credential))).toEqual(
      new Set(["token_project_b"]),
    );

    const database = new Database(`${engine.dataRoot}/jarvis.sqlite`);
    try {
      expect(
        database
          .prepare(
            `SELECT project_id, COUNT(*) AS count
             FROM events
             WHERE type = 'scm.work-item.tag-added'
             GROUP BY project_id ORDER BY project_id`,
          )
          .all(),
      ).toEqual([
        { project_id: "project-a", count: 1 },
        { project_id: "project-b", count: 1 },
      ]);
    } finally {
      database.close();
    }
  });
});

async function registerConnection(
  engine: Harness,
  account = "PollingAccount",
  connectionId = "connection/github-polling",
): Promise<void> {
  const created = await engine.call("/v1/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: connectionId,
      kind: "github",
      displayName: account,
      secretRef: `gh://${account}`,
    }),
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const validated = await engine.call(
    `/v1/connections/${encodeURIComponent(connectionId)}/validate`,
    {
      method: "POST",
    },
  );
  expect(validated.status, await validated.clone().text()).toBe(200);
}

async function createProject(
  engine: Harness,
  withSubscriber = false,
  bootstrapLabelPolicy: "ignore-existing" | "emit-existing" = "ignore-existing",
  configuration = projectConfig(withSubscriber, bootstrapLabelPolicy),
): Promise<{ readonly id: string; readonly path: string }> {
  const projectPath = makeNodeRepositoryFixture({
    projectYaml: stringifyYaml(configuration),
  });
  roots.push(projectPath);
  const response = await engine.call("/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositoryPath: projectPath }),
  });
  const body = (await response.json()) as { readonly id?: string };
  const metadata = configuration["metadata"] as { readonly id: string };
  expect(response.status, JSON.stringify(body)).toBe(201);
  expect(body.id).toBe(metadata.id);
  return { id: body.id!, path: projectPath };
}

async function bindAndActivate(
  engine: Harness,
  projectId: string,
  repositoryPath: string,
  connectionRef = "connection/github-polling",
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
        sourceControl: { kind: "connection", ref: connectionRef },
        tickets: { kind: "connection", ref: connectionRef },
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

function projectConfig(
  withSubscriber = false,
  bootstrapLabelPolicy: "ignore-existing" | "emit-existing" = "ignore-existing",
  projectId = "polling-project",
  githubRepositories: readonly string[] = ["Gasppacho/jarvis", "Other/repo"],
): Record<string, unknown> {
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
  configuration["metadata"] = { id: projectId, name: `Polling Project ${projectId}` };
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
        bootstrapLabelPolicy,
        pollIntervalSeconds: 15,
        repositories: [...githubRepositories],
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

function multiRepositoryConfig(githubRepositories: readonly string[]): Record<string, unknown> {
  const configuration = projectConfig(
    false,
    "ignore-existing",
    "polling-project",
    githubRepositories,
  );
  configuration["repositories"] = [
    { id: "main", root: ".", defaultBranch: "main", remote: "origin" },
    { id: "secondary", root: ".", defaultBranch: "main", remote: "upstream" },
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

async function waitForCursor(
  dataRoot: string,
  externalEventId: string,
  projectId = "polling-project",
  repositoryId = "main",
): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const database = new Database(`${dataRoot}/jarvis.sqlite`);
    try {
      const row = database
        .prepare(
          `SELECT external_event_id
           FROM github_cursors
           WHERE project_id = ? AND module_instance_id = 'github' AND repository_id = ?`,
        )
        .get(projectId, repositoryId) as { readonly external_event_id?: string } | undefined;
      if (row?.external_event_id === externalEventId) return;
    } finally {
      database.close();
    }
    if (Date.now() >= deadline) throw new Error(`cursor did not reach ${externalEventId}`);
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
