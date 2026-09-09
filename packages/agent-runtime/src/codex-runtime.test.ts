import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChildProcessAgentRun } from "./child-process-agent-run.js";
import { CodexRuntime } from "./codex-runtime.js";
import type { AgentRunRequest, RuntimeDescriptor } from "./index.js";

const VERSION = "codex-cli 0.153.4";

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

  it("starts through the shared child-process run with Codex decisions local to the adapter", async () => {
    const root = await makeRoot();
    try {
      const argsMarker = join(root, "session-args");
      const executable = await makeExecutable(root, {
        version: print(VERSION),
        auth: print("Logged in using ChatGPT", "stderr"),
        session: `printf '%s\\n' "$@" > ${quote(argsMarker)}\ncat >/dev/null\nprintf session-output`,
      });
      const request = agentRequest(root);
      const run = await new CodexRuntime(executable).start(request, new AbortController().signal);

      expect(run).toBeInstanceOf(ChildProcessAgentRun);
      await run.result();
      expect((await readFile(argsMarker, "utf8")).split("\n")).toEqual([
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--cd",
        root,
        "-",
        "",
      ]);
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
