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

  it("refuses activation for an unknown repository ID without polling a guessed provider", async () => {
    const fakeGitHub = await startFakeGitHubApi();
    servers.push(fakeGitHub);
    const executableRoot = mkdtempSync(join(tmpdir(), "jarvis-polling-invalid-gh-"));
    roots.push(executableRoot);
    const executable = join(executableRoot, "gh");
    writeFileSync(executable, "#!/bin/sh\necho ghs_invalid_sentinel\n", "utf8");
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
      projectConfig(false, "ignore-existing", "polling-invalid-id", ["missing"]),
    );

    const report = await bindProject(engine, project.id, project.path);
    expect(report.valid).toBe(false);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          message: expect.stringContaining("Use a repository ID declared by the Project"),
        }),
      ]),
    );
    const activation = await engine.call(`/v1/projects/${project.id}/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ compositionFingerprint: report.compositionFingerprint }),
    });
    expect(activation.status).toBe(409);
    expect(await activation.json()).toMatchObject({
      error: { code: "project.activation-not-validated" },
    });
    expect(issueEventRequests(fakeGitHub)).toEqual([]);
  });

  it("refuses activation when a declared repository remote is absent", async () => {
    const fakeGitHub = await startFakeGitHubApi();
    servers.push(fakeGitHub);
    const executableRoot = mkdtempSync(join(tmpdir(), "jarvis-polling-missing-remote-gh-"));
    roots.push(executableRoot);
    const executable = join(executableRoot, "gh");
    writeFileSync(executable, "#!/bin/sh\necho ghs_missing_remote_sentinel\n", "utf8");
    chmodSync(executable, 0o755);

    const configuration = projectConfig(false, "ignore-existing", "polling-missing-remote", [
      "main",
    ]);
    const repositories = configuration["repositories"] as Record<string, unknown>[];
    const main = repositories.find((repository) => repository["id"] === "main");
    if (main === undefined) throw new Error("main repository declaration is missing");
    main["remote"] = "missing";

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
    const project = await createProject(engine, false, "ignore-existing", configuration);
    const report = await bindProject(engine, project.id, project.path);
    expect(report.valid).toBe(false);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          message: expect.stringContaining("Configure the declared remote"),
        }),
      ]),
    );
    const activation = await engine.call(`/v1/projects/${project.id}/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ compositionFingerprint: report.compositionFingerprint }),
    });
    expect(activation.status).toBe(409);
    expect(await activation.json()).toMatchObject({
      error: { code: "project.activation-not-validated" },
    });
    expect(issueEventRequests(fakeGitHub)).toEqual([]);
  });

  it("refuses activation when the selected remote uses an unsupported provider", async () => {
    const fakeGitHub = await startFakeGitHubApi();
    servers.push(fakeGitHub);
    const executableRoot = mkdtempSync(join(tmpdir(), "jarvis-polling-unsupported-gh-"));
    roots.push(executableRoot);
    const executable = join(executableRoot, "gh");
    writeFileSync(executable, "#!/bin/sh\necho ghs_unsupported_provider_sentinel\n", "utf8");
    chmodSync(executable, 0o755);

    const configuration = projectConfig(false, "ignore-existing", "polling-unsupported-provider", [
      "main",
    ]);
    const repositories = configuration["repositories"] as Record<string, unknown>[];
    const main = repositories.find((repository) => repository["id"] === "main");
    if (main === undefined) throw new Error("main repository declaration is missing");
    main["remote"] = "gitlab";

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
    const project = await createProject(engine, false, "ignore-existing", configuration, [
      { name: "gitlab", url: "git@gitlab.com:Other/repo.git" },
    ]);
    const report = await bindProject(engine, project.id, project.path);
    expect(report.valid).toBe(false);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          message: expect.stringContaining("Select a supported GitHub remote"),
        }),
      ]),
    );
    const activation = await engine.call(`/v1/projects/${project.id}/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ compositionFingerprint: report.compositionFingerprint }),
    });
    expect(activation.status).toBe(409);
    expect(await activation.json()).toMatchObject({
      error: { code: "project.activation-not-validated" },
    });
    expect(issueEventRequests(fakeGitHub)).toEqual([]);
  });

  it("makes a pre-#188 active snapshot explicitly refreshable", async () => {
    const fakeGitHub = await startFakeGitHubApi();
    servers.push(fakeGitHub);
    const executableRoot = mkdtempSync(join(tmpdir(), "jarvis-polling-migration-gh-"));
    const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-polling-migration-data-"));
    roots.push(executableRoot, dataRoot);
    const executable = join(executableRoot, "gh");
    writeFileSync(executable, "#!/bin/sh\necho ghs_migration_sentinel\n", "utf8");
    chmodSync(executable, 0o755);

    const engineOptions = {
      enginePath: TEST_BUNDLE,
      dataRoot,
      env: {
        JARVIS_ENABLE_TEST_HOOKS: "1",
        JARVIS_GH_EXECUTABLE: executable,
        JARVIS_GITHUB_API_BASE_URL: fakeGitHub.baseUrl,
        JARVIS_GITHUB_POLL_INTERVAL_MS: "60000",
      },
    } as const;
    const engine = await startEngine(engineOptions);
    engines.push(engine);
    await registerConnection(engine);
    const project = await createProject(
      engine,
      false,
      "ignore-existing",
      projectConfig(false, "ignore-existing", "polling-migration", ["main"]),
    );
    const report = await bindProject(engine, project.id, project.path);
    expect(report.valid).toBe(true);
    const fingerprint = report.compositionFingerprint;
    if (fingerprint === undefined) throw new Error("validation fingerprint is missing");
    const activated = await engine.call(`/v1/projects/${project.id}/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ compositionFingerprint: fingerprint }),
    });
    expect(activated.status, await activated.clone().text()).toBe(200);

    await engine.dispose();
    engines.splice(engines.indexOf(engine), 1);
    const database = new Database(join(dataRoot, "jarvis.sqlite"));
    const row = database
      .prepare("SELECT resolved_project FROM project_resolved_compositions WHERE project_id = ?")
      .get(project.id) as { resolved_project: string };
    const oldSnapshot = JSON.parse(row.resolved_project) as Record<string, unknown>;
    delete oldSnapshot["repositoryIdentities"];
    database
      .prepare("UPDATE project_resolved_compositions SET resolved_project = ? WHERE project_id = ?")
      .run(JSON.stringify(oldSnapshot), project.id);
    database.close();

    const restarted = await startEngine(engineOptions);
    engines.push(restarted);
    expect(issueEventRequests(fakeGitHub)).toEqual([]);
    const migrationResponse = await restarted.call(`/v1/projects/${project.id}/validation-report`, {
      method: "POST",
    });
    const migrationReport = (await migrationResponse.json()) as {
      readonly valid: boolean;
      readonly compositionFingerprint?: string;
      readonly findings: readonly { readonly code: string; readonly severity: string }[];
    };
    expect(migrationReport.valid).toBe(true);
    expect(migrationReport.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "project.instance-config-invalid",
          severity: "warning",
        }),
      ]),
    );

    const refreshed = await restarted.call(`/v1/projects/${project.id}/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ compositionFingerprint: migrationReport.compositionFingerprint }),
    });
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    await restarted.dispose();
    engines.splice(engines.indexOf(restarted), 1);
    const refreshedDatabase = new Database(join(dataRoot, "jarvis.sqlite"));
    const refreshedRow = refreshedDatabase
      .prepare("SELECT resolved_project FROM project_resolved_compositions WHERE project_id = ?")
      .get(project.id) as { resolved_project: string };
    const refreshedSnapshot = JSON.parse(refreshedRow.resolved_project) as {
      readonly repositoryIdentities: readonly Record<string, string>[];
    };
    expect(refreshedSnapshot.repositoryIdentities).toContainEqual({
      repositoryId: "main",
      provider: "github",
      owner: "Gasppacho",
      name: "jarvis",
    });
    refreshedDatabase.close();
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
      multiRepositoryConfig(["secondary", "main"]),
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
      multiRepositoryConfig(["main"]),
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
    const addedConfig = multiRepositoryConfig(["main", "secondary"]);
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
      projectConfig(false, "ignore-existing", "project-a", ["main"]),
    );
    const projectB = await createProject(
      engine,
      false,
      "ignore-existing",
      projectConfig(false, "ignore-existing", "project-b", ["secondary"]),
    );
    await bindAndActivate(engine, projectA.id, projectA.path, "connection/github-a");
    await bindAndActivate(engine, projectB.id, projectB.path, "connection/github-b");
    await waitForRequest(fakeGitHub, "/repos/Gasppacho/jarvis/issues/events");
    await waitForRequest(fakeGitHub, "/repos/Other/repo/issues/events");
    await waitForCursor(engine.dataRoot, "bootstrap-empty", projectA.id);
    await waitForCursor(engine.dataRoot, "bootstrap-empty", projectB.id, "secondary");

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

  it("proves the GitHub label slice through one fact, one request, and one execution", async () => {
    const fakeGitHub = await startFakeGitHubApi();
    servers.push(fakeGitHub);
    const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-polling-e2e-"));
    roots.push(dataRoot);
    const executableRoot = mkdtempSync(join(tmpdir(), "jarvis-polling-e2e-gh-"));
    roots.push(executableRoot);
    const executable = join(executableRoot, "gh");
    writeFileSync(executable, "#!/bin/sh\necho ghs_polling_e2e_credential\n", "utf8");
    chmodSync(executable, 0o755);
    const environment = {
      JARVIS_ENABLE_TEST_HOOKS: "1",
      JARVIS_GH_EXECUTABLE: executable,
      JARVIS_GITHUB_API_BASE_URL: fakeGitHub.baseUrl,
      JARVIS_GITHUB_POLL_INTERVAL_MS: "25",
    };

    const engine = await startEngine({ dataRoot, enginePath: TEST_BUNDLE, env: environment });
    engines.push(engine);
    await registerConnection(engine);
    const project = await createProject(engine, false, "ignore-existing", endToEndConfig());
    await bindAndActivate(engine, project.id, project.path);
    await waitForRequest(fakeGitHub, "/repos/Gasppacho/jarvis/issues/events");
    await waitForCursor(dataRoot, "bootstrap-empty", project.id);

    const first = fakeGitHub.appendLabeledIssueEvent({
      owner: "Gasppacho",
      repository: "jarvis",
      issueNumber: 21,
      issueTitle: "End to end label",
      label: "agent:ready",
      actor: "octocat",
      createdAt: "2026-09-11T10:08:00.000Z",
    });
    await waitForFactCount(engine, project.id, 1);
    await waitForEventTypeCount(engine, project.id, "development.implementation.requested", 1);
    await waitForExecutionCount(engine, project.id, 1);

    const firstDatabase = new Database(`${dataRoot}/jarvis.sqlite`);
    try {
      const rows = firstDatabase
        .prepare(
          `SELECT id, type, kind, envelope
           FROM events WHERE project_id = ? ORDER BY rowid`,
        )
        .all(project.id) as {
        readonly id: string;
        readonly type: string;
        readonly kind: string;
        readonly envelope: string;
      }[];
      const fact = rows.find((row) => row.type === "scm.work-item.tag-added");
      const request = rows.find((row) => row.type === "development.implementation.requested");
      expect(fact).toBeDefined();
      expect(request).toBeDefined();
      const factEnvelope = JSON.parse(fact?.envelope ?? "{}") as Record<string, unknown>;
      const requestEnvelope = JSON.parse(request?.envelope ?? "{}") as Record<string, unknown>;
      expect(factEnvelope).toMatchObject({
        projectId: project.id,
        repositoryId: "main",
        payload: { tag: "agent:ready" },
      });
      expect(requestEnvelope).toMatchObject({
        projectId: project.id,
        correlationId: factEnvelope["correlationId"],
        causationId: fact?.id,
        target: { moduleInstanceId: "development" },
        payload: {
          workItemRef: `github://Gasppacho/jarvis/issues/${first.issue.number}`,
          repositoryId: "main",
        },
      });
      expect(rows.filter((row) => row.type === "scm.work-item.tag-added")).toHaveLength(1);
      expect(
        rows.filter((row) => row.type === "development.implementation.requested"),
      ).toHaveLength(1);
      expect(
        firstDatabase
          .prepare(
            "SELECT COUNT(*) AS count FROM executions WHERE project_id = ? AND module_instance_id = 'development'",
          )
          .get(project.id),
      ).toEqual({ count: 1 });
    } finally {
      firstDatabase.close();
    }

    expect(engine.stderr()).not.toContain("ghs_polling_e2e_credential");
    const recoveryPath = "/repos/Gasppacho/jarvis/issues/events?per_page=100&page=1";
    const recoveryRequestsBeforeRestart = fakeGitHub.requests.filter(
      (request) => request.path === recoveryPath,
    ).length;
    expect(recoveryRequestsBeforeRestart).toBeGreaterThan(0);
    await engine.dispose();
    const restarted = await startEngine({ dataRoot, enginePath: TEST_BUNDLE, env: environment });
    engines.push(restarted);
    await waitForRequestCount(fakeGitHub, recoveryPath, recoveryRequestsBeforeRestart + 1);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const afterRestartEvents = await waitForEventTypeCount(
      restarted,
      project.id,
      "development.implementation.requested",
      1,
    );
    expect(afterRestartEvents).toHaveLength(1);
    await waitForExecutionCount(restarted, project.id, 1);

    const second = fakeGitHub.appendLabeledIssueEvent({
      owner: "Gasppacho",
      repository: "jarvis",
      issueNumber: 21,
      issueTitle: "End to end label",
      label: "agent:ready",
      actor: "octocat",
      createdAt: "2026-09-11T10:09:00.000Z",
    });
    await waitForFactCount(restarted, project.id, 2);
    await waitForEventTypeCount(restarted, project.id, "development.implementation.requested", 2);
    await waitForExecutionCount(restarted, project.id, 2);
    const finalDatabase = new Database(`${dataRoot}/jarvis.sqlite`);
    try {
      expect(
        finalDatabase
          .prepare(
            `SELECT type, COUNT(*) AS count
             FROM events
             WHERE project_id = ? AND type IN ('scm.work-item.tag-added', 'development.implementation.requested')
             GROUP BY type ORDER BY type`,
          )
          .all(project.id),
      ).toEqual([
        { type: "development.implementation.requested", count: 2 },
        { type: "scm.work-item.tag-added", count: 2 },
      ]);
      expect(
        finalDatabase
          .prepare(
            "SELECT COUNT(*) AS count FROM executions WHERE project_id = ? AND module_instance_id = 'development'",
          )
          .get(project.id),
      ).toEqual({ count: 2 });
      expect(finalDatabase.prepare("SELECT COUNT(*) AS count FROM github_cursors").get()).toEqual({
        count: 1,
      });
      expect(
        finalDatabase.prepare("SELECT COUNT(*) AS count FROM external_mappings").get(),
      ).toEqual({
        count: 2,
      });
    } finally {
      finalDatabase.close();
    }
    const eventsResponse = await restarted.call(`/v1/projects/${project.id}/events`);
    const executionsResponse = await restarted.call(`/v1/projects/${project.id}/executions`);
    expect(JSON.stringify(await eventsResponse.json())).not.toContain("ghs_polling_e2e_credential");
    expect(JSON.stringify(await executionsResponse.json())).not.toContain(
      "ghs_polling_e2e_credential",
    );
    expect(restarted.stderr()).not.toContain("ghs_polling_e2e_credential");
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
  additionalRemotes: readonly { readonly name: string; readonly url: string }[] = [],
): Promise<{ readonly id: string; readonly path: string }> {
  const projectPath = makeNodeRepositoryFixture({
    remoteUrl: "git@github.com:Gasppacho/jarvis.git",
    additionalRemotes: [
      { name: "upstream", url: "git@github.com:Other/repo.git" },
      ...additionalRemotes,
    ],
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
  const report = await bindProject(engine, projectId, repositoryPath, connectionRef);
  expect(report.valid, JSON.stringify(report)).toBe(true);
  const activated = await engine.call(`/v1/projects/${projectId}/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ compositionFingerprint: report.compositionFingerprint }),
  });
  expect(activated.status, await activated.clone().text()).toBe(200);
}

async function bindProject(
  engine: Harness,
  projectId: string,
  repositoryPath: string,
  connectionRef = "connection/github-polling",
): Promise<{
  readonly valid: boolean;
  readonly compositionFingerprint?: string;
  readonly findings?: readonly { readonly severity: string; readonly message: string }[];
}> {
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
    readonly findings?: readonly { readonly severity: string; readonly message: string }[];
  };
  expect(reportResponse.status, JSON.stringify(report)).toBe(200);
  return report;
}

function projectConfig(
  withSubscriber = false,
  bootstrapLabelPolicy: "ignore-existing" | "emit-existing" = "ignore-existing",
  projectId = "polling-project",
  githubRepositories: readonly string[] = ["main", "secondary"],
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
  configuration["repositories"] = [
    { id: "main", root: ".", defaultBranch: "main", remote: "origin" },
    { id: "secondary", root: ".", defaultBranch: "main", remote: "upstream" },
  ];
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

function endToEndConfig(): Record<string, unknown> {
  const configuration = projectConfig(true, "ignore-existing", "polling-project", ["main"]);
  const modules = configuration["modules"] as Record<string, unknown>[];
  const automationRules = modules.find((module) => module["instanceId"] === "automation-rules");
  if (automationRules === undefined) throw new Error("automation-rules module is missing");
  automationRules["configuration"] = {
    rules: [
      {
        id: "ready-label-starts-development",
        when: {
          eventType: "scm.work-item.tag-added",
          equals: { "payload.tag": "agent:ready" },
        },
        emit: {
          type: "development.implementation.requested",
          target: { moduleInstanceId: "development" },
        },
      },
    ],
  };
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

async function waitForEventTypeCount(
  engine: Harness,
  projectId: string,
  type: string,
  count: number,
): Promise<readonly Record<string, unknown>[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const response = await engine.call(`/v1/projects/${projectId}/events`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { readonly items: readonly Record<string, unknown>[] };
    const events = body.items.filter((event) => event["type"] === type);
    if (events.length >= count) return events;
    if (Date.now() >= deadline) {
      throw new Error(`project ${projectId} did not reach ${count} events of type ${type}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForExecutionCount(
  engine: Harness,
  projectId: string,
  count: number,
): Promise<readonly Record<string, unknown>[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const response = await engine.call(`/v1/projects/${projectId}/executions`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { readonly items: readonly Record<string, unknown>[] };
    const executions = body.items.filter(
      (execution) => execution["moduleInstanceId"] === "development",
    );
    if (
      executions.length >= count &&
      executions.every((execution) =>
        ["completed", "failed", "cancelled", "timed-out"].includes(String(execution["status"])),
      )
    )
      return executions;
    if (Date.now() >= deadline) {
      throw new Error(`project ${projectId} did not reach ${count} executions`);
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

async function waitForRequestCount(
  fakeGitHub: FakeGitHubApi,
  path: string,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (fakeGitHub.requests.filter((request) => request.path === path).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Fake GitHub did not receive ${count} requests for ${path}.`);
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
