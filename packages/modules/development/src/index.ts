import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentRun, AgentRunResult } from "../../../agent-runtime/src/index.js";
import { buildAgentRunRequest } from "../../../agent-runtime/src/request-builder.js";
import type { ModuleHandler, ModuleHandlerContext } from "../../../module-sdk/src/index.js";

export const developmentModulePackage = {
  id: "jarvis.module.development",
  version: "1.0.0",
} as const;

export const DEVELOPMENT_MODULE_ID = developmentModulePackage.id;
export const DEVELOPMENT_IMPLEMENTATION_REQUESTED = {
  type: "development.implementation.requested",
  version: 1,
  kind: "request",
} as const;

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 1_048_576;
const MAX_OUTPUT_LIMIT_BYTES = 10_485_760;
const SECRET_ENVIRONMENT_NAME =
  /(?:secret|token|password|passwd|credential|private[_-]?key|api[_-]?key)/i;

interface ImplementationRequest {
  readonly workItemRef: string;
  readonly repositoryId: string;
  readonly baseBranch: string;
}

export interface DevelopmentRunResult {
  readonly status: AgentRunResult["status"];
  readonly summary: string;
  readonly changedFiles: readonly string[];
}

/** Runs one deterministic implementation attempt in the Project's worktree. */
export const handleImplementationRequested: ModuleHandler = async (
  ctx: ModuleHandlerContext,
): Promise<DevelopmentRunResult> => {
  const request = readImplementationRequest(ctx.event.payload);
  if (ctx.repositoryId !== request.repositoryId) {
    throw new Error("The implementation request repository does not match its Event repository.");
  }
  const runtime = ctx.capabilities.agentRuntime;
  const workspace = ctx.capabilities.workspace;
  const projectBindings = ctx.capabilities.projectBindings;
  if (runtime === undefined || workspace === undefined || projectBindings === undefined) {
    throw new Error("Development requires a project-bound Agent Runtime and workspace.");
  }

  const allocation = await workspace.allocate({
    executionId: ctx.executionId,
    repositoryId: request.repositoryId,
    baseRevision: request.baseBranch,
    branchContext: {
      workItemId: branchValue(request.workItemRef),
      slug: branchValue(`implementation-${ctx.executionId}`),
    },
  });
  let releaseOutcome: "success" | "failure" | "cancelled" = "failure";
  let run: AgentRun | undefined;
  try {
    const agentRequest = buildAgentRunRequest({
      projectId: ctx.projectId,
      executionId: ctx.executionId,
      workingDirectory: allocation.path,
      objective: "Implement the requested work item in the allocated workspace.",
      prompt: {
        moduleContract:
          "Development implements one requested work item in this workspace. Do not commit, push, or claim that validation passed.",
        projectConfiguration: JSON.stringify(ctx.configuration),
        repositoryInstructions: await repositoryInstructions(allocation.path),
        ticketContent: request.workItemRef,
      },
      environment: process.env,
      environmentAllowlist: stringArray(ctx.configuration["environmentAllowlist"]),
      projectBindings,
      mcpSlotNames: [],
      timeoutMs: boundedPositiveConfigNumber(
        ctx.configuration["timeoutMs"],
        DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      ),
      outputLimitBytes: boundedPositiveConfigNumber(
        ctx.configuration["outputLimitBytes"],
        DEFAULT_OUTPUT_LIMIT_BYTES,
        MAX_OUTPUT_LIMIT_BYTES,
      ),
      secretValues: processSecretValues(),
    });
    run = await runtime.start(agentRequest, ctx.signal);
    for await (const event of run.events()) {
      if (event.type === "started") {
        ctx.recordCheckpoint({
          type: "agent.started",
          sequence: event.sequence,
          timestamp: event.timestamp,
        });
      } else if (event.type === "message" && event.message !== undefined) {
        ctx.recordCheckpoint({
          type: "agent.message",
          sequence: event.sequence,
          timestamp: event.timestamp,
          message: event.message,
        });
      }
    }
    const result = await run.result();
    const changedFiles = await verifyChangedFiles(allocation.path, result.changedFiles);
    releaseOutcome = result.status === "completed" ? "success" : "failure";
    if (result.status === "cancelled") releaseOutcome = "cancelled";
    return { status: result.status, summary: result.summary, changedFiles };
  } catch (error) {
    if (run !== undefined) {
      try {
        await run.interrupt();
      } catch {
        // Preserve the original handler failure; cleanup is best effort here.
      }
    }
    throw error;
  } finally {
    await workspace.release({ executionId: ctx.executionId, outcome: releaseOutcome });
  }
};

function readImplementationRequest(
  payload: Readonly<Record<string, unknown>>,
): ImplementationRequest {
  const workItemRef = payload["workItemRef"];
  const repositoryId = payload["repositoryId"];
  const baseBranch = payload["baseBranch"];
  if (
    typeof workItemRef !== "string" ||
    workItemRef.trim() === "" ||
    typeof repositoryId !== "string" ||
    repositoryId.trim() === "" ||
    typeof baseBranch !== "string" ||
    baseBranch.trim() === ""
  ) {
    throw new Error("The implementation request payload is invalid.");
  }
  return { workItemRef, repositoryId, baseBranch };
}

function branchValue(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized.slice(0, 80) || "work-item";
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function boundedPositiveConfigNumber(value: unknown, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

async function repositoryInstructions(workspacePath: string): Promise<string> {
  try {
    const root = await realpath(workspacePath);
    const candidate = resolve(workspacePath, "AGENTS.md");
    const actual = await realpath(candidate);
    const pathFromRoot = relative(root, actual);
    if (pathFromRoot === "" || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) return "";
    return await readFile(actual, "utf8");
  } catch {
    return "";
  }
}

async function verifyChangedFiles(
  workspacePath: string,
  changedFiles: readonly string[],
): Promise<readonly string[]> {
  const root = await realpath(workspacePath);
  for (const file of changedFiles) {
    if (isAbsolute(file)) throw new Error("The Agent Runtime reported an absolute changed file.");
    const resolved = resolve(root, file);
    const relativePath = relative(root, resolved);
    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error("The Agent Runtime reported a changed file outside the workspace.");
    }
    const actual = await realpath(resolved);
    const actualRelative = relative(root, actual);
    if (actualRelative === "" || actualRelative.startsWith("..") || isAbsolute(actualRelative)) {
      throw new Error("The Agent Runtime changed file resolves outside the workspace.");
    }
    await stat(actual);
  }
  return [...changedFiles];
}

function processSecretValues(): readonly string[] {
  return Object.entries(process.env).flatMap(([key, value]) =>
    SECRET_ENVIRONMENT_NAME.test(key) && value !== undefined && value !== "" ? [value] : [],
  );
}
