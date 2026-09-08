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

function request(
  workingDirectory: string,
  scenario?: string,
  outputLimitBytes = 1_000_000,
): AgentRunRequest {
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
    outputLimitBytes,
  };
}

async function expectProcessGone(pid: number): Promise<void> {
  expect(() => process.kill(pid, 0)).toThrow();
}

async function collectEvents(run: {
  events(): AsyncIterable<AgentRunEvent>;
}): Promise<AgentRunEvent[]> {
  const events: AgentRunEvent[] = [];
  for await (const event of run.events()) events.push(event);
  return events;
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

  it("streams a completed run as ordered protocol events", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-fake-runtime-events-"));
    try {
      const run = await new FakeRuntime().start(request(root), new AbortController().signal);
      const events = await collectEvents(run);
      const result = await run.result();

      expect(events.map(({ type }) => type)).toEqual([
        "started",
        "message",
        "file-changed",
        "completed",
      ]);
      expect(events.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4]);
      expect(events.every(({ timestamp }) => Number.isFinite(Date.parse(timestamp)))).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "completed", result });
      expect(
        events
          .filter(({ type }) => type === "file-changed")
          .map((event) => ("path" in event ? event.path : undefined)),
      ).toEqual(result.changedFiles);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs a deterministic child in the requested directory and returns its structured result", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "jarvis-fake-runtime-first-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "jarvis-fake-runtime-second-"));
    try {
      const runtime = new FakeRuntime();
      const firstRun = (await runtime.start(
        request(firstRoot),
        new AbortController().signal,
      )) as FakeAgentRun;
      const secondRun = (await runtime.start(
        request(secondRoot),
        new AbortController().signal,
      )) as FakeAgentRun;
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
      await Promise.all([
        rm(firstRoot, { recursive: true, force: true }),
        rm(secondRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it("normalizes malformed, raw stdout and stderr without losing the terminal event", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-fake-runtime-noisy-"));
    try {
      const run = await new FakeRuntime().start(
        request(root, "noisy"),
        new AbortController().signal,
      );
      const events = await collectEvents(run);
      const result = await run.result();

      const types = events.map(({ type }) => type);
      expect(types[0]).toBe("started");
      expect(types.at(-1)).toBe("completed");
      expect(types).toEqual(
        expect.arrayContaining(["warning", "stdout", "stderr", "message", "file-changed"]),
      );
      expect(events.map(({ sequence }) => sequence)).toEqual(events.map((_, index) => index + 1));
      expect(events.every(({ timestamp }) => Number.isFinite(Date.parse(timestamp)))).toBe(true);
      expect(events.find(({ type }) => type === "stdout")?.chunk).toContain("raw stdout");
      expect(events.find(({ type }) => type === "stderr")?.chunk).toContain("stderr output");
      expect(events.at(-1)).toMatchObject({ type: "completed", result });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports output truncation while completing the run", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-fake-runtime-output-limit-"));
    try {
      const run = await new FakeRuntime().start(
        request(root, "oversized", 64),
        new AbortController().signal,
      );
      const events = await collectEvents(run);
      const result = await run.result();

      expect(result.status).toBe("completed");
      expect(
        events.some(({ type, message }) => type === "warning" && message?.includes("truncated")),
      ).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "completed", result });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a typed failed result when the child exits non-zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-fake-runtime-failure-"));
    try {
      const run = (await new FakeRuntime().start(
        request(root, "failure"),
        new AbortController().signal,
      )) as FakeAgentRun;
      const events = await collectEvents(run);
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
      expect(events.find(({ type }) => type === "stderr")?.chunk).toContain("fake failure");
      expect(events.at(-1)).toMatchObject({ type: "failed", result });
      expect(await readdir(root)).toEqual([]);
      await expectProcessGone(run.processId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
