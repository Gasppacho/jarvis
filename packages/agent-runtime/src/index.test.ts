import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunEvent, AgentRunRequest, AgentRunResult } from "./index.js";
import { FakeAgentRun, FakeRuntime } from "./index.js";

const protocolEventTypes = [
  "started",
  "message",
  "stdout",
  "stderr",
  "tool-started",
  "tool-completed",
  "file-changed",
  "usage",
  "warning",
  "completed",
  "failed",
] as const;

const protocolResultStatuses = ["completed", "failed", "cancelled", "timed-out"] as const;

function request(workingDirectory: string, scenario?: string): AgentRunRequest {
  return {
    projectId: "project-1",
    executionId: "execution-1",
    workingDirectory,
    objective: "Implement the requested change",
    systemInstructions: ["Follow Jarvis policy"],
    contextArtifacts: [],
    allowedMcpBindings: [],
    environment: scenario === undefined ? {} : { JARVIS_FAKE_SCENARIO: scenario },
    timeoutMs: 10_000,
    outputLimitBytes: 1_000_000,
  };
}

async function expectProcessGone(pid: number): Promise<void> {
  expect(() => process.kill(pid, 0)).toThrow();
}

describe("FakeRuntime", () => {
  it("describes an available fake runtime with an explicit capability list", async () => {
    const descriptor = await new FakeRuntime().describe();

    expect(descriptor).toEqual({
      id: "runtime/fake-test",
      provider: "fake",
      displayName: "Fake Runtime",
      executablePath: null,
      version: null,
      capabilities: ["agent.execute"],
      status: "available",
    });
  });

  it("returns a stable descriptor without sharing mutable capabilities", async () => {
    const runtime = new FakeRuntime();
    const first = await runtime.describe();
    first.capabilities.push("unexpected.capability");

    expect(await runtime.describe()).toEqual({
      id: "runtime/fake-test",
      provider: "fake",
      displayName: "Fake Runtime",
      executablePath: null,
      version: null,
      capabilities: ["agent.execute"],
      status: "available",
    });
  });

  it("accepts every protocol event name and result status", () => {
    const events: AgentRunEvent[] = protocolEventTypes.map((type, index) => ({
      type,
      timestamp: "2026-09-08T00:00:00.000Z",
      sequence: index + 1,
    }));
    const statuses: AgentRunResult["status"][] = [...protocolResultStatuses];
    const request: AgentRunRequest = {
      projectId: "project-1",
      executionId: "execution-1",
      workingDirectory: "/tmp/worktree",
      objective: "Implement the requested change",
      systemInstructions: ["Follow Jarvis policy"],
      contextArtifacts: ["artifact://context"],
      allowedMcpBindings: ["mcp://project"],
      environment: { NODE_ENV: "test" },
      timeoutMs: 10_000,
      outputLimitBytes: 1_000_000,
    };

    expect(events.map(({ type }) => type)).toEqual(protocolEventTypes);
    expect(statuses).toEqual(protocolResultStatuses);
    expect(request.outputLimitBytes).toBe(1_000_000);
  });

  it("runs a deterministic child in the requested directory and returns its structured result", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "jarvis-fake-runtime-first-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "jarvis-fake-runtime-second-"));
    try {
      const runtime = new FakeRuntime();
      const firstRun = (await runtime.start(request(firstRoot), new AbortController().signal)) as FakeAgentRun;
      const secondRun = (await runtime.start(request(secondRoot), new AbortController().signal)) as FakeAgentRun;
      expect(firstRun.processId).toBeGreaterThan(0);
      expect(secondRun.processId).toBeGreaterThan(0);

      const first = await firstRun.result();
      const second = await secondRun.result();

      expect(first).toEqual({
        status: "completed",
        summary: "Fake Runtime applied deterministic change.",
        changedFiles: ["fake-runtime-change.txt"],
      });
      expect(second).toEqual(first);
      expect(await readFile(join(firstRoot, "fake-runtime-change.txt"), "utf8")).toBe(
        "Fake Runtime deterministic change.\n",
      );
      expect(await readFile(join(secondRoot, "fake-runtime-change.txt"), "utf8")).toBe(
        "Fake Runtime deterministic change.\n",
      );
      expect(await readdir(firstRoot)).toEqual(["fake-runtime-change.txt"]);
      await expectProcessGone(firstRun.processId);
      await expectProcessGone(secondRun.processId);
    } finally {
      await Promise.all([rm(firstRoot, { recursive: true, force: true }), rm(secondRoot, { recursive: true, force: true })]);
    }
  });

  it("returns a typed failed result when the child exits non-zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-fake-runtime-failure-"));
    try {
      const run = (await new FakeRuntime().start(
        request(root, "failure"),
        new AbortController().signal,
      )) as FakeAgentRun;
      const result = await run.result();

      expect(result).toEqual({
        status: "failed",
        summary: "Fake Runtime failed.",
        changedFiles: [],
        error: {
          code: "agent.process-failed",
          message: "Fake Runtime exited with code 7. deterministic fake failure",
          retryable: false,
        },
      });
      expect(await readdir(root)).toEqual([]);
      await expectProcessGone(run.processId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
