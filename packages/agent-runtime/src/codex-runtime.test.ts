import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChildProcessAgentRun } from "./child-process-agent-run.js";
import { CodexRuntime } from "./codex-runtime.js";
import type { AgentRunEvent, AgentRunRequest, AgentRunResult, RuntimeDescriptor } from "./index.js";

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
        version: `env > ${quote(environmentMarker)}\nprintf '%s\\n' ${quote("x".repeat(256))}`,
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
      const fixture = (await readFile(FIXTURE, "utf8")).replaceAll("$WORKSPACE", root);
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
        changedFiles: ["added.txt", "updated.txt", "deleted.txt"],
        usage: { inputTokens: 43922, outputTokens: 285 },
      });
      expect(events.filter(({ type }) => type === "message").map(({ message }) => message)).toEqual(
        ["I inspected the requested workspace.", FINAL_SUMMARY],
      );
      expect(
        events
          .filter(({ type }) => type === "tool-started" || type === "tool-completed")
          .map(({ type, message, chunk }) => [type, message, chunk]),
      ).toEqual([
        ["tool-started", "pwd", undefined],
        ["tool-started", "printf 'second\\n'", undefined],
        ["tool-completed", "pwd (exit code: 0)", "/workspace/project\\n"],
        ["tool-completed", "printf 'second\\n' (exit code: 7)", "command failed\\n"],
      ]);
      expect(events.filter(({ type }) => type === "usage")).toHaveLength(1);
      expect(events.find(({ type }) => type === "usage")?.message).toContain("43922");
      const changedFiles = events
        .filter((event) => event.type === "file-changed")
        .map((event) => event.path);
      expect(changedFiles).toEqual(["added.txt", "updated.txt", "deleted.txt"]);
      expect(events.filter(({ type }) => type === "file-changed")).toHaveLength(3);
      expect(result.changedFiles).toEqual(changedFiles);

      expect(child.cwd).toBe(await realpath(root));
      expect(child.stdin).toContain("Do the work");
      expect(child.args.join(" ")).not.toContain("Do the work");
      expect(child.args).toEqual([
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "workspace-write",
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

  it("does not complete a command that remains dangling at turn completion", async () => {
    const root = await makeRoot();
    try {
      const request = agentRequest(root);
      const fixture = jsonl([
        { type: "thread.started", thread_id: "thread_dangling" },
        { type: "turn.started" },
        {
          type: "item.started",
          item: { id: "item_dangling", type: "command_execution", command: "git status" },
        },
        {
          type: "item.completed",
          item: { id: "item_summary", type: "agent_message", text: FINAL_SUMMARY },
        },
        { type: "turn.completed" },
      ]);
      const executable = await makeSessionExecutable(root, request, fixture);
      const run = await new CodexRuntime(executable).start(request, new AbortController().signal);

      const events = await collectEvents(run);
      const result = await run.result();

      expect(events.filter(({ type }) => type === "tool-started")).toHaveLength(1);
      expect(events.find(({ type }) => type === "tool-started")?.message).toBe("git status");
      expect(events.filter(({ type }) => type === "tool-completed")).toHaveLength(0);
      expect(result).toMatchObject({ status: "completed", summary: FINAL_SUMMARY });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("omits usage when the terminal event has no usage block", async () => {
    const root = await makeRoot();
    try {
      const request = agentRequest(root);
      const fixture = jsonl([
        { type: "thread.started", thread_id: "thread_no_usage" },
        {
          type: "item.completed",
          item: { id: "item_summary", type: "agent_message", text: FINAL_SUMMARY },
        },
        { type: "turn.completed" },
      ]);
      const executable = await makeSessionExecutable(root, request, fixture);
      const run = await new CodexRuntime(executable).start(request, new AbortController().signal);

      const events = await collectEvents(run);
      const result = await run.result();

      expect(events.filter(({ type }) => type === "usage")).toHaveLength(0);
      expect(result).not.toHaveProperty("usage");
      expect(result.status).toBe("completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts workspace paths and secrets in command events and output", async () => {
    const root = await makeRoot();
    const secret = "codex-command-secret";
    try {
      const request = {
        ...agentRequest(root),
        environment: { JARVIS_CODEX_TOKEN: secret },
      };
      const command = `cat ${root}/input.txt --token=${secret}`;
      const fixture = jsonl([
        { type: "thread.started", thread_id: "thread_redaction" },
        {
          type: "item.started",
          item: { id: "item_redaction", type: "command_execution", command },
        },
        {
          type: "item.completed",
          item: {
            id: "item_redaction",
            type: "command_execution",
            command,
            aggregated_output: `${root}/output.txt ${secret}`,
            exit_code: 0,
            status: "completed",
          },
        },
        {
          type: "item.completed",
          item: { id: "item_summary", type: "agent_message", text: FINAL_SUMMARY },
        },
        { type: "turn.completed" },
      ]);
      const executable = await makeSessionExecutable(root, request, fixture);
      const run = await new CodexRuntime(executable).start(request, new AbortController().signal);

      const events = await collectEvents(run);

      expect(JSON.stringify(events)).not.toContain(root);
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(events.find(({ type }) => type === "tool-started")?.message).toContain(
        "<workspace>/input.txt",
      );
      expect(events.find(({ type }) => type === "tool-completed")?.chunk).toContain(
        "<workspace>/output.txt",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies the shared captured-output limit to command lines and output", async () => {
    const root = await makeRoot();
    try {
      const request = { ...agentRequest(root), outputLimitBytes: 64 };
      const fixture = jsonl([
        { type: "thread.started", thread_id: "thread_output_limit" },
        {
          type: "item.started",
          item: {
            id: "item_output_limit",
            type: "command_execution",
            command: "x".repeat(128),
          },
        },
        {
          type: "item.completed",
          item: {
            id: "item_output_limit",
            type: "command_execution",
            aggregated_output: "o".repeat(128),
            exit_code: 0,
            status: "completed",
          },
        },
        {
          type: "item.completed",
          item: { id: "item_summary", type: "agent_message", text: FINAL_SUMMARY },
        },
        { type: "turn.completed" },
      ]);
      const executable = await makeSessionExecutable(root, request, fixture);
      const run = await new CodexRuntime(executable).start(request, new AbortController().signal);

      const events = await collectEvents(run);
      const capturedBytes = events
        .filter(({ type }) => type === "tool-started" || type === "tool-completed")
        .reduce(
          (total, event) =>
            total +
            Buffer.byteLength(event.message ?? "", "utf8") +
            Buffer.byteLength(event.chunk ?? "", "utf8"),
          0,
        );

      expect(capturedBytes).toBeLessThanOrEqual(64);
      expect(events.filter(({ type }) => type === "warning")).toHaveLength(1);
      expect(events.at(-1)?.type).toBe("completed");
    } finally {
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
      expect(result.error?.code).toBe("agent.codex.process-failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when the stream has no turn.completed result", async () => {
    const root = await makeRoot();
    try {
      const request = agentRequest(root);
      const fixture = (await readFile(FIXTURE, "utf8"))
        .replaceAll("$WORKSPACE", root)
        .split("\n")
        .filter((line) => !line.includes('"turn.completed"'))
        .join("\n");
      const executable = await makeSessionExecutable(root, request, fixture);
      const run = await new CodexRuntime(executable).start(request, new AbortController().signal);

      const events = await collectEvents(run);
      const result = await run.result();

      expect(result).toMatchObject({
        status: "failed",
        error: { code: "agent.codex.missing-result" },
      });
      expect(events.filter(({ type }) => type === "failed")).toHaveLength(1);
      expect(events.at(-1)?.type).toBe("failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels a Codex process group after graceful interrupt and stream drain", async () => {
    const root = await makeRoot();
    try {
      const request = { ...agentRequest(root), timeoutMs: 2_000 };
      const executable = await makeCancellationExecutable(root);
      const controller = new AbortController();
      const run = (await new CodexRuntime(executable).start(
        request,
        controller.signal,
      )) as ChildProcessAgentRun;
      const eventsPromise = collectEvents(run);
      const grandchildPid = await waitForPid(join(root, "codex-grandchild.pid"));
      await waitForMarker(join(root, "codex-ready"));

      controller.abort();
      await Promise.all([run.interrupt(), run.interrupt()]);
      const result = await run.result();
      const events = await eventsPromise;
      const terminalEvents = events.filter(({ type }) => type === "completed" || type === "failed");

      expect(result).toMatchObject({ status: "cancelled", changedFiles: [] });
      expect(events.filter(({ type }) => type === "message").map(({ message }) => message)).toEqual(
        ["Before cancellation"],
      );
      expect(events.filter(({ type }) => type === "file-changed").map(({ path }) => path)).toEqual([
        "observed-before-cancel",
      ]);
      expect(result.changedFiles).not.toContain("unobserved-after-cancel");
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]).toMatchObject({ type: "failed", result });
      expect(events.at(-1)).toMatchObject({ type: "failed", result });
      expect(
        events.findIndex(
          ({ type, chunk }) => type === "stderr" && chunk?.includes("codex streams drained"),
        ),
      ).toBeLessThan(events.length - 1);
      expect(await readFile(join(root, "codex-signals"), "utf8")).toBe("SIGTERM\n");
      expect(await readFile(join(root, "codex-drain"), "utf8")).toBe("streams-drained\n");
      await expectProcessGone(run.processId);
      await expectProcessGone(grandchildPid);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("times out a Codex process group and terminates its grandchild", async () => {
    const root = await makeRoot();
    try {
      const request = { ...agentRequest(root), timeoutMs: 500 };
      const executable = await makeCancellationExecutable(root);
      const run = (await new CodexRuntime(executable).start(
        request,
        new AbortController().signal,
      )) as ChildProcessAgentRun;
      const eventsPromise = collectEvents(run);
      const grandchildPid = await waitForPid(join(root, "codex-grandchild.pid"));
      const result = await run.result();
      const events = await eventsPromise;

      expect(result).toMatchObject({ status: "timed-out", changedFiles: [] });
      expect(events.filter(({ type }) => type === "completed" || type === "failed")).toHaveLength(
        1,
      );
      expect(events.at(-1)).toMatchObject({ type: "failed", result });
      expect(await readFile(join(root, "codex-signals"), "utf8")).toBe("SIGTERM\n");
      expect(await readFile(join(root, "codex-drain"), "utf8")).toBe("streams-drained\n");
      await expectProcessGone(run.processId);
      await expectProcessGone(grandchildPid);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a finished Codex result when interrupted afterwards", async () => {
    const root = await makeRoot();
    try {
      const request = agentRequest(root);
      const fixture = await readFile(FIXTURE, "utf8");
      const executable = await makeSessionExecutable(root, request, fixture);
      const run = await new CodexRuntime(executable).start(request, new AbortController().signal);
      const result = await run.result();

      await Promise.all([run.interrupt(), run.interrupt()]);

      await expect(run.result()).resolves.toEqual(result);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies a Codex turn.failed event without persisting its details", async () => {
    const root = await makeRoot();
    const secret = "codex-turn-secret";
    try {
      const request = {
        ...agentRequest(root),
        environment: { JARVIS_CODEX_TOKEN: secret },
      };
      const fixture = jsonl([
        { type: "thread.started", thread_id: "thread_failed" },
        {
          type: "turn.failed",
          error: { message: `provider failure at ${root}/credentials ${secret}` },
        },
      ]);
      const executable = await makeSessionExecutable(
        root,
        request,
        fixture,
        1,
        `Reading input from stdin\nMCP transport error at ${root}/mcp ${secret}\n`,
      );
      const { events, result } = await runScenario(executable, request);

      expect(result).toMatchObject({
        status: "failed",
        error: { code: "agent.codex.turn-failed", retryable: true },
      });
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain(secret);
      expectFailedTerminal(events, result);
      expect(events.findIndex(({ type }) => type === "stderr")).toBeLessThan(events.length - 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies a non-zero Codex process without a successful terminal event", async () => {
    const root = await makeRoot();
    const secret = "codex-process-secret";
    try {
      const request = {
        ...agentRequest(root),
        environment: { JARVIS_CODEX_TOKEN: secret },
      };
      const executable = await makeSessionExecutable(
        root,
        request,
        jsonl([{ type: "thread.started", thread_id: "thread_process_failed" }]),
        17,
        `MCP transport error at ${root}/transport ${secret}\n`,
      );
      const { events, result } = await runScenario(executable, request);

      expect(result).toMatchObject({
        status: "failed",
        error: { code: "agent.codex.process-failed", retryable: true },
      });
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain(secret);
      expectFailedTerminal(events, result);
      expect(events.findIndex(({ type }) => type === "stderr")).toBeLessThan(events.length - 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies invalid Codex JSON stdout after the streams drain", async () => {
    const root = await makeRoot();
    const secret = "codex-json-secret";
    try {
      const request = {
        ...agentRequest(root),
        environment: { JARVIS_CODEX_TOKEN: secret },
      };
      const executable = await makeSessionExecutable(
        root,
        request,
        `not-json ${root}/payload ${secret}\n`,
        0,
        `Reading input from stdin\n${root}/diagnostic ${secret}\n`,
      );
      const { events, result } = await runScenario(executable, request);

      expect(result).toMatchObject({
        status: "failed",
        error: { code: "agent.codex.invalid-json", retryable: false },
      });
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain(secret);
      expectFailedTerminal(events, result);
      expect(events.findIndex(({ type }) => type === "stderr")).toBeLessThan(events.length - 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("warns on an unrecognized Codex event without failing a later valid turn", async () => {
    const root = await makeRoot();
    try {
      const request = agentRequest(root);
      const fixture = jsonl([
        { type: "future.event", value: "ignored" },
        {
          type: "item.completed",
          item: { id: "item_summary", type: "agent_message", text: FINAL_SUMMARY },
        },
        { type: "turn.completed" },
      ]);
      const executable = await makeSessionExecutable(root, request, fixture);
      const { events, result } = await runScenario(executable, request);

      expect(result.status).toBe("completed");
      expect(events.filter(({ type }) => type === "warning")).toHaveLength(1);
      expect(events.at(-1)?.type).toBe("completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies an unauthenticated Codex refusal as non-retryable", async () => {
    const root = await makeRoot();
    const secret = "codex-auth-secret";
    try {
      const request = {
        ...agentRequest(root),
        environment: { JARVIS_CODEX_TOKEN: secret },
      };
      const fixture = jsonl([
        {
          type: "turn.failed",
          error: { message: `Not logged in; credential=${secret} at ${root}` },
        },
      ]);
      const executable = await makeSessionExecutable(root, request, fixture, 1);
      const { events, result } = await runScenario(executable, request);

      expect(result).toMatchObject({
        status: "failed",
        error: { code: "agent.codex.unauthenticated", retryable: false },
      });
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain(secret);
      expectFailedTerminal(events, result);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies an executable that cannot be spawned", async () => {
    const root = await makeRoot();
    try {
      const request = agentRequest(root);
      const executable = join(root, "missing-codex");
      const { events, result } = await runScenario(executable, request);

      expect(result).toMatchObject({
        status: "failed",
        error: { code: "agent.codex.spawn-failed", retryable: false },
      });
      expectFailedTerminal(events, result);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["a parent traversal", (root: string) => join(root, "..", "outside.txt")],
    ["the workspace directory", (root: string) => root],
  ])("rejects %s as a changed path", async (_label, pathForRoot) => {
    const root = await makeRoot();
    try {
      const request = agentRequest(root);
      const changedPath = pathForRoot(root);
      const fixture = [
        JSON.stringify({ type: "thread.started", thread_id: "thread_invalid" }),
        JSON.stringify({
          type: "item.started",
          item: { id: "item_invalid", type: "file_change", changes: [{ path: changedPath }] },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_invalid", type: "file_change", changes: [{ path: changedPath }] },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_summary", type: "agent_message", text: "Should not complete." },
        }),
        JSON.stringify({ type: "turn.completed" }),
      ].join("\n");
      const executable = await makeSessionExecutable(root, request, `${fixture}\n`);
      const run = await new CodexRuntime(executable).start(request, new AbortController().signal);

      const events = await collectEvents(run);
      const result = await run.result();

      expect(events.filter(({ type }) => type === "file-changed")).toHaveLength(0);
      expect(result).toMatchObject({
        status: "failed",
        changedFiles: [],
        error: { code: "agent.protocol-invalid" },
      });
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
  login)
    [ "$2" = status ] || exit 2
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
  stderr = "fixture diagnostic\n",
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
  process.stderr.write(${JSON.stringify(stderr)});
  process.stdout.write(${JSON.stringify(fixture)});
  process.exitCode = ${String(exitCode)};
});
`,
  );
  await chmod(executable, 0o755);
  return executable;
}

async function makeCancellationExecutable(root: string): Promise<string> {
  const executable = join(root, "codex");
  const grandchildSource = [
    'process.on("SIGTERM", () => {});',
    'process.on("SIGINT", () => {});',
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const emit = record => process.stdout.write(JSON.stringify(record) + "\\n");
const signalPath = ${JSON.stringify(join(root, "codex-signals"))};
const drainPath = ${JSON.stringify(join(root, "codex-drain"))};
process.on("SIGTERM", () => {
  fs.writeFileSync(signalPath, "SIGTERM\\n");
  process.stderr.write("codex graceful interrupt\\n");
  setTimeout(() => {
    fs.writeFileSync(drainPath, "streams-drained\\n");
    process.stderr.write("codex streams drained\\n");
  }, 25);
});
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(join(root, "codex-grandchild.pid"))}, String(grandchild.pid));
emit({ type: "thread.started", thread_id: "thread_cancel" });
emit({ type: "item.completed", item: { id: "message", type: "agent_message", text: "Before cancellation" } });
emit({ type: "item.completed", item: { id: "observed", type: "file_change", changes: [{ path: "observed-before-cancel" }] } });
emit({ type: "item.started", item: { id: "unobserved", type: "file_change", changes: [{ path: "unobserved-after-cancel" }] } });
fs.writeFileSync(${JSON.stringify(join(root, "codex-ready"))}, "ready\\n");
setTimeout(() => emit({ type: "item.completed", item: { id: "unobserved", type: "file_change", changes: [{ path: "unobserved-after-cancel" }] } }), 1_000);
setInterval(() => {}, 1_000);
`,
  );
  await chmod(executable, 0o755);
  return executable;
}

async function runScenario(
  executable: string,
  request: AgentRunRequest,
): Promise<{ readonly events: AgentRunEvent[]; readonly result: AgentRunResult }> {
  const run = await new CodexRuntime(executable).start(request, new AbortController().signal);
  const events = await collectEvents(run);
  const result = await run.result();
  return { events, result };
}

function expectFailedTerminal(events: readonly AgentRunEvent[], result: AgentRunResult): void {
  const terminalEvents = events.filter(({ type }) => type === "failed");
  expect(terminalEvents).toHaveLength(1);
  expect(terminalEvents[0]?.result).toEqual(result);
  expect(events.at(-1)?.type).toBe("failed");
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
  events(): AsyncIterable<AgentRunEvent>;
}): Promise<AgentRunEvent[]> {
  const events: AgentRunEvent[] = [];
  for await (const event of run.events()) events.push(event);
  return events;
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      const pid = Number.parseInt(await readFile(path, "utf8"), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // The fake Codex writes its marker after startup.
    }
    if (Date.now() >= deadline) throw new Error(`PID marker ${path} was not written.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForMarker(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      // The fake Codex writes its ready marker after emitting pre-cancel events.
    }
    if (Date.now() >= deadline) throw new Error(`Marker ${path} was not written.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() >= deadline) throw new Error(`Process ${pid} is still alive.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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

function jsonl(records: readonly Record<string, unknown>[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}
