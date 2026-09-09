import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChildProcessAgentRun } from "./child-process-agent-run.js";
import { CodexRuntime } from "./codex-runtime.js";
import type { AgentRunRequest, RuntimeDescriptor } from "./index.js";

const VERSION = "codex-cli 0.153.4";
const FIXTURE = new URL("../fixtures/codex-cli-0.153.4-happy-path.jsonl", import.meta.url);
const FINAL_SUMMARY = "The fixture run completed successfully.";
const ENGINE_ONLY_ENVIRONMENT = "JARVIS_ENGINE_ONLY";

describe("CodexRuntime", () => {
  it("describes an available logged-in Codex executable", async () => {
    const root = await makeRoot();
    try {
      const executable = await makeExecutable(root, {
        version: print(VERSION),
        auth: print("Logged in using ChatGPT", "stderr"),
      });

      await expect(new CodexRuntime(executable).describe()).resolves.toEqual(
        descriptor(executable, VERSION.slice("codex-cli ".length), "available"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("describes a logged-out Codex executable as unauthenticated", async () => {
    const root = await makeRoot();
    try {
      const executable = await makeExecutable(root, {
        version: print(VERSION),
        auth: `${print("Not logged in", "stderr")}\nexit 1`,
      });

      await expect(new CodexRuntime(executable).describe()).resolves.toEqual(
        descriptor(executable, VERSION.slice("codex-cli ".length), "unauthenticated"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an absent or non-runnable executable as unavailable", async () => {
    const root = await makeRoot();
    try {
      const missing = join(root, "missing-codex");
      await expect(new CodexRuntime(null).describe()).resolves.toEqual(
        descriptor(null, null, "unavailable"),
      );
      await expect(new CodexRuntime(missing).describe()).resolves.toEqual(
        descriptor(missing, null, "unavailable"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an unrecognized version as degraded without probing auth", async () => {
    const root = await makeRoot();
    try {
      const authMarker = join(root, "auth-probed");
      const executable = await makeExecutable(root, {
        version: `${print("future-codex build")}`,
        auth: `${print("Logged in using ChatGPT", "stderr")}\nprintf probed > ${quote(authMarker)}`,
      });

      await expect(new CodexRuntime(executable).describe()).resolves.toEqual(
        descriptor(executable, null, "degraded"),
      );
      await expect(readFile(authMarker, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds a hanging version probe", async () => {
    const root = await makeRoot();
    try {
      const executable = await makeExecutable(root, {
        version: "trap '' TERM\nwhile :; do :; done",
        auth: print("Logged in using ChatGPT", "stderr"),
      });
      const startedAt = Date.now();

      await expect(
        new CodexRuntime(executable, { timeoutMs: 100 }).describe(),
      ).resolves.toMatchObject({ status: "unavailable", version: null });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds a hanging authentication probe", async () => {
    const root = await makeRoot();
    try {
      const executable = await makeExecutable(root, {
        version: print(VERSION),
        auth: "trap '' TERM\nwhile :; do :; done",
      });
      const startedAt = Date.now();

      await expect(
        new CodexRuntime(executable, { timeoutMs: 500 }).describe(),
      ).resolves.toMatchObject({ status: "unavailable", version: "0.153.4" });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("limits probe output and never exposes the engine environment or auth text", async () => {
    const root = await makeRoot();
    const secretName = "JARVIS_CODEX_TEST_SECRET";
    const secret = "codex-test-secret";
    const previousSecret = process.env[secretName];
    process.env[secretName] = secret;
    try {
      const environmentMarker = join(root, "probe-environment");
      const authText = `Logged in using ChatGPT credential=${secret}`;
      const executable = await makeExecutable(root, {
        version: `printf '%s\\n' ${quote("x".repeat(256))}\nenv > ${quote(environmentMarker)}`,
        auth: print(authText, "stderr"),
      });

      const result = await new CodexRuntime(executable, {
        outputLimitBytes: 32,
      }).describe();

      expect(result).toMatchObject({ status: "degraded", version: null });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(homedir());
      expect(await readFile(environmentMarker, "utf8")).not.toContain(secret);
    } finally {
      if (previousSecret === undefined) delete process.env[secretName];
      else process.env[secretName] = previousSecret;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replays the recorded stream through the shared child-process run", async () => {
    const root = await makeRoot();
    const previousEngineOnly = process.env[ENGINE_ONLY_ENVIRONMENT];
    process.env[ENGINE_ONLY_ENVIRONMENT] = "must-not-reach-child";
    try {
      const request = agentRequest(root);
      const fixture = await readFile(FIXTURE, "utf8");
      const executable = await makeSessionExecutable(root, request, fixture);
      const run = await new CodexRuntime(executable).start(request, new AbortController().signal);

      expect(run).toBeInstanceOf(ChildProcessAgentRun);
      const events = await collectEvents(run);
      const result = await run.result();
      const child = await readSessionMarkers(root);

      expect(events[0]?.type).toBe("started");
      expect(events.at(-1)).toMatchObject({ type: "completed", result });
      expect(result).toEqual({
        status: "completed",
        summary: FINAL_SUMMARY,
        changedFiles: [],
      });
      expect(events.filter(({ type }) => type === "message").map(({ message }) => message)).toEqual(
        ["I inspected the requested workspace.", FINAL_SUMMARY],
      );

      expect(child.cwd).toBe(await realpath(root));
      expect(child.stdin).toContain("Do the work");
      expect(child.args.join(" ")).not.toContain("Do the work");
      expect(child.args).toEqual([
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--cd",
        root,
        "-",
      ]);
      expect(child.environment).toEqual(request.environment);
      expect(child.environment).not.toHaveProperty(ENGINE_ONLY_ENVIRONMENT);
      expect(child.args).toContain("--ignore-user-config");
    } finally {
      if (previousEngineOnly === undefined) delete process.env[ENGINE_ONLY_ENVIRONMENT];
      else process.env[ENGINE_ONLY_ENVIRONMENT] = previousEngineOnly;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when the Codex process exits non-zero even after turn.completed", async () => {
    const root = await makeRoot();
    try {
      const request = agentRequest(root);
      const fixture = await readFile(FIXTURE, "utf8");
      const executable = await makeSessionExecutable(root, request, fixture, 7);
      const run = await new CodexRuntime(executable).start(request, new AbortController().signal);

      const result = await run.result();

      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("agent.process-failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when the stream has no turn.completed result", async () => {
    const root = await makeRoot();
    try {
      const request = agentRequest(root);
      const fixture = (await readFile(FIXTURE, "utf8"))
        .split("\n")
        .filter((line) => !line.includes('"turn.completed"'))
        .join("\n");
      const executable = await makeSessionExecutable(root, request, fixture);
      const run = await new CodexRuntime(executable).start(request, new AbortController().signal);

      const result = await run.result();

      expect(result).toMatchObject({ status: "failed", error: { code: "agent.invalid-result" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function descriptor(
  executablePath: string | null,
  version: string | null,
  status: RuntimeDescriptor["status"],
): RuntimeDescriptor {
  return {
    id: "runtime/codex-default",
    provider: "codex",
    displayName: "Codex — default",
    executablePath,
    version,
    capabilities: ["agent.execute"],
    status,
  };
}

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jarvis-codex-runtime-"));
}

async function makeExecutable(
  root: string,
  options: { readonly version: string; readonly auth: string; readonly session?: string },
): Promise<string> {
  const executable = join(root, "codex");
  await writeFile(
    executable,
    `#!/bin/sh
case "$1" in
  --version)
    ${options.version}
    ;;
  login-status)
    ${options.auth}
    ;;
  exec)
    ${options.session ?? "cat >/dev/null"}
    ;;
esac
`,
  );
  await chmod(executable, 0o755);
  return executable;
}

async function makeSessionExecutable(
  root: string,
  request: AgentRunRequest,
  fixture: string,
  exitCode = 0,
): Promise<string> {
  const executable = join(root, "codex");
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  delete process.env.__CF_USER_TEXT_ENCODING;
  const expectedEnvironment = ${JSON.stringify(request.environment)};
  const actualEnvironment = Object.fromEntries(Object.entries(process.env));
  const expectedNames = Object.keys(expectedEnvironment).sort();
  const actualNames = Object.keys(actualEnvironment).sort();
  const environmentMatches = expectedNames.length === actualNames.length &&
    expectedNames.every((name, index) => name === actualNames[index] && actualEnvironment[name] === expectedEnvironment[name]);
  const promptInArguments = process.argv.slice(2).some(argument => argument.includes("Do the work"));
  const valid = fs.realpathSync(process.cwd()) === fs.realpathSync(${JSON.stringify(root)}) &&
    input.includes("Do the work") &&
    !promptInArguments &&
    environmentMatches &&
    process.env[${JSON.stringify(ENGINE_ONLY_ENVIRONMENT)}] === undefined;
  fs.writeFileSync(${JSON.stringify(join(root, "session-args"))}, JSON.stringify(process.argv.slice(2)));
  fs.writeFileSync(${JSON.stringify(join(root, "session-stdin"))}, input);
  fs.writeFileSync(${JSON.stringify(join(root, "session-cwd"))}, process.cwd());
  fs.writeFileSync(${JSON.stringify(join(root, "session-environment"))}, JSON.stringify(actualEnvironment));
  if (!valid) { process.exitCode = 31; return; }
  process.stderr.write("fixture diagnostic\\n");
  process.stdout.write(${JSON.stringify(fixture)});
  process.exitCode = ${String(exitCode)};
});
`,
  );
  await chmod(executable, 0o755);
  return executable;
}

async function readSessionMarkers(root: string): Promise<{
  readonly args: string[];
  readonly stdin: string;
  readonly cwd: string;
  readonly environment: Record<string, string>;
}> {
  return {
    args: JSON.parse(await readFile(join(root, "session-args"), "utf8")) as string[],
    stdin: await readFile(join(root, "session-stdin"), "utf8"),
    cwd: await readFile(join(root, "session-cwd"), "utf8"),
    environment: JSON.parse(await readFile(join(root, "session-environment"), "utf8")) as Record<
      string,
      string
    >,
  };
}

async function collectEvents(run: {
  events(): AsyncIterable<{ type: string; message?: string }>;
}): Promise<Array<{ readonly type: string; readonly message?: string }>> {
  const events: Array<{ readonly type: string; readonly message?: string }> = [];
  for await (const event of run.events()) events.push(event);
  return events;
}

function print(value: string, stream?: "stderr"): string {
  return `${stream === "stderr" ? "" : ""}printf '%s\\n' ${quote(value)}${stream === "stderr" ? " >&2" : ""}`;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function agentRequest(workingDirectory: string): AgentRunRequest {
  return {
    projectId: "project-1",
    executionId: "execution-1",
    workingDirectory,
    objective: "Do the work",
    systemInstructions: ["Follow policy"],
    contextArtifacts: [],
    allowedMcpBindings: [],
    environment: { JARVIS_TEST_ENVIRONMENT: "present" },
    timeoutMs: 2_000,
    outputLimitBytes: 1_000_000,
  };
}
