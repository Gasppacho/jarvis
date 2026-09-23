import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { RuntimeDescriptorStore } from "../src/runtimes/registry.js";
import type { ProjectPreflight } from "../src/projects/preflight.js";
import {
  startReferenceWorkflowFixture,
  type ReferenceWorkflowFixture,
} from "./reference-workflow-fixture.js";
import type {
  PortableProjectConfiguration,
  ProjectBindings,
} from "../../../packages/project-runtime/src/project-types.js";

const fixtures: ReferenceWorkflowFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

async function setup() {
  const fixture = await startReferenceWorkflowFixture("simple-verification", {}, true, true);
  fixtures.push(fixture);
  const path = `/v1/projects/${fixture.projectId}`;
  const detail = (await (await fixture.engine.call(path)).json()) as {
    portableConfig: PortableProjectConfiguration;
  };
  const executable = join(dirname(fixture.runtimeCounterPath), "verified-codex");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  const database = new Database(join(fixture.engine.dataRoot, "jarvis.sqlite"));
  new RuntimeDescriptorStore(database).upsert({
    id: "runtime/codex-verified",
    provider: "codex",
    displayName: "Verified Codex",
    executablePath: executable,
    version: "1.0.0",
    capabilities: ["agent.execute"],
    status: "available",
  });
  database.close();
  const currentBindings = await readBindings(fixture, path);
  const bindings = { ...currentBindings, slots: { ...currentBindings.slots } };
  bindings.slots["agentRuntime"] = {
    kind: "runtime",
    ref: "runtime/codex-verified",
    environment: { PATH: "/usr/bin:/bin" },
  };
  expect((await put(fixture, `${path}/bindings`, bindings)).status).toBe(200);
  fixture.fakeGitHub.scriptRoute("GET", "/repos/Gasppacho/jarvis", {
    status: 200,
    body: { default_branch: "main", permissions: { pull: true, push: true } },
  });
  return { fixture, path, config: detail.portableConfig, executable };
}

it("accepts an empty workflow immediately and activates only after verification", async () => {
  const { fixture, path, config } = await setup();
  await save(fixture, path, { ...config, modules: [], slots: {} });
  expect(
    (await post(fixture, `${path}/preflight-activate`, { compositionFingerprint: "none" })).status,
  ).toBe(409);

  const verified = await report(fixture, path);
  expect(verified).toMatchObject({ valid: true, configurationReady: true, checks: [] });
  const activated = await post(fixture, `${path}/preflight-activate`, {
    compositionFingerprint: verified.compositionFingerprint,
  });
  expect(activated.status, await activated.clone().text()).toBe(200);
  expect((await activated.json()) as { status: string }).toMatchObject({ status: "active" });
});

it("reports only Git initialization, GitHub identity and account access", async () => {
  const { fixture, path } = await setup();
  rmSync(join(fixture.repositoryRoot, ".git"), { recursive: true, force: true });
  const missingGit = await report(fixture, path);
  expect(missingGit.valid).toBe(false);
  expect(missingGit.checks).toMatchObject([
    { id: "git-repository", status: "failed" },
    { id: "github-repository", status: "failed" },
    { id: "github-account", status: "failed" },
    { id: "agent-cli", status: "passed" },
  ]);
  expect(JSON.stringify(missingGit)).not.toMatch(/label:|dependencies:|issues:|tool:/);
});

it("fails when the remote is not GitHub or the selected account cannot access it", async () => {
  const { fixture, path } = await setup();
  execFileSync("git", ["remote", "set-url", "origin", "https://example.com/acme/repo.git"], {
    cwd: fixture.repositoryRoot,
  });
  execFileSync("git", ["remote", "set-url", "github", "https://example.com/acme/repo.git"], {
    cwd: fixture.repositoryRoot,
  });
  const unidentified = await report(fixture, path);
  expect(unidentified.checks).toContainEqual(
    expect.objectContaining({ id: "github-repository", status: "failed" }),
  );

  execFileSync("git", ["remote", "set-url", "origin", "git@github.com:Gasppacho/jarvis.git"], {
    cwd: fixture.repositoryRoot,
  });
  fixture.fakeGitHub.scriptRoute("GET", "/repos/Gasppacho/jarvis", { status: 403, body: {} });
  const inaccessible = await report(fixture, path);
  expect(inaccessible.checks).toContainEqual(
    expect.objectContaining({ id: "github-account", status: "failed" }),
  );
});

it("invalidates verification when the same CLI loses its local environment", async () => {
  const { fixture, path } = await setup();
  const verified = await report(fixture, path);
  expect(verified.valid).toBe(true);
  const currentBindings = await readBindings(fixture, path);
  const bindings = { ...currentBindings, slots: { ...currentBindings.slots } };
  bindings.slots["agentRuntime"] = { kind: "runtime", ref: "runtime/codex-verified" };
  expect((await put(fixture, `${path}/bindings`, bindings)).status).toBe(200);
  expect((await fixture.engine.call(`${path}/preflight`)).status).toBe(404);
  expect(
    (
      await post(fixture, `${path}/preflight-activate`, {
        compositionFingerprint: verified.compositionFingerprint,
      })
    ).status,
  ).toBe(409);
});

it("rejects a selected Codex CLI without a tool profile before activation", async () => {
  const { fixture, path } = await setup();
  const currentBindings = await readBindings(fixture, path);
  const bindings = { ...currentBindings, slots: { ...currentBindings.slots } };
  bindings.slots["agentRuntime"] = { kind: "runtime", ref: "runtime/codex-verified" };
  expect((await put(fixture, `${path}/bindings`, bindings)).status).toBe(200);
  const result = await report(fixture, path);
  expect(result.valid).toBe(false);
  expect(result.runtime.readiness.status).toBe("access-denied");
  expect(result.checks).toContainEqual(
    expect.objectContaining({ id: "agent-cli", status: "failed" }),
  );
  expect(
    (
      await post(fixture, `${path}/preflight-activate`, {
        compositionFingerprint: result.compositionFingerprint,
      })
    ).status,
  ).toBe(409);
  expect(readFileSync(fixture.runtimeCounterPath, "utf8")).toBe("");
});

it("fails when the selected agent CLI is no longer executable", async () => {
  const { fixture, path, executable } = await setup();
  chmodSync(executable, 0o644);
  const result = await report(fixture, path);
  expect(result.valid).toBe(false);
  expect(result.checks).toContainEqual(
    expect.objectContaining({ id: "agent-cli", status: "failed" }),
  );
});

it("does not inspect the Development label, issues, commands, tests or routing", async () => {
  const { fixture, path, config } = await setup();
  const modules = config.modules.map((module) =>
    module.moduleId === "jarvis.module.development"
      ? { ...module, configuration: { ...module.configuration, readyLabel: "" } }
      : module,
  );
  await save(fixture, path, { ...config, modules });
  const requestCount = fixture.fakeGitHub.requests.length;
  const result = await report(fixture, path);
  expect(result.valid, JSON.stringify(result.checks)).toBe(true);
  expect(result.candidateEligibility).toEqual({ status: "empty", items: [] });
  expect(fixture.fakeGitHub.requests.slice(requestCount).map((request) => request.path)).toEqual([
    "/repos/Gasppacho/jarvis",
  ]);
  expect(readFileSync(fixture.runtimeCounterPath, "utf8")).toBe("");
});

it("persists success across restart and restores it without rerunning probes", async () => {
  const { fixture, path } = await setup();
  const verified = await report(fixture, path);
  const reads = fixture.fakeGitHub.requests.length;
  await fixture.restart();
  const restored = await fixture.engine.call(`${path}/preflight`);
  expect(restored.status, await restored.clone().text()).toBe(200);
  expect((await restored.json()) as ProjectPreflight).toEqual(verified);
  expect(fixture.fakeGitHub.requests).toHaveLength(reads);
  expect(
    (
      await post(fixture, `${path}/preflight-activate`, {
        compositionFingerprint: verified.compositionFingerprint,
      })
    ).status,
  ).toBe(200);
});

it("keeps verification for a label edit and never resurrects it after workflow, account or CLI round trips", async () => {
  const { fixture, path, config } = await setup();
  const first = await report(fixture, path);
  const modules = config.modules.map((module) =>
    module.moduleId === "jarvis.module.development"
      ? { ...module, configuration: { ...module.configuration, readyLabel: "another-label" } }
      : module,
  );
  await save(fixture, path, { ...config, modules });
  expect((await fixture.engine.call(`${path}/preflight`)).status).toBe(200);

  const currentBindings = await readBindings(fixture, path);
  const bindings = { ...currentBindings, slots: { ...currentBindings.slots } };
  delete bindings.slots["sourceControl"];
  expect((await put(fixture, `${path}/bindings`, bindings)).status).toBe(200);
  expect((await fixture.engine.call(`${path}/preflight`)).status).toBe(404);
  expect(
    (
      await post(fixture, `${path}/preflight-activate`, {
        compositionFingerprint: first.compositionFingerprint,
      })
    ).status,
  ).toBe(409);

  bindings.slots["sourceControl"] = {
    kind: "connection",
    ref: "connection/reference-github",
  };
  expect((await put(fixture, `${path}/bindings`, bindings)).status).toBe(200);
  expect((await fixture.engine.call(`${path}/preflight`)).status).toBe(404);
  expect(
    (
      await post(fixture, `${path}/preflight-activate`, {
        compositionFingerprint: first.compositionFingerprint,
      })
    ).status,
  ).toBe(409);

  await report(fixture, path);
  delete bindings.slots["agentRuntime"];
  expect((await put(fixture, `${path}/bindings`, bindings)).status).toBe(200);
  expect((await fixture.engine.call(`${path}/preflight`)).status).toBe(404);

  bindings.slots["agentRuntime"] = {
    kind: "runtime",
    ref: "runtime/codex-verified",
    environment: { PATH: "/usr/bin:/bin" },
  };
  expect((await put(fixture, `${path}/bindings`, bindings)).status).toBe(200);
  expect((await fixture.engine.call(`${path}/preflight`)).status).toBe(404);
  await report(fixture, path);
  const withoutGitHub = {
    ...config,
    modules: config.modules
      .filter(
        (module) =>
          module.moduleId !== "jarvis.module.github" &&
          module.moduleId !== "jarvis.module.pull-request",
      )
      .map((module) =>
        module.moduleId === "jarvis.module.development"
          ? { ...module, bindings: { repository: "main" } }
          : module,
      ),
    slots: { agentRuntime: config.slots["agentRuntime"]! },
  };
  await save(fixture, path, withoutGitHub);
  expect((await fixture.engine.call(`${path}/preflight`)).status).toBe(404);
  await save(fixture, path, config);
  expect((await fixture.engine.call(`${path}/preflight`)).status).toBe(404);
  expect(
    (
      await post(fixture, `${path}/preflight-activate`, {
        compositionFingerprint: first.compositionFingerprint,
      })
    ).status,
  ).toBe(409);
});

it("keeps an active snapshot operational until the verified configuration is applied", async () => {
  const { fixture, path, config } = await setup();
  const initial = await report(fixture, path);
  expect(
    (
      await post(fixture, `${path}/preflight-activate`, {
        compositionFingerprint: initial.compositionFingerprint,
      })
    ).status,
  ).toBe(200);
  const before = resolvedSnapshot(fixture);
  const updated = {
    ...config,
    modules: config.modules
      .filter(
        (module) =>
          module.moduleId !== "jarvis.module.github" &&
          module.moduleId !== "jarvis.module.pull-request",
      )
      .map((module) =>
        module.moduleId === "jarvis.module.development"
          ? { ...module, bindings: { repository: "main" } }
          : module,
      )
      .map((module) =>
        module.moduleId === "jarvis.module.development"
          ? { ...module, configuration: { ...module.configuration, readyLabel: "new-label" } }
          : module,
      ),
    slots: { agentRuntime: config.slots["agentRuntime"]! },
  };
  await save(fixture, path, updated);

  const saved = (await (await fixture.engine.call(path)).json()) as { status: string };
  expect(saved.status).toBe("active");
  expect(resolvedSnapshot(fixture)).toEqual(before);
  const oldOverview = (await (await fixture.engine.call(`${path}/overview`)).json()) as {
    readinessHelp: string;
    status: string;
  };
  expect(oldOverview.status).not.toBe("draft");
  expect(oldOverview.readinessHelp).toContain("ready-to-dev");
  expect(oldOverview.readinessHelp).not.toContain("new-label");

  const next = await report(fixture, path);
  expect(
    (
      await post(fixture, `${path}/preflight-activate`, {
        compositionFingerprint: next.compositionFingerprint,
      })
    ).status,
  ).toBe(200);
  expect(resolvedSnapshot(fixture)).not.toEqual(before);
  const appliedOverview = (await (await fixture.engine.call(`${path}/overview`)).json()) as {
    readinessHelp: string;
  };
  expect(appliedOverview.readinessHelp).toContain("new-label");

  expect((await post(fixture, `${path}/pause`, {})).status).toBe(200);
  const pausedSnapshot = resolvedSnapshot(fixture);
  await save(fixture, path, {
    ...updated,
    modules: updated.modules.map((module) =>
      module.moduleId === "jarvis.module.development"
        ? { ...module, configuration: { ...module.configuration, readyLabel: "paused-label" } }
        : module,
    ),
  });
  const paused = (await (await fixture.engine.call(path)).json()) as { status: string };
  expect(paused.status).toBe("paused");
  expect(resolvedSnapshot(fixture)).toEqual(pausedSnapshot);
  const pausedOverview = (await (await fixture.engine.call(`${path}/overview`)).json()) as {
    readinessHelp: string;
  };
  expect(pausedOverview.readinessHelp).toContain("new-label");
  expect(pausedOverview.readinessHelp).not.toContain("paused-label");
});

async function report(fixture: ReferenceWorkflowFixture, path: string): Promise<ProjectPreflight> {
  const response = await fixture.engine.call(`${path}/preflight`, { method: "POST" });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ProjectPreflight;
}

async function readBindings(
  fixture: ReferenceWorkflowFixture,
  path: string,
): Promise<ProjectBindings> {
  return (await (await fixture.engine.call(`${path}/bindings`)).json()) as ProjectBindings;
}

async function save(
  fixture: ReferenceWorkflowFixture,
  path: string,
  portableConfig: PortableProjectConfiguration,
): Promise<void> {
  const response = await put(fixture, `${path}/configuration`, {
    portableConfig,
    writeToRepository: false,
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

function put(fixture: ReferenceWorkflowFixture, path: string, body: unknown) {
  return fixture.engine.call(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function post(fixture: ReferenceWorkflowFixture, path: string, body: unknown) {
  return fixture.engine.call(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function resolvedSnapshot(fixture: ReferenceWorkflowFixture): unknown {
  const database = new Database(join(fixture.engine.dataRoot, "jarvis.sqlite"));
  const row = database
    .prepare("SELECT resolved_project FROM project_resolved_compositions WHERE project_id = ?")
    .get(fixture.projectId) as { resolved_project: string };
  database.close();
  return JSON.parse(row.resolved_project) as unknown;
}
