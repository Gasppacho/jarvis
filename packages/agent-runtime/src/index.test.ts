import { describe, expect, it } from "vitest";
import type { AgentRunEvent, AgentRunRequest, AgentRunResult } from "./index.js";
import { FakeRuntime } from "./index.js";

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
});
