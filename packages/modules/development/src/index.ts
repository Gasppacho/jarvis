import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentRun, AgentRunResult } from "../../../agent-runtime/src/index.js";
import { buildAgentRunRequest } from "../../../agent-runtime/src/request-builder.js";
import { GitRunner, type GitCommandResult } from "../../../workspace/src/git-runner.js";
import type {
  ModuleHandler,
  ModuleHandlerContext,
  ModuleShell,
  ModuleShellCommandResult,
  ProjectCommandsCapability,
} from "../../../module-sdk/src/index.js";

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
export const DEVELOPMENT_IMPLEMENTATION_COMPLETED = {
  type: "development.implementation.completed",
  version: 1,
  kind: "fact",
} as const;
export const CHANGE_REQUEST_CREATION_REQUESTED = {
  type: "scm.change-request.creation-requested",
  version: 1,
  kind: "request",
} as const;
export const DEVELOPMENT_IMPLEMENTATION_FAILED = {
  type: "development.implementation.failed",
  version: 1,
  kind: "fact",
} as const;

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 1_048_576;
const MAX_OUTPUT_LIMIT_BYTES = 10_485_760;
const SECRET_ENVIRONMENT_NAME =
  /(?:secret|token|password|passwd|credential|private[_-]?key|api[_-]?key)/i;
const VALIDATION_CHECKS = ["lint", "typecheck", "test", "build"] as const;
type ValidationCheck = (typeof VALIDATION_CHECKS)[number];
type DevelopmentFailureCode =
  | "event.payload-invalid"
  | "project.config-invalid"
  | "project.capability-unresolved"
  | "workspace.allocation-failed"
  | "workspace.branch-conflict"
  | "workspace.concurrency-limit"
  | "workspace.path-violation"
  | "workspace.lease-not-found"
  | "workspace.release-failed"
  | "git.base-not-found"
  | "git.validation-failed"
  | "git.no-changes"
  | "git.commit-failed"
  | "git.push-failed"
  | "agent.run-failed"
  | "agent.run-timed-out"
  | "agent.run-cancelled"
  | "system.internal-error";

class DevelopmentExecutionError extends Error {
  public constructor(
    public readonly code: DevelopmentFailureCode,
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = "DevelopmentExecutionError";
    this.failureClass = failureClass(code);
    this.errorClass = this.failureClass;
    this.retryable = retryable;
  }

  public readonly failureClass:
    "configuration" | "input" | "validation" | "workspace" | "agent" | "cancelled" | "internal";
  public readonly errorClass: DevelopmentExecutionError["failureClass"];
  public readonly retryable: boolean;
}

function failureClass(
  code: DevelopmentFailureCode,
): "configuration" | "input" | "validation" | "workspace" | "agent" | "cancelled" | "internal" {
  if (code === "event.payload-invalid") return "input";
  if (code === "project.config-invalid" || code === "project.capability-unresolved") {
    return "configuration";
  }
  if (code === "git.validation-failed") return "validation";
  if (code === "agent.run-cancelled") return "cancelled";
  if (code === "agent.run-failed" || code === "agent.run-timed-out") return "agent";
  if (code === "system.internal-error") return "internal";
  return "workspace";
}

interface ImplementationRequest {
  readonly workItemRef: string;
  readonly repositoryId: string;
  readonly baseBranch: string;
}

interface DevelopmentExecutionState {
  workspaceAllocated: boolean;
}

export interface DevelopmentRunResult {
  readonly status: AgentRunResult["status"];
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly headBranch?: string;
  readonly headCommit?: string;
  readonly validation: readonly {
    readonly name: ValidationCheck;
    readonly status: "passed";
    readonly durationMs: number;
  }[];
  readonly commands: ProjectCommandsCapability["commands"];
  readonly git: ProjectCommandsCapability["git"];
}

/** Runs one deterministic implementation attempt in the Project's worktree. */
export const handleImplementationRequested: ModuleHandler = async (
  ctx: ModuleHandlerContext,
): Promise<DevelopmentRunResult> => {
  const state: DevelopmentExecutionState = { workspaceAllocated: false };
  try {
    const result = await runImplementationRequested(ctx, state);
    if (result.status === "timed-out") {
      publishDevelopmentFailure(
        ctx,
        new DevelopmentExecutionError(
          "agent.run-timed-out",
          "The Agent Runtime timed out before completing the implementation.",
          true,
        ),
        state,
      );
    } else if (result.status === "cancelled") {
      publishDevelopmentFailure(
        ctx,
        new DevelopmentExecutionError(
          "agent.run-cancelled",
          "The implementation was cancelled before completion.",
        ),
        state,
      );
    }
    return result;
  } catch (error) {
    publishDevelopmentFailure(
      ctx,
      ctx.signal.aborted
        ? new DevelopmentExecutionError(
            "agent.run-cancelled",
            "The implementation was cancelled before completion.",
          )
        : error,
      state,
    );
    throw error;
  }
};

async function runImplementationRequested(
  ctx: ModuleHandlerContext,
  state: DevelopmentExecutionState,
): Promise<DevelopmentRunResult> {
  const request = readImplementationRequest(ctx.event.payload);
  if (ctx.repositoryId !== request.repositoryId) {
    throw new DevelopmentExecutionError(
      "event.payload-invalid",
      "The implementation request repository does not match its Event repository.",
    );
  }
  const runtime = ctx.capabilities.agentRuntime;
  const workspace = ctx.capabilities.workspace;
  const projectBindings = ctx.capabilities.projectBindings;
  const projectCommands = ctx.capabilities.projectCommands;
  const shell = ctx.capabilities.shell;
  if (
    runtime === undefined ||
    workspace === undefined ||
    projectBindings === undefined ||
    projectCommands === undefined ||
    shell === undefined
  ) {
    throw new DevelopmentExecutionError(
      "project.capability-unresolved",
      "Development requires a project-bound Agent Runtime, workspace, and Project Commands.",
    );
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
  state.workspaceAllocated = true;
  let releaseOutcome: "success" | "failure" | "cancelled" = "failure";
  let run: AgentRun | undefined;
  let checkpointSequence = 0;
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
    let result: AgentRunResult;
    try {
      run = await runtime.start(agentRequest, ctx.signal);
      for await (const event of run.events()) {
        if (event.type === "started") {
          checkpointSequence = Math.max(checkpointSequence, event.sequence);
          ctx.recordCheckpoint({
            type: "agent.started",
            sequence: event.sequence,
            timestamp: event.timestamp,
          });
        } else if (event.type === "message" && event.message !== undefined) {
          checkpointSequence = Math.max(checkpointSequence, event.sequence);
          ctx.recordCheckpoint({
            type: "agent.message",
            sequence: event.sequence,
            timestamp: event.timestamp,
            message: event.message,
          });
        }
      }
      result = await run.result();
    } catch (error) {
      if (error instanceof DevelopmentExecutionError) throw error;
      throw new DevelopmentExecutionError(
        ctx.signal.aborted ? "agent.run-cancelled" : "agent.run-failed",
        ctx.signal.aborted
          ? "The implementation was cancelled before completion."
          : "The Agent Runtime failed before completing the implementation.",
        !ctx.signal.aborted,
      );
    }
    let changedFiles: readonly string[];
    try {
      changedFiles = await verifyChangedFiles(allocation.path, result.changedFiles);
    } catch {
      throw new DevelopmentExecutionError(
        "agent.run-failed",
        "The Agent Runtime returned an invalid implementation result.",
      );
    }
    if (result.status !== "completed") {
      releaseOutcome = result.status === "cancelled" ? "cancelled" : "failure";
      if (result.status === "failed") {
        throw new DevelopmentExecutionError(
          ctx.signal.aborted ? "agent.run-cancelled" : "agent.run-failed",
          ctx.signal.aborted
            ? "The implementation was cancelled before completion."
            : "The Agent Runtime reported that the implementation failed.",
          !ctx.signal.aborted && (result.error?.retryable ?? false),
        );
      }
      return {
        status: result.status,
        summary: result.summary,
        changedFiles,
        validation: [],
        commands: projectCommands.commands,
        git: projectCommands.git,
      };
    }
    const validation = await runValidationPlan({
      order: readValidationOrder(ctx.configuration["validationOrder"]),
      commands: projectCommands.commands,
      shell,
      cwd: allocation.path,
      signal: ctx.signal,
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
      nextCheckpointSequence: () => ++checkpointSequence,
      recordCheckpoint: ctx.recordCheckpoint,
    });
    const commit = await createCommit({
      workspacePath: allocation.path,
      baseRevisionSha: allocation.baseRevisionSha,
      workItemRef: request.workItemRef,
      commitStrategy: projectCommands.git.commitStrategy,
      signal: ctx.signal,
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
    });
    ctx.recordCheckpoint({
      type: "commit.created",
      sequence: ++checkpointSequence,
      timestamp: new Date().toISOString(),
      branch: commit.branch,
      sha: commit.sha,
    });
    await pushBranch({
      workspacePath: allocation.path,
      branch: commit.branch,
      sha: commit.sha,
      pushRemote: projectCommands.git.pushRemote,
      signal: ctx.signal,
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
    });
    ctx.recordCheckpoint({
      type: "branch.pushed",
      sequence: ++checkpointSequence,
      timestamp: new Date().toISOString(),
      branch: commit.branch,
      sha: commit.sha,
    });
    publishDevelopmentOutputs(ctx, request, result, commit, validation);
    releaseOutcome = "success";
    return {
      status: result.status,
      summary: result.summary,
      changedFiles,
      headBranch: commit.branch,
      headCommit: commit.sha,
      validation,
      commands: projectCommands.commands,
      git: projectCommands.git,
    };
  } catch (error) {
    if (ctx.signal.aborted) releaseOutcome = "cancelled";
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
}

function publishDevelopmentFailure(
  ctx: ModuleHandlerContext,
  error: unknown,
  state: DevelopmentExecutionState,
): void {
  const failure = readFailure(error, ctx.signal.aborted);
  const workItemRef = safeFailureReference(
    ctx.event.payload["workItemRef"],
    ctx.event.subject.ref,
    "work-item",
  );
  const repositoryId = safeFailureReference(
    ctx.event.payload["repositoryId"],
    ctx.repositoryId,
    "repository",
    200,
  );
  ctx.publishFailure({
    ...DEVELOPMENT_IMPLEMENTATION_FAILED,
    subject: { type: "work-item", ref: workItemRef },
    repositoryId,
    payload: {
      workItemRef,
      repositoryId,
      code: failure.code,
      message: failureMessage(ctx, failure.code),
      retryable: failure.retryable,
      ...(state.workspaceAllocated
        ? { workspaceRef: `workspace://${ctx.projectId}/${ctx.executionId}` }
        : {}),
    },
  });
}

function readFailure(
  error: unknown,
  cancelled: boolean,
): { readonly code: DevelopmentFailureCode; readonly retryable: boolean } {
  if (cancelled) return { code: "agent.run-cancelled", retryable: false };
  if (error instanceof DevelopmentExecutionError) {
    return { code: error.code, retryable: error.retryable };
  }
  if (isRecord(error) && typeof error["code"] === "string") {
    const code = error["code"];
    const retryable = typeof error["retryable"] === "boolean" ? error["retryable"] : false;
    return { code: stableFailureCode(code), retryable };
  }
  return { code: "system.internal-error", retryable: true };
}

function stableFailureCode(code: string): DevelopmentFailureCode {
  if (code === "event.payload-invalid") return code;
  if (code === "project.config-invalid" || code === "project.capability-unresolved") return code;
  if (
    code === "workspace.allocation-failed" ||
    code === "workspace.branch-conflict" ||
    code === "workspace.concurrency-limit" ||
    code === "workspace.path-violation" ||
    code === "workspace.lease-not-found" ||
    code === "workspace.release-failed"
  ) {
    return code;
  }
  if (
    code === "git.base-not-found" ||
    code === "git.validation-failed" ||
    code === "git.no-changes" ||
    code === "git.commit-failed" ||
    code === "git.push-failed"
  ) {
    return code;
  }
  if (code === "agent.run-failed" || code === "agent.run-timed-out") return code;
  if (code === "agent.run-cancelled") return code;
  return "system.internal-error";
}

function failureMessage(ctx: ModuleHandlerContext, code: DevelopmentFailureCode): string {
  const prefix = `Project ${ctx.projectId} / Module ${ctx.moduleInstanceId}`;
  switch (code) {
    case "event.payload-invalid":
      return `${prefix} received an invalid implementation request; correct the Work Item, repository, and base branch, then retry.`;
    case "project.config-invalid":
      return `${prefix} has invalid configuration; correct the Validation Plan or Git policy, then retry.`;
    case "project.capability-unresolved":
      return `${prefix} cannot resolve a required capability; repair the Project binding and activate it again.`;
    case "git.validation-failed":
      return `${prefix} validation failed; fix the first failing Project command and retry.`;
    case "git.no-changes":
      return `${prefix} produced no changes; update the Work Item or agent instructions and retry.`;
    case "git.commit-failed":
      return `${prefix} could not create a commit; inspect the retained workspace and retry.`;
    case "git.push-failed":
      return `${prefix} could not push the branch; verify the configured remote and retry.`;
    case "agent.run-failed":
      return `${prefix} agent run failed; inspect the retained workspace and retry.`;
    case "agent.run-timed-out":
      return `${prefix} agent run timed out; increase the timeout or reduce the Work Item scope, then retry.`;
    case "agent.run-cancelled":
      return `${prefix} implementation was cancelled; start a new run when ready.`;
    case "system.internal-error":
      return `${prefix} encountered an internal failure; inspect engine diagnostics and retry.`;
    default:
      return `${prefix} workspace operation failed; inspect the retained workspace and retry.`;
  }
}

function safeFailureReference(
  value: unknown,
  fallback: string | undefined,
  defaultValue: string,
  maximumLength = 2_048,
): string {
  const candidate = typeof value === "string" && value.trim() !== "" ? value : fallback;
  if (candidate === undefined || candidate.trim() === "") return defaultValue;
  let safe = candidate.trim().replace(/\s+/g, " ");
  for (const secret of processSecretValues()) safe = safe.replaceAll(secret, "<redacted>");
  if (isMachineAbsolutePath(safe)) return defaultValue;
  return safe.slice(0, maximumLength) || defaultValue;
}

function isMachineAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function publishDevelopmentOutputs(
  ctx: ModuleHandlerContext,
  request: ImplementationRequest,
  result: AgentRunResult & { readonly summary: string },
  commit: { readonly branch: string; readonly sha: string },
  validation: DevelopmentRunResult["validation"],
): void {
  const subject = {
    type: "pushed-branch",
    ref: `git://${request.repositoryId}/${commit.branch}`,
  };
  const completedPayload = {
    workItemRef: request.workItemRef,
    repositoryId: request.repositoryId,
    baseBranch: request.baseBranch,
    headBranch: commit.branch,
    headCommit: commit.sha,
    validation: { passed: true, commands: validation },
    summary: result.summary.slice(0, 4_000),
  };

  ctx.publish({
    ...DEVELOPMENT_IMPLEMENTATION_COMPLETED,
    subject,
    repositoryId: request.repositoryId,
    payload: completedPayload,
  });
  ctx.publish({
    ...CHANGE_REQUEST_CREATION_REQUESTED,
    subject,
    repositoryId: request.repositoryId,
    target: { binding: "sourceControl" },
    idempotencyKey: buildChangeRequestIdempotencyKey(
      ctx.projectId,
      request.repositoryId,
      request.workItemRef,
      commit.sha,
    ),
    payload: {
      repositoryId: request.repositoryId,
      workItemRef: request.workItemRef,
      baseBranch: request.baseBranch,
      headBranch: commit.branch,
      headCommit: commit.sha,
      title: `Implement ${branchValue(request.workItemRef)}`.slice(0, 256),
      description: `Implements Work Item ${request.workItemRef}.`,
    },
  });
}

export function buildChangeRequestIdempotencyKey(
  projectId: string,
  repositoryId: string,
  workItemRef: string,
  headCommit: string,
): string {
  const material = [projectId, repositoryId, workItemRef, headCommit].join("\0");
  return `change-request:${createHash("sha256").update(material).digest("hex")}`;
}

async function runValidationPlan(input: {
  readonly order: readonly ValidationCheck[];
  readonly commands: ProjectCommandsCapability["commands"];
  readonly shell: ModuleShell;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
  readonly nextCheckpointSequence: () => number;
  readonly recordCheckpoint: ModuleHandlerContext["recordCheckpoint"];
}): Promise<DevelopmentRunResult["validation"]> {
  const passed: Array<DevelopmentRunResult["validation"][number]> = [];
  for (const check of input.order) {
    const command = input.commands[check];
    if (typeof command !== "string" || command.trim() === "") {
      throw new DevelopmentExecutionError(
        "project.config-invalid",
        `Project command "${check}" is required by the Validation Plan but is not declared.`,
      );
    }
    input.recordCheckpoint({
      type: "validation.started",
      sequence: input.nextCheckpointSequence(),
      timestamp: new Date().toISOString(),
      check,
    });
    const startedAt = Date.now();
    const result = await input.shell.run({
      command,
      cwd: input.cwd,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      outputLimitBytes: input.outputLimitBytes,
    });
    if (!result.ok) {
      input.recordCheckpoint({
        type: "validation.failed",
        sequence: input.nextCheckpointSequence(),
        timestamp: new Date().toISOString(),
        check,
        output: validationOutput(result, input.outputLimitBytes),
      });
      throw new DevelopmentExecutionError(
        "git.validation-failed",
        `Project command "${check}" failed (${result.code}).`,
      );
    }
    passed.push({ name: check, status: "passed", durationMs: Math.max(0, Date.now() - startedAt) });
  }
  return passed;
}

function readValidationOrder(value: unknown): readonly ValidationCheck[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || !isValidationCheck(item))
  ) {
    throw new DevelopmentExecutionError(
      "project.config-invalid",
      "Development validationOrder must contain only declared validation checks.",
    );
  }
  return value as readonly ValidationCheck[];
}

function isValidationCheck(value: string): value is ValidationCheck {
  return (VALIDATION_CHECKS as readonly string[]).includes(value);
}

function validationOutput(
  result: Extract<ModuleShellCommandResult, { readonly ok: false }>,
  limitBytes: number,
): string {
  const output = [result.stdout, result.stderr].filter((part) => part !== "").join("\n");
  const bytes = Buffer.from(output, "utf8");
  if (bytes.byteLength <= limitBytes) return output;
  const marker = "\n[output truncated]\n";
  const contentLimit = Math.max(0, limitBytes - Buffer.byteLength(marker));
  return `${bytes.subarray(0, contentLimit).toString("utf8")}${marker}`;
}

async function createCommit(input: {
  readonly workspacePath: string;
  readonly baseRevisionSha: string;
  readonly workItemRef: string;
  readonly commitStrategy: "conventional" | "ticket-prefix" | "freeform";
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
}): Promise<{ readonly branch: string; readonly sha: string }> {
  const git = new GitRunner({
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
    outputLimitBytes: input.outputLimitBytes,
  });
  const options = { signal: input.signal };
  const commitsBefore = await git.run(
    ["rev-list", "--count", `${input.baseRevisionSha}..HEAD`],
    options,
  );
  if (!commitsBefore.ok) throwCommitFailure(commitsBefore, "inspect existing commits");
  if (commitsBefore.stdout.trim() !== "0") {
    throw new DevelopmentExecutionError(
      "git.commit-failed",
      "The Agent Runtime created a commit before the Development commit.",
    );
  }

  const staged = await git.run(["add", "--all"], options);
  if (!staged.ok) throwCommitFailure(staged, "stage the worktree");

  const changes = await git.run(["diff", "--cached", "--quiet"], options);
  if (changes.ok) {
    throw new DevelopmentExecutionError(
      "git.no-changes",
      "The Agent Runtime left the worktree with no changes to commit.",
    );
  }
  if (changes.code !== "git.non-zero-exit") throwCommitFailure(changes, "inspect staged changes");

  const committed = await git.run(
    [
      "-c",
      "user.name=Jarvis",
      "-c",
      "user.email=jarvis@localhost",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--no-gpg-sign",
      "--author=Jarvis <jarvis@localhost>",
      "-m",
      commitMessage(input.commitStrategy, input.workItemRef),
    ],
    options,
  );
  if (!committed.ok) throwCommitFailure(committed, "create the commit");

  const branch = await git.run(["branch", "--show-current"], options);
  if (!branch.ok) throwCommitFailure(branch, "read the working branch");
  const branchName = branch.stdout.trim();
  if (branchName === "") {
    throw new DevelopmentExecutionError(
      "git.commit-failed",
      "The committed worktree has no branch.",
    );
  }

  const head = await git.run(["rev-parse", "HEAD"], options);
  if (!head.ok) throwCommitFailure(head, "read the commit SHA");
  const sha = head.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new DevelopmentExecutionError("git.commit-failed", "Git returned an invalid commit SHA.");
  }

  const commitsAfter = await git.run(
    ["rev-list", "--count", `${input.baseRevisionSha}..HEAD`],
    options,
  );
  if (!commitsAfter.ok) throwCommitFailure(commitsAfter, "verify the commit history");
  if (commitsAfter.stdout.trim() !== "1") {
    throw new DevelopmentExecutionError(
      "git.commit-failed",
      "The working branch does not contain exactly one new commit.",
    );
  }
  return { branch: branchName, sha };
}

async function pushBranch(input: {
  readonly workspacePath: string;
  readonly branch: string;
  readonly sha: string;
  readonly pushRemote: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
}): Promise<void> {
  const remote = input.pushRemote.trim();
  if (remote === "" || remote.startsWith("-") || /\s/.test(remote)) {
    throw new DevelopmentExecutionError(
      "project.config-invalid",
      "The Project push remote is invalid.",
    );
  }
  const git = new GitRunner({
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
    outputLimitBytes: input.outputLimitBytes,
  });
  const options = { signal: input.signal };
  const pushed = await git.run(["push", "--set-upstream", remote, input.branch], options);
  if (!pushed.ok) throwPushFailure(pushed, "push the working branch");

  const remoteHead = await git.run(
    ["ls-remote", "--heads", remote, `refs/heads/${input.branch}`],
    options,
  );
  if (!remoteHead.ok) throwPushFailure(remoteHead, "verify the pushed branch");
  const [remoteSha, remoteRef] = remoteHead.stdout.trim().split(/\s+/);
  if (remoteSha !== input.sha || remoteRef !== `refs/heads/${input.branch}`) {
    throw new DevelopmentExecutionError(
      "git.push-failed",
      "The configured remote does not point to the committed working branch.",
      true,
    );
  }
}

function commitMessage(
  strategy: "conventional" | "ticket-prefix" | "freeform",
  workItemRef: string,
): string {
  const subject = branchValue(workItemRef);
  const reference = workItemRef.replace(/\s+/g, " ").trim();
  const title =
    strategy === "conventional"
      ? `feat: implement ${subject}`
      : strategy === "ticket-prefix"
        ? `${subject}: implement`
        : `Implement ${subject}`;
  return `${title}\n\nWork Item: ${reference}`;
}

function throwCommitFailure(
  result: Exclude<GitCommandResult, { readonly ok: true }>,
  operation: string,
): never {
  throw new DevelopmentExecutionError(
    "git.commit-failed",
    `Git could not ${operation}.`,
    ["git.executable-not-found", "git.spawn-failed", "git.timed-out"].includes(result.code),
  );
}

function throwPushFailure(
  result: Exclude<GitCommandResult, { readonly ok: true }>,
  operation: string,
): never {
  throw new DevelopmentExecutionError(
    "git.push-failed",
    `Git could not ${operation}.`,
    result.code !== "git.cancelled",
  );
}

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
    throw new DevelopmentExecutionError(
      "event.payload-invalid",
      "The implementation request payload is invalid.",
    );
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
