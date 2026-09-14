import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { startEngine, startFakeGitHubApi, type FakeGitHubApi, type Harness } from "./harness.js";
import { makeRealGitRepositoryFixture } from "./repository-fixture.js";
import type {
  PortableProjectConfiguration,
  ProjectBindings,
} from "../../../packages/project-runtime/src/project-types.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TEST_BUNDLE = fileURLToPath(
  new URL("../../../dist/engine/engine.test-bundle.mjs", import.meta.url),
);

export interface ReferenceWorkflowFixture {
  readonly engine: Harness;
  readonly fakeGitHub: FakeGitHubApi;
  readonly repositoryRoot: string;
  readonly bareRemoteRoot: string;
  readonly projectId: string;
  readonly fakeGitHubBaseUrl: string;
  readonly initialCommitSha: string;
  activate(): Promise<void>;
  restart(env?: Readonly<Record<string, string>>): Promise<void>;
  readonly runtimeCounterPath: string;
  dispose(): Promise<void>;
}

/** Builds and activates the reference workflow without injecting an event. */
export async function startReferenceWorkflowFixture(
  projectId = "reference-workflow",
  extraEnv: Readonly<Record<string, string>> = {},
  guidedDraft = false,
  fixedModules = true,
  activateProject = true,
): Promise<ReferenceWorkflowFixture> {
  const repository = makeRealGitRepositoryFixture({
    additionalRemotes: [{ name: "github", url: "git@github.com:Gasppacho/jarvis.git" }],
  });
  const fakeGitHub = await startFakeGitHubApi();
  const executableRoot = mkdtempSync(join(tmpdir(), "jarvis-reference-gh-"));
  const executable = join(executableRoot, "gh");
  let engine: Harness | undefined;

  try {
    if (!guidedDraft) {
      const configuration = fixedModules
        ? fixedProjectConfiguration(projectId)
        : referenceProjectConfiguration(projectId);
      mkdirSync(join(repository.root, ".jarvis"), { recursive: true });
      writeFileSync(
        join(repository.root, ".jarvis", "project.yaml"),
        stringifyYaml(configuration),
        "utf8",
      );
      execFileSync("git", ["add", ".jarvis/project.yaml"], { cwd: repository.root });
      execFileSync(
        "git",
        ["commit", "--quiet", "--no-gpg-sign", "-m", "Reference workflow configuration"],
        {
          cwd: repository.root,
        },
      );
    }
    const initialCommitSha = git(repository.root, ["rev-parse", "HEAD"]);
    execFileSync("git", ["push", repository.remoteName, repository.branch], {
      cwd: repository.root,
      stdio: "ignore",
    });

    writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' ghs_reference_fixture\n", "utf8");
    chmodSync(executable, 0o755);
    const runtimeCounterPath = join(executableRoot, "runtime-calls");
    writeFileSync(runtimeCounterPath, "");
    const dataRoot = join(executableRoot, "data");
    const env = {
      JARVIS_ENABLE_TEST_HOOKS: "1",
      JARVIS_GH_EXECUTABLE: executable,
      JARVIS_GITHUB_API_BASE_URL: fakeGitHub.baseUrl,
      JARVIS_GITHUB_POLL_INTERVAL_MS: "25",
      JARVIS_OUTBOX_LEASE_MS: "200",
      JARVIS_FAKE_COUNTER_PATH: runtimeCounterPath,
    };
    engine = await startEngine({ enginePath: TEST_BUNDLE, dataRoot, env: { ...env, ...extraEnv } });

    await createConnection(engine);
    const project = await importProject(engine, repository.root);
    if (guidedDraft) {
      const fixedTemplate = await fixedStartingPointTemplate(engine, project.id);
      const template = fixedModules ? fixedTemplate : legacyGuidedTemplate(fixedTemplate);
      // Explicit local choices: GitHub identity from the named GitHub remote;
      // pushes still use the local bare origin. Never rewrite the poller's ID.
      const saved = await engine.call(`/v1/projects/${project.id}/configuration`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          portableConfig: {
            ...template,
            repositories: template.repositories.map((repository) => ({
              ...repository,
              remote: "github",
            })),
          },
          writeToRepository: false,
        }),
      });
      await requireStatus(saved, 200, "save guided draft");
      const bindings = (await (
        await engine.call(`/v1/projects/${project.id}/bindings`)
      ).json()) as ProjectBindings;
      if (Object.keys(bindings.slots).length !== 0) throw new Error("template granted resources");
    }
    await bindAndActivate(
      engine,
      project.id,
      repository.root,
      runtimeCounterPath,
      !guidedDraft && activateProject,
      fixedModules,
    );
    if (!guidedDraft && activateProject && fixedModules)
      await waitFor(
        () =>
          fakeGitHub.requests.some(
            (request) =>
              request.method === "GET" && request.path === "/repos/Gasppacho/jarvis/issues/events",
          ),
        "GitHub polling request",
      );

    return {
      get engine() {
        return engine!;
      },
      runtimeCounterPath,
      async activate() {
        await activate(engine!, project.id);
      },
      async restart(extra = {}) {
        await engine!.dispose();
        engine = await startEngine({
          enginePath: TEST_BUNDLE,
          dataRoot,
          env: { ...env, ...extra },
        });
      },
      fakeGitHub,
      repositoryRoot: repository.root,
      bareRemoteRoot: repository.remoteRoot,
      projectId: project.id,
      fakeGitHubBaseUrl: fakeGitHub.baseUrl,
      initialCommitSha,
      dispose: disposeFixture,
    };

    async function disposeFixture(): Promise<void> {
      try {
        await engine?.dispose();
      } finally {
        await fakeGitHub.close();
        rmSync(executableRoot, { recursive: true, force: true });
        rmSync(repository.root, { recursive: true, force: true });
        rmSync(repository.remoteRoot, { recursive: true, force: true });
      }
    }
  } catch (error: unknown) {
    try {
      await engine?.dispose();
    } finally {
      await fakeGitHub.close();
      rmSync(executableRoot, { recursive: true, force: true });
      rmSync(repository.root, { recursive: true, force: true });
      rmSync(repository.remoteRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

async function fixedStartingPointTemplate(
  engine: Harness,
  projectId: string,
): Promise<PortableProjectConfiguration> {
  const response = await engine.call(`/v1/projects/${projectId}/composition-choices`, {
    method: "POST",
  });
  const choices = (await response.json()) as {
    startingPoints: { template?: PortableProjectConfiguration }[];
  };
  const template = choices.startingPoints[0]?.template;
  if (template === undefined) throw new Error("guided template missing");
  return template;
}

function legacyGuidedTemplate(
  fixedTemplate: PortableProjectConfiguration,
): PortableProjectConfiguration {
  const { compositionMode: _compositionMode, ...legacy } = fixedTemplate;
  const github = fixedTemplate.modules.find((module) => module.instanceId === "github");
  const development = fixedTemplate.modules.find((module) => module.instanceId === "development");
  if (github === undefined || development === undefined)
    throw new Error("legacy guided template modules missing");
  return {
    ...legacy,
    slots: {
      ...fixedTemplate.slots,
      tickets: { requires: "work-items.read" },
    },
    modules: [
      {
        ...github,
        bindings: { ...github.bindings, tickets: "tickets" },
      },
      {
        instanceId: "automation-rules",
        moduleId: "jarvis.module.automation-rules",
        enabled: true,
        configuration: {
          rules: [
            {
              id: "ready-work-item-starts-development",
              when: {
                eventType: "scm.work-item.ready",
                equals: { "payload.tag": "ready-for-agent" },
              },
              emit: {
                type: "development.implementation.requested",
                target: { moduleInstanceId: "development" },
              },
            },
          ],
        },
      },
      {
        ...development,
        bindings: {
          ...development.bindings,
          tickets: "tickets",
          sourceControl: "sourceControl",
        },
      },
    ],
  };
}

function referenceProjectConfiguration(projectId: string): PortableProjectConfiguration {
  const configuration = parseYaml(
    readFileSync(join(ROOT, "examples/project/.jarvis/project.yaml"), "utf8"),
  ) as PortableProjectConfiguration;
  const modules = configuration.modules.map((module) => {
    if (module.instanceId === "github") {
      return {
        ...module,
        configuration: {
          ...module.configuration,
          bootstrapLabelPolicy: "ignore-existing",
          pollIntervalSeconds: 15,
        },
      };
    }
    if (module.instanceId === "development") {
      return {
        ...module,
        configuration: {
          ...module.configuration,
          validationOrder: ["test"],
          maxRepairCycles: 0,
          preparation: "none",
          environmentAllowlist: ["JARVIS_FAKE_COUNTER_PATH"],
        },
      };
    }
    return module;
  });
  return {
    ...configuration,
    metadata: { id: projectId, name: `Reference Workflow ${projectId}` },
    repositories: configuration.repositories.map((repository) =>
      repository.id === "main" ? { ...repository, remote: "github" } : repository,
    ),
    commands: { ...configuration.commands, test: "node --test" },
    modules,
  };
}

function fixedProjectConfiguration(projectId: string): PortableProjectConfiguration {
  const configuration = referenceProjectConfiguration(projectId);
  return {
    ...configuration,
    compositionMode: "fixed-modules",
    slots: {
      agentRuntime: { requires: "agent.execute" },
      sourceControl: { requires: "scm.change-request.manage" },
    },
    modules: configuration.modules
      .filter((module) => module.instanceId !== "automation-rules")
      .map((module) => {
        if (module.instanceId === "github") {
          return { ...module, bindings: { sourceControl: "sourceControl" } };
        }
        if (module.instanceId === "development") {
          return {
            ...module,
            bindings: { repository: "main" },
            configuration: {
              ...module.configuration,
              readyLabel: "ready-to-dev",
              scope: { kind: "all" },
            },
          };
        }
        return module;
      }),
  };
}

async function createConnection(engine: Harness): Promise<void> {
  const created = await engine.call("/v1/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "connection/reference-github",
      kind: "github",
      displayName: "ReferenceAccount",
      secretRef: "gh://ReferenceAccount",
    }),
  });
  await requireStatus(created, 201, "create GitHub connection");
  const validated = await engine.call("/v1/connections/connection%2Freference-github/validate", {
    method: "POST",
  });
  await requireStatus(validated, 200, "validate GitHub connection");
}

async function importProject(
  engine: Harness,
  repositoryRoot: string,
): Promise<{ readonly id: string }> {
  const response = await engine.call("/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositoryPath: repositoryRoot }),
  });
  const body = (await response.json()) as { readonly id?: unknown };
  if (response.status !== 201 || typeof body.id !== "string") {
    throw new Error(`import reference project failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return { id: body.id };
}

async function bindAndActivate(
  engine: Harness,
  projectId: string,
  repositoryRoot: string,
  runtimeCounterPath: string,
  shouldActivate = true,
  fixedModules = false,
): Promise<void> {
  const repositoryBinding = await engine.call(
    `/v1/projects/${encodeURIComponent(projectId)}/repositories/main/binding`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: repositoryRoot, bookmarkRef: `bookmark/${projectId}/main` }),
    },
  );
  await requireStatus(repositoryBinding, 200, "bind reference repository");

  const bindingsResponse = await engine.call(
    `/v1/projects/${encodeURIComponent(projectId)}/bindings`,
  );
  await requireStatus(bindingsResponse, 200, "read reference bindings");
  const bindings = (await bindingsResponse.json()) as ProjectBindings;
  const slots = {
    ...bindings.slots,
    sourceControl: { kind: "connection", ref: "connection/reference-github" },
    agentRuntime: {
      kind: "runtime",
      ref: "runtime/fake-test",
      environment: { JARVIS_FAKE_COUNTER_PATH: runtimeCounterPath },
    },
    ...(!fixedModules
      ? { tickets: { kind: "connection", ref: "connection/reference-github" } }
      : {}),
  };
  const saved = await engine.call(`/v1/projects/${encodeURIComponent(projectId)}/bindings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...bindings,
      slots,
    }),
  });
  await requireStatus(saved, 200, "save reference bindings");

  if (shouldActivate) await activate(engine, projectId);
}

async function activate(engine: Harness, projectId: string): Promise<void> {
  const reportResponse = await engine.call(
    `/v1/projects/${encodeURIComponent(projectId)}/validation-report`,
    { method: "POST" },
  );
  const report = (await reportResponse.json()) as {
    readonly valid?: unknown;
    readonly compositionFingerprint?: unknown;
    readonly findings?: unknown;
  };
  if (reportResponse.status !== 200 || report.valid !== true) {
    throw new Error(`reference project validation failed: ${JSON.stringify(report)}`);
  }
  const activated = await engine.call(`/v1/projects/${encodeURIComponent(projectId)}/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ compositionFingerprint: report.compositionFingerprint }),
  });
  await requireStatus(activated, 200, "activate reference project");
}

async function requireStatus(
  response: Response,
  expected: number,
  operation: string,
): Promise<void> {
  if (response.status !== expected) {
    throw new Error(`${operation} failed: ${response.status} ${await response.text()}`);
  }
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
