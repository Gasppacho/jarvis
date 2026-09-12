import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ChildProcessAgentRun,
  type AgentRunEvent,
  type AgentRunObservation,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunTranslator,
} from "./index.js";

function request(workingDirectory: string, outputLimitBytes = 1_000_000): AgentRunRequest {
  return {
    projectId: "project-1",
    executionId: "execution-1",
    workingDirectory,
    objective: "Run the child",
    systemInstructions: [],
    contextArtifacts: [],
    allowedMcpBindings: [],
    environment: {},
    timeoutMs: 2_000,
    outputLimitBytes,
  };
}

function translator(): AgentRunTranslator {
  return {
    translate(line: string): readonly AgentRunObservation[] {
      if (line === "done") {
        const result: AgentRunResult = {
          status: "completed",
          summary: "trivial child completed",
          changedFiles: [],
        };
        return [{ type: "result", result }];
      }
      return [{ type: "message", message: line }];
    },
  };
}

async function collectEvents(run: ChildProcessAgentRun): Promise<AgentRunEvent[]> {
  const events: AgentRunEvent[] = [];
  for await (const event of run.events()) events.push(event);
  return events;
}

describe("ChildProcessAgentRun", () => {
  it("redacts temporary profile paths from the runtime observation stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-child-profile-"));
    try {
      const run = new ChildProcessAgentRun({
        request: request(root),
        signal: new AbortController().signal,
        executable: process.execPath,
        args: [
          "-e",
          'console.log("PATH=./node_modules/.bin:/private/tmp/project/node_modules/.bin:/usr/bin"); console.log("/tmp/private-profile"); console.log("done");',
        ],
        stdin: "",
        translator: translator(),
        displayName: "Controlled runtime",
      });
      const events = await collectEvents(run);
      expect(
        events.filter((event) => event.type === "message").map((event) => event.message),
      ).toEqual(["PATH=./node_modules/.bin:<path>", "<path>"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("frames stdout lines before passing them to a translator", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-child-agent-run-framing-"));
    try {
      const run = new ChildProcessAgentRun({
        request: request(root),
        signal: new AbortController().signal,
        executable: process.execPath,
        args: [
          "-e",
          'process.stdout.write("first"); setTimeout(() => process.stdout.write("\\nsecond\\ndone\\n"), 10);',
        ],
        stdin: "",
        translator: translator(),
        displayName: "Trivial Runtime",
      });

      const events = await collectEvents(run);

      expect(events.map(({ type, message }) => [type, message])).toEqual([
        ["started", undefined],
        ["message", "first"],
        ["message", "second"],
        ["completed", undefined],
      ]);
      expect(await run.result()).toEqual({
        status: "completed",
        summary: "trivial child completed",
        changedFiles: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds translated output and emits one warning without failing the result", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-child-agent-run-limit-"));
    try {
      const run = new ChildProcessAgentRun({
        request: request(root, 5),
        signal: new AbortController().signal,
        executable: process.execPath,
        args: ["-e", 'process.stdout.write("payload\\ndone\\n");'],
        stdin: "",
        translator: translator(),
        displayName: "Trivial Runtime",
      });

      const events = await collectEvents(run);
      const warnings = events.filter(({ type }) => type === "warning");
      const captured = events
        .filter(({ type }) => type === "message")
        .reduce((total, event) => total + Buffer.byteLength(event.message ?? "", "utf8"), 0);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain("truncated");
      expect(captured).toBeLessThanOrEqual(5);
      expect(events.at(-1)?.type).toBe("completed");
      await expect(run.result()).resolves.toMatchObject({ status: "completed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
