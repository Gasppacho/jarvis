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
  dispose(): Promise<void>;
}

/** Builds and activates the reference workflow without injecting an event. */
export async function startReferenceWorkflowFixture(
  projectId = "reference-workflow",
): Promise<ReferenceWorkflowFixture> {
  const repository = makeRealGitRepositoryFixture({
    additionalRemotes: [{ name: "github", url: "git@github.com:Gasppacho/jarvis.git" }],
  });
  const fakeGitHub = await startFakeGitHubApi();
  const executableRoot = mkdtempSync(join(tmpdir(), "jarvis-reference-gh-"));
  const executable = join(executableRoot, "gh");
  let engine: Harness | undefined;

  try {
    const configuration = referenceProjectConfiguration(projectId);
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
    const initialCommitSha = git(repository.root, ["rev-parse", "HEAD"]);
    execFileSync("git", ["push", repository.remoteName, repository.branch], {
      cwd: repository.root,
      stdio: "ignore",
    });

    writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' ghs_reference_fixture\n", "utf8");
    chmodSync(executable, 0o755);
    engine = await startEngine({
      enginePath: TEST_BUNDLE,
      env: {
        JARVIS_ENABLE_TEST_HOOKS: "1",
        JARVIS_GH_EXECUTABLE: executable,
        JARVIS_GITHUB_API_BASE_URL: fakeGitHub.baseUrl,
        JARVIS_GITHUB_POLL_INTERVAL_MS: "25",
      },
    });

    await createConnection(engine);
    const project = await importProject(engine, repository.root);
    await bindAndActivate(engine, project.id, repository.root);
    await waitFor(
      () =>
        fakeGitHub.requests.some(
          (request) =>
            request.method === "GET" && request.path === "/repos/Gasppacho/jarvis/issues/events",
        ),
      "GitHub polling request",
    );

    return {
      engine,
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
  const saved = await engine.call(`/v1/projects/${encodeURIComponent(projectId)}/bindings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...bindings,
      slots: {
        ...bindings.slots,
        sourceControl: { kind: "connection", ref: "connection/reference-github" },
        tickets: { kind: "connection", ref: "connection/reference-github" },
        agentRuntime: { kind: "runtime", ref: "runtime/fake-test" },
      },
    }),
  });
  await requireStatus(saved, 200, "save reference bindings");

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
