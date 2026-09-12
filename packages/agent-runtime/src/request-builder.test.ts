import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentRunRequest } from "./request-builder.js";
import { FakeRuntime, type AgentRunEvent } from "./index.js";

async function collectEvents(run: {
  events(): AsyncIterable<AgentRunEvent>;
}): Promise<AgentRunEvent[]> {
  const events: AgentRunEvent[] = [];
  for await (const event of run.events()) events.push(event);
  return events;
}

describe("buildAgentRunRequest", () => {
  it("filters project environment and MCP bindings, orders the prompt, and protects secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-agent-request-"));
    const secret = "project-bound-secret";
    try {
      const request = buildAgentRunRequest({
        projectId: "project-a",
        executionId: "execution-a",
        workingDirectory: root,
        objective: `Implement this request; ${secret}`,
        prompt: {
          moduleContract: "Module contract",
          projectConfiguration: `Project settings; ${secret}`,
          repositoryInstructions: `Repository instructions; ${secret}`,
          ticketContent: `Ticket content; ${secret}`,
        },
        environmentAllowlist: ["NODE_ENV", "JARVIS_FAKE_SCENARIO", "JARVIS_SECRET"],
        projectBindings: {
          projectId: "project-a",
          runtimeSlot: "runtime",
          slots: {
            tickets: { kind: "mcp", ref: "mcp/project-a-tickets" },
            runtime: {
              kind: "runtime",
              ref: "runtime/fake-test",
              environment: {
                NODE_ENV: "test",
                ENGINE_ONLY: "must-not-cross",
                JARVIS_FAKE_SCENARIO: "inspect",
                JARVIS_SECRET: secret,
              },
            },
          },
        },
        timeoutMs: 1_234,
        outputLimitBytes: 5_678,
        secretValues: [secret],
      });

      expect(request.environment).toEqual({
        JARVIS_FAKE_SCENARIO: "inspect",
        NODE_ENV: "test",
      });
      expect(request.allowedMcpBindings).toEqual(["mcp/project-a-tickets"]);
      expect(
        request.systemInstructions.map((instruction) => instruction.split("\n", 1)[0]),
      ).toEqual([
        expect.stringContaining("Jarvis security policy"),
        "Module contract and definition of done:",
        "Project configuration:",
        expect.stringContaining("Repository instructions"),
        expect.stringContaining("Ticket content"),
      ]);
      expect(request.systemInstructions[3]).toContain("untrusted input");
      expect(request.systemInstructions[4]).toContain("untrusted input");
      expect(JSON.stringify(request)).not.toContain(secret);
      expect(request.timeoutMs).toBe(1_234);
      expect(request.outputLimitBytes).toBe(5_678);

      const run = await new FakeRuntime().start(request, new AbortController().signal);
      const events = await collectEvents(run);
      const result = await run.result();
      const message = events.find((event) => event.type === "message");
      const observed: unknown = JSON.parse(message?.message ?? "{}");

      expect(isRecord(observed)).toBe(true);
      if (!isRecord(observed)) throw new Error("Fake Runtime inspection message was invalid.");
      expect(observed["environment"]).toEqual(request.environment);
      expect(await readFile(join(root, "fake-runtime-working-directory.txt"), "utf8")).toBe(
        await realpath(root),
      );
      expect(await readdir(root)).toEqual(["fake-runtime-working-directory.txt"]);
      expect(result.changedFiles).toEqual(["fake-runtime-working-directory.txt"]);
      expect(JSON.stringify(events)).not.toContain(secret);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cannot expose an MCP binding from another project", () => {
    const base = {
      executionId: "execution",
      workingDirectory: "/tmp/workspace",
      objective: "Implement the request",
      prompt: {
        moduleContract: "contract",
        projectConfiguration: "configuration",
        repositoryInstructions: "instructions",
        ticketContent: "ticket",
      },
      environmentAllowlist: [],
      timeoutMs: 1_000,
      outputLimitBytes: 1_024,
    } as const;

    const projectA = buildAgentRunRequest({
      ...base,
      projectId: "project-a",
      projectBindings: {
        projectId: "project-a",
        slots: { tickets: { kind: "mcp", ref: "mcp/project-a" } },
      },
    });
    const projectB = buildAgentRunRequest({
      ...base,
      projectId: "project-b",
      projectBindings: {
        projectId: "project-b",
        slots: { tickets: { kind: "mcp", ref: "mcp/project-b" } },
      },
    });

    expect(projectA.allowedMcpBindings).toEqual(["mcp/project-a"]);
    expect(projectA.allowedMcpBindings).not.toContain("mcp/project-b");
    expect(projectB.allowedMcpBindings).toEqual(["mcp/project-b"]);
  });

  it("uses only the selected runtime's local environment profile", () => {
    const request = buildAgentRunRequest({
      projectId: "project-a",
      executionId: "execution-a",
      workingDirectory: "/tmp/workspace",
      objective: "Implement the request",
      prompt: {
        moduleContract: "contract",
        projectConfiguration: "configuration",
        repositoryInstructions: "instructions",
        ticketContent: "ticket",
      },
      environmentAllowlist: ["PATH", "PROJECT_A", "PROJECT_B"],
      projectBindings: {
        projectId: "project-a",
        runtimeSlot: "runtime-a",
        slots: {
          "runtime-a": {
            kind: "runtime",
            ref: "runtime/codex-default",
            environment: { PATH: "/opt/homebrew/bin:/usr/bin", PROJECT_A: "allowed" },
          },
          "runtime-b": {
            kind: "runtime",
            ref: "runtime/other",
            environment: { PATH: "/private/bin", PROJECT_B: "must-not-cross" },
          },
        },
      },
      timeoutMs: 1_000,
      outputLimitBytes: 1_024,
    });

    expect(request.environment).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      PROJECT_A: "allowed",
    });
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
