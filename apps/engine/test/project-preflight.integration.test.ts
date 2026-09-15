import { localApiValidator, explain } from "./contract.js";
import type { ProjectPreflight } from "../src/projects/preflight.js";
import { join, dirname } from "node:path";
import Database from "better-sqlite3";
import { RuntimeDescriptorStore } from "../src/runtimes/registry.js";
import { chmodSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import {
  startReferenceWorkflowFixture,
  type ReferenceWorkflowFixture,
} from "./reference-workflow-fixture.js";
import type { PortableProjectConfiguration } from "../../../packages/project-runtime/src/project-types.js";

const fixtures: ReferenceWorkflowFixture[] = [];
it("validates the documented preflight example", () => {
  const validate = localApiValidator("ProjectPreflightV1");
  const example: unknown = JSON.parse(
    readFileSync(
      new URL("../../../examples/project/preflight-report.json", import.meta.url),
      "utf8",
    ),
  );
  expect(validate(example), explain(validate)).toBe(true);
});
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.dispose()));
});

async function setup(env: Readonly<Record<string, string>> = {}, fixed = true) {
  const f = await startReferenceWorkflowFixture("preflight", env, true, fixed);
  fixtures.push(f);
  const path = `/v1/projects/${f.projectId}`;
  const detail = (await (await f.engine.call(path)).json()) as {
    portableConfig: PortableProjectConfiguration;
  };
  const config = {
    ...detail.portableConfig,
    commands: { verify: "node --test" },
    modules: detail.portableConfig.modules.map((m) =>
      m.instanceId === "development"
        ? {
            ...m,
            configuration: {
              ...m.configuration,
              preparation: "none",
              validationOrder: ["verify"],
              environmentAllowlist: ["PATH", "HOME"],
            },
          }
        : m,
    ),
  };
  expect(
    (
      await f.engine.call(`${path}/configuration`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ portableConfig: config, writeToRepository: false }),
      })
    ).status,
  ).toBe(200);
  const executable = join(dirname(f.runtimeCounterPath), "preflight-codex");
  writeFileSync(
    executable,
    `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("--version")) { console.log("codex-cli 0.153.4"); process.exit(0); }
if (process.argv.includes("login")) { console.log("Logged in using ChatGPT"); process.exit(0); }
fs.appendFileSync(${JSON.stringify(f.runtimeCounterPath)}, "agent\\n");
fs.writeFileSync("preflight-change.txt", "Tested improvement\\n");
console.log(JSON.stringify({type: "item.completed", item: {type: "agent_message", text: "Implemented improvement"}}));
console.log(JSON.stringify({type: "turn.completed", usage: {input_tokens: 1, output_tokens: 1}}));
`,
  );
  chmodSync(executable, 0o755);
  const db = new Database(join(f.engine.dataRoot, "jarvis.sqlite"));
  new RuntimeDescriptorStore(db).upsert({
    id: "runtime/codex-preflight",
    provider: "codex",
    displayName: "Controlled Codex",
    executablePath: executable,
    version: "0.153.4",
    capabilities: ["agent.execute"],
    status: "available",
  });
  db.close();
  const bindings = (await (await f.engine.call(`${path}/bindings`)).json()) as {
    slots: Record<string, unknown>;
  };
  bindings.slots["agentRuntime"] = {
    kind: "runtime",
    ref: "runtime/codex-preflight",
    environment: { PATH: process.env["PATH"], HOME: process.env["HOME"] },
  };
  expect(
    (
      await f.engine.call(`${path}/bindings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bindings),
      })
    ).status,
  ).toBe(200);
  f.fakeGitHub.scriptRoute("GET", "/repos/Gasppacho/jarvis", {
    status: 200,
    body: { permissions: { pull: true, push: true } },
  });
  f.fakeGitHub.scriptRoute("GET", "/repos/Gasppacho/jarvis/labels/ready-for-agent", {
    status: 200,
    body: { name: "ready-for-agent" },
  });
  if (fixed)
    f.fakeGitHub.scriptRoute("GET", "/repos/Gasppacho/jarvis/labels/ready-to-dev", {
      status: 200,
      body: { name: "ready-to-dev" },
    });
  return { f, path, config };
}

it("checks a slow backlog within the read budget and still rejects incomplete observations", async () => {
  const { f, path } = await setup();
  const numbers = Array.from({ length: 24 }, (_, index) => 200 + index);
  for (const number of numbers) {
    seed(f, number, number === 204);
    f.fakeGitHub.scriptRoute("GET", `/repos/Gasppacho/jarvis/issues/${number}`, {
      status: 200,
      delayMs: 600,
      body: {
        number,
        title: `Issue ${number}`,
        state: "open",
        labels: [{ name: "ready-to-dev" }],
      },
    });
  }
  const complete = await report(f, path);
  expect(complete.candidateEligibility.status).toBe("available");
  expect(complete.candidateEligibility.items).toHaveLength(24);
  expect(
    complete.candidateEligibility.items.filter((item) => item.status === "eligible"),
  ).toHaveLength(23);
  expect(
    complete.candidateEligibility.items.find((item) => item.workItemRef.endsWith("/204"))
      ?.openDependencyCount,
  ).toBe(1);

  f.fakeGitHub.scriptRoute("GET", "/repos/Gasppacho/jarvis/issues/223", {
    status: 503,
    body: {},
  });
  const incomplete = await report(f, path);
  expect(incomplete.candidateEligibility.status).toBe("unavailable");
  expect(
    incomplete.candidateEligibility.items.find((item) => item.workItemRef.endsWith("/223"))?.status,
  ).toBe("unavailable");
  expect(
    incomplete.checks.find((item) => item.id === "dependencies:Gasppacho/jarvis")?.status,
  ).toBe("failed");
  expect(f.fakeGitHub.pullRequests).toHaveLength(0);
}, 30_000);

it("preflights and activates GitHub observation without Development or a ready label", async () => {
  const { f, path, config } = await setup();
  f.fakeGitHub.scriptRoute("GET", "/repos/Gasppacho/jarvis", {
    status: 200,
    body: { permissions: { pull: true, push: false } },
  });
  await save(f, path, {
    ...config,
    modules: config.modules.filter((module) => module.moduleId === "jarvis.module.github"),
  });
  const bindings = (await (await f.engine.call(`${path}/bindings`)).json()) as {
    slots: Record<string, unknown>;
  };
  expect(bindings.slots).not.toHaveProperty("agentRuntime");
  expect(bindings.slots).toHaveProperty("sourceControl");
  const detail = (await (await f.engine.call(path)).json()) as {
    portableConfig: PortableProjectConfiguration;
  };
  expect(detail.portableConfig.slots).not.toHaveProperty("agentRuntime");
  const ready = await report(f, path);
  expect(ready.valid, JSON.stringify(ready.checks)).toBe(true);
  expect(ready.runtime.required).toBe(false);
  expect(ready.trigger).toBeUndefined();
  expect(
    ready.checks.some((item) => item.id === "development" || item.id.startsWith("label:")),
  ).toBe(false);
  expect(
    (
      await post(f, `${path}/preflight-activate`, {
        compositionFingerprint: ready.compositionFingerprint,
      })
    ).status,
  ).toBe(200);
  expect(readFileSync(f.runtimeCounterPath, "utf8")).toBe("");
});

it("keeps a project-bound Codex graph contract-valid without exposing its environment", async () => {
  const { f, path } = await setup();
  const response = await post(f, `${path}/composition-graph`, {});
  const graph = await response.json();
  const validate = localApiValidator("ProjectCompositionGraphV1");
  expect(response.status).toBe(200);
  expect(validate(graph), explain(validate)).toBe(true);
  expect(JSON.stringify(graph)).not.toContain('"environment"');
  expect(graph).toMatchObject({
    rail: expect.arrayContaining([
      expect.objectContaining({
        kind: "slot",
        slot: "agentRuntime",
        binding: { kind: "runtime", ref: "runtime/codex-preflight" },
      }),
    ]),
  });
});

it("cannot bypass a failed preflight through direct activation or either resume route", async () => {
  const { f, path } = await setup();
  const ready = await report(f, path);
  expect(ready.valid).toBe(true);
  expect(
    (
      await post(f, `${path}/preflight-activate`, {
        compositionFingerprint: ready.compositionFingerprint,
      })
    ).status,
  ).toBe(200);
  expect((await post(f, `${path}/pause`, {})).status).toBe(200);
  f.fakeGitHub.scriptRoute("GET", "/repos/Gasppacho/jarvis", { status: 403, body: {} });
  expect((await report(f, path)).valid).toBe(false);
  for (const route of ["activate", "resume", "development-admission/resume"]) {
    expect(
      (
        await post(f, `${path}/${route}`, {
          compositionFingerprint: ready.compositionFingerprint,
        })
      ).status,
      route,
    ).toBe(409);
  }
  expect(((await (await f.engine.call(path)).json()) as { status: string }).status).toBe("paused");
  expect(readFileSync(f.runtimeCounterPath, "utf8")).toBe("");
});

it("a pause wins over an in-flight resume preflight", async () => {
  const { f, path } = await setup();
  const ready = await report(f, path);
  expect(
    (
      await post(f, `${path}/preflight-activate`, {
        compositionFingerprint: ready.compositionFingerprint,
      })
    ).status,
  ).toBe(200);
  await post(f, `${path}/pause`, {});
  const repositoryReads = () =>
    f.fakeGitHub.requests.filter((request) => request.path === "/repos/Gasppacho/jarvis").length;
  const before = repositoryReads();
  f.fakeGitHub.scriptRoute("GET", "/repos/Gasppacho/jarvis", {
    status: 200,
    delayMs: 1500,
    body: { permissions: { pull: true, push: true } },
  });
  const resuming = post(f, `${path}/resume`, {});
  await expect.poll(repositoryReads).toBeGreaterThan(before);
  expect((await post(f, `${path}/pause`, {})).status).toBe(200);
  expect((await resuming).status).toBe(409);
  expect(await (await f.engine.call(path)).json()).toMatchObject({ status: "paused" });
});

it("preflights fixed-modules from Development and scopes without an Automation Rule", async () => {
  const { f, path } = await setup({}, true);
  const ready = await report(f, path);
  expect(ready.valid, JSON.stringify(ready.checks)).toBe(true);
  expect(ready.rule).toBeUndefined();
  expect(ready.trigger).toEqual({
    moduleInstanceId: "development",
    moduleId: "jarvis.module.development",
    readyLabel: "ready-to-dev",
    scope: { kind: "all" },
  });
  expect(ready.candidateEligibility).toEqual({ status: "empty", items: [] });
  const scoped = await post(f, `${path}/preflight-scope`, {
    compositionFingerprint: ready.compositionFingerprint,
    scope: "all",
  });
  expect(scoped.status).toBe(200);
  const configuration = (await scoped.json()) as PortableProjectConfiguration;
  expect(configuration.modules).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        moduleId: "jarvis.module.development",
        configuration: expect.objectContaining({ scope: { kind: "all" } }),
      }),
    ]),
  );
  expect(
    configuration.modules.some((module) => module.moduleId === "jarvis.module.automation-rules"),
  ).toBe(false);
});

it("rejects an ineligible fixed-modules trial before activation", async () => {
  const { f, path } = await setup({ JARVIS_GITHUB_POLL_INTERVAL_MS: "25" }, true);
  seed(f, 1, true, "ready-to-dev");
  const ready = await report(f, path);
  expect(ready.valid).toBe(true);
  expect(ready.candidateEligibility.items[0]).toMatchObject({ status: "ineligible" });
  const rejected = await post(f, `${path}/preflight-scope`, {
    compositionFingerprint: ready.compositionFingerprint,
    scope: "issue",
    workItemRef: "github://Gasppacho/jarvis/issues/1",
  });
  expect(rejected.status).toBe(409);
  expect(f.fakeGitHub.pullRequests).toHaveLength(0);
  expect(readFileSync(f.runtimeCounterPath, "utf8")).toBe("");
  expect(await (await f.engine.call(`${path}/executions`)).json()).toEqual({ items: [] });
});

it("runs fixed-modules A, preserves it across restart, then admits B after scope all", async () => {
  const { f, path } = await setup({ JARVIS_GITHUB_POLL_INTERVAL_MS: "25" }, true);
  seed(f, 1, false, "ready-to-dev");
  seed(f, 2, false, "ready-to-dev");
  const before = await report(f, path);
  const scopedA = await post(f, `${path}/preflight-scope`, {
    compositionFingerprint: before.compositionFingerprint,
    scope: "issue",
    workItemRef: "github://Gasppacho/jarvis/issues/1",
  });
  expect(scopedA.status).toBe(200);
  await save(f, path, (await scopedA.json()) as PortableProjectConfiguration);
  const trialA = await report(f, path);
  expect(trialA.trigger?.scope).toEqual({
    kind: "issue",
    workItemRef: "github://Gasppacho/jarvis/issues/1",
  });
  expect(
    (
      await post(f, `${path}/preflight-activate`, {
        compositionFingerprint: trialA.compositionFingerprint,
      })
    ).status,
  ).toBe(200);
  await expect.poll(() => f.fakeGitHub.pullRequests.length, { timeout: 20000 }).toBe(1);
  expect(readFileSync(f.runtimeCounterPath, "utf8").trim().split("\n")).toHaveLength(1);

  await f.restart();
  await expect
    .poll(
      () =>
        f.fakeGitHub.requests.filter((request) => request.path.includes("/issues?state=open"))
          .length,
    )
    .toBeGreaterThan(2);
  expect(f.fakeGitHub.pullRequests).toHaveLength(1);
  expect(readFileSync(f.runtimeCounterPath, "utf8").trim().split("\n")).toHaveLength(1);

  const current = await report(f, path);
  expect((await post(f, `${path}/pause`, {})).status).toBe(200);
  expect((await post(f, `${path}/resume`, {})).status).toBe(200);
  expect(f.fakeGitHub.pullRequests).toHaveLength(1);
  const monitoring = await post(f, `${path}/preflight-scope`, {
    compositionFingerprint: current.compositionFingerprint,
    scope: "all",
  });
  expect(monitoring.status).toBe(200);
  await save(f, path, (await monitoring.json()) as PortableProjectConfiguration);
  const all = await report(f, path);
  expect(all.trigger?.scope).toEqual({ kind: "all" });
  expect(
    (
      await post(f, `${path}/preflight-activate`, {
        compositionFingerprint: all.compositionFingerprint,
      })
    ).status,
  ).toBe(200);
  await expect.poll(() => f.fakeGitHub.pullRequests.length, { timeout: 20000 }).toBe(2);
  expect(readFileSync(f.runtimeCounterPath, "utf8").trim().split("\n")).toHaveLength(2);

  await f.restart();
  await expect
    .poll(
      () =>
        f.fakeGitHub.requests.filter((request) => request.path.includes("/issues?state=open"))
          .length,
    )
    .toBeGreaterThan(4);
  expect(f.fakeGitHub.pullRequests).toHaveLength(2);
  expect(readFileSync(f.runtimeCounterPath, "utf8").trim().split("\n")).toHaveLength(2);
});

it("preflights a ready configuration with no candidates without starting work", async () => {
  const { f, path } = await setup();
  const response = await f.engine.call(`${path}/preflight`, { method: "POST" });
  expect(response.status).toBe(200);
  const report = (await response.json()) as ProjectPreflight;
  const validate = localApiValidator("ProjectPreflightV1");
  expect(validate(report), explain(validate)).toBe(true);
  expect(report, JSON.stringify(report)).toMatchObject({
    apiVersion: "jarvis.dev/project-preflight/v1",
    projectId: f.projectId,
    valid: true,
    configurationReady: true,
    candidateEligibility: { status: "empty", items: [] },
  });
  expect(readFileSync(f.runtimeCounterPath, "utf8")).toBe("");
  expect(f.fakeGitHub.requests.every((r) => r.method === "GET")).toBe(true);
  expect(await (await f.engine.call(`${path}/events`)).json()).toEqual({ items: [] });
  expect(await (await f.engine.call(`${path}/executions`)).json()).toEqual({ items: [] });
  expect(report.checks).toContainEqual(
    expect.objectContaining({ id: "tool:git", status: "passed" }),
  );
  expect(report.checks).toContainEqual(
    expect.objectContaining({ id: "tool:node", status: "passed" }),
  );
});

it("reports missing validator tools with a repair destination without running project scripts", async () => {
  const { f, path } = await setup({ PATH: "/jarvis-no-tools" });
  const result = await report(f, path);
  expect(result.valid).toBe(false);
  expect(result.checks).toContainEqual(
    expect.objectContaining({
      id: "tool:node",
      status: "failed",
      repairStep: "Connections",
      impact: expect.stringContaining("Installez ou réparez node"),
    }),
  );
  expect(readFileSync(f.runtimeCounterPath, "utf8")).toBe("");
  expect(JSON.stringify(result)).not.toContain("/jarvis-no-tools");
});

it("inspects selected scripts transitively without executing package-manager shims", async () => {
  const { f, path, config } = await setup();
  const bin = join(f.repositoryRoot, "tool-shims");
  const marker = join(bin, "executed");
  mkdirSync(bin);
  for (const tool of ["pnpm", "bun"]) {
    const executable = join(bin, tool);
    writeFileSync(
      executable,
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
    );
    chmodSync(executable, 0o755);
  }
  writeFileSync(
    join(f.repositoryRoot, "package.json"),
    JSON.stringify({
      scripts: {
        verify: "pnpm run check",
        check: "bun run check.ts && pnpm run toString",
        benchmark: "yarn benchmark",
      },
    }),
  );
  await save(f, path, { ...config, commands: { verify: "pnpm verify", test: "yarn test" } });
  await f.restart({ PATH: `${bin}:${process.env["PATH"] ?? ""}` });
  const result = await report(f, path);
  expect(result.valid, JSON.stringify(result)).toBe(true);
  expect(result.checks).toContainEqual(
    expect.objectContaining({ id: "tool:pnpm", status: "passed" }),
  );
  expect(result.checks).toContainEqual(
    expect.objectContaining({ id: "tool:bun", status: "passed" }),
  );
  expect(result.checks.some((item) => item.id === "tool:yarn")).toBe(false);
  expect(existsSync(marker)).toBe(false);
  expect(readFileSync(f.runtimeCounterPath, "utf8")).toBe("");
});

function seed(
  f: ReferenceWorkflowFixture,
  number: number,
  blocked = false,
  label = "ready-to-dev",
) {
  f.fakeGitHub.seedIssue({
    owner: "Gasppacho",
    repository: "jarvis",
    issue: {
      number,
      title: `Issue ${number}`,
      body: "Implement a small tested improvement",
      state: "open",
      labels: [{ name: label }],
      blockedBy: blocked
        ? [{ number: 99, state: "open", title: "Dependency 99", body: "", labels: [] }]
        : [],
    },
  });
}
async function report(f: ReferenceWorkflowFixture, path: string): Promise<ProjectPreflight> {
  const response = await f.engine.call(`${path}/preflight`, { method: "POST" });
  expect(response.status).toBe(200);
  return (await response.json()) as ProjectPreflight;
}
async function post(f: ReferenceWorkflowFixture, path: string, body: unknown) {
  if (path.endsWith("/preflight-scope") && typeof body === "object" && body !== null) {
    const request = body as { workItemRef?: string | null };
    body = {
      ...body,
      scope: request.workItemRef == null ? "all" : "issue",
      ...(request.workItemRef == null ? { workItemRef: undefined } : {}),
    };
  }
  return f.engine.call(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function save(
  f: ReferenceWorkflowFixture,
  path: string,
  config: PortableProjectConfiguration,
) {
  const response = await f.engine.call(`${path}/configuration`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ portableConfig: config, writeToRepository: false }),
  });
  expect(response.status, await response.text()).toBe(200);
}

it("separates native eligibility, scoped GET failures, label repair and resource findings", async () => {
  const { f, path, config } = await setup();
  seed(f, 1);
  seed(f, 2, true);
  const ready = await report(f, path);
  expect(ready.valid).toBe(true);
  expect(ready.candidateEligibility.items).toMatchObject([
    {
      workItemRef: "github://Gasppacho/jarvis/issues/1",
      status: "eligible",
      openDependencyCount: 0,
    },
    {
      workItemRef: "github://Gasppacho/jarvis/issues/2",
      status: "ineligible",
      openDependencyCount: 1,
      blockerRefs: ["github://Gasppacho/jarvis/issues/99"],
    },
  ]);
  const unavailable = f.fakeGitHub.scriptRoute(
    "GET",
    "/repos/Gasppacho/jarvis/issues/1/dependencies/blocked_by?per_page=100&page=1",
    { status: 403, body: { message: "secret provider error" } },
  );
  const failed = await report(f, path);
  expect(failed.valid).toBe(false);
  expect(failed.checks).toContainEqual(
    expect.objectContaining({
      id: "dependencies:Gasppacho/jarvis",
      status: "failed",
      repairStep: "Connections",
    }),
  );
  expect(JSON.stringify(failed)).not.toContain("secret provider error");
  expect(
    (
      await post(f, `${path}/preflight-activate`, {
        compositionFingerprint: ready.compositionFingerprint,
      })
    ).status,
  ).toBe(409);
  unavailable();
  const absentLabel = f.fakeGitHub.scriptRoute(
    "GET",
    "/repos/Gasppacho/jarvis/labels/ready-to-dev",
    { status: 404, body: {} },
  );
  expect((await report(f, path)).checks).toContainEqual(
    expect.objectContaining({
      id: "label:Gasppacho/jarvis",
      status: "failed",
      repairStep: "Workflow",
    }),
  );
  absentLabel();
  await save(f, path, { ...config, commands: {} });
  const invalid = await report(f, path);
  expect(invalid.configurationReady).toBe(false);
  expect(invalid.checks).toContainEqual(
    expect.objectContaining({ id: "composition", status: "failed", repairStep: "Workflow" }),
  );
  expect(f.fakeGitHub.requests.every((r) => r.method === "GET")).toBe(true);
  expect(readFileSync(f.runtimeCounterPath, "utf8")).toBe("");
});

it("does not contact GitHub for an unbound project and rejects a response predating an edit", async () => {
  const { f, path, config } = await setup();
  const bindings = (await (await f.engine.call(`${path}/bindings`)).json()) as {
    slots: Record<string, unknown>;
  };
  delete bindings.slots["sourceControl"];
  expect(
    (
      await f.engine.call(`${path}/bindings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bindings),
      })
    ).status,
  ).toBe(200);
  const requestCount = f.fakeGitHub.requests.length;
  const missing = await report(f, path);
  expect(missing.valid).toBe(false);
  expect(missing.checks).toContainEqual(
    expect.objectContaining({ id: "account", status: "failed", repairStep: "Connections" }),
  );
  expect(f.fakeGitHub.requests).toHaveLength(requestCount);
  bindings.slots["sourceControl"] = { kind: "connection", ref: "connection/reference-github" };
  expect(
    (
      await f.engine.call(`${path}/bindings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bindings),
      })
    ).status,
  ).toBe(200);
  f.fakeGitHub.scriptRoute("GET", "/repos/Gasppacho/jarvis", {
    status: 200,
    body: { permissions: { pull: true, push: true } },
    delayMs: 200,
  });
  const pending = f.engine.call(`${path}/preflight`, { method: "POST" });
  await expect.poll(() => f.fakeGitHub.requests.length).toBeGreaterThan(requestCount);
  await save(f, path, {
    ...config,
    metadata: { ...config.metadata, name: "Edited during preflight" },
  });
  expect((await pending).status).toBe(409);
  expect(readFileSync(f.runtimeCounterPath, "utf8")).toBe("");
});
