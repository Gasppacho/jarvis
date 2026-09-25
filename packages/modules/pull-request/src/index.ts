import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentRunResult, AgentRuntime } from "../../../agent-runtime/src/index.js";
import {
  buildAgentRunRequest,
  secretEnvironmentValues,
} from "../../../agent-runtime/src/request-builder.js";
import type {
  ModuleHandlerContext,
  ModuleWorkspaceAllocation,
  WorkItem,
} from "../../../module-sdk/src/index.js";
import { GitRunner } from "../../../workspace/src/git-runner.js";

export const pullRequestModulePackage = {
  id: "jarvis.module.pull-request",
  version: "1.0.0",
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

const BRANCH_PATTERN = "jarvis/pr/{workItemId}-{slug}";
const MAX_CONCURRENT_EXECUTIONS = 2;
const RETAIN_ON_FAILURE_DAYS = 7;
const MAX_DIFF_BYTES = 96 * 1024;
const MAX_WORK_ITEM_BYTES = 48 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_TITLE_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 20_000;

interface DevelopmentCompletion {
  readonly workItemRef: string;
  readonly repositoryId: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly headCommit: string;
  readonly summary: string;
}

interface PullRequestContent {
  readonly title: string;
  readonly description: string;
}

export const handleImplementationCompleted = async (ctx: ModuleHandlerContext): Promise<void> => {
  const completion = readCompletion(ctx.event.payload);
  const workItemReference = parseGitHubWorkItemRef(completion.workItemRef);
  if (
    ctx.repositoryId !== completion.repositoryId ||
    ctx.repository?.provider !== "github" ||
    ctx.repository.owner.toLowerCase() !== workItemReference.owner.toLowerCase() ||
    ctx.repository.name.toLowerCase() !== workItemReference.repository.toLowerCase()
  ) {
    throw new Error("The completed work item does not belong to this Project repository.");
  }

  const workspace = ctx.capabilities.workspace;
  const workItems = ctx.capabilities.workItems;
  const githubApi = ctx.capabilities.githubApi;
  const runtime = ctx.capabilities.agentRuntime;
  const projectBindings = ctx.capabilities.projectBindings;
  if (
    workspace === undefined ||
    workItems === undefined ||
    githubApi === undefined ||
    runtime === undefined ||
    projectBindings === undefined
  ) {
    throw new Error(
      "Pull Request requires project-bound GitHub API, workspace, Work Item, and Agent Runtime access.",
    );
  }

  const [item, defaultBranch] = await Promise.all([
    workItems.read(completion.workItemRef, completion.repositoryId),
    readGitHubDefaultBranch(githubApi, workItemReference),
  ]);
  if (item.ref !== completion.workItemRef || item.number !== workItemReference.number) {
    throw new Error("The Work Item provider returned a different issue than requested.");
  }

  const recovered = await recoverWorkspace(workspace, ctx);
  const allocation =
    recovered?.retained === true
      ? recovered
      : await workspace.allocate({
          executionId: ctx.executionId,
          repositoryId: completion.repositoryId,
          baseRevision: completion.headCommit,
          branchContext: {
            workItemId: String(workItemReference.number),
            slug: branchSlug(item.title),
          },
          policy: {
            branchPattern: BRANCH_PATTERN,
            maxConcurrentExecutions: MAX_CONCURRENT_EXECUTIONS,
            retainOnFailureDays: RETAIN_ON_FAILURE_DAYS,
          },
        });

  let released = false;
  let releaseOutcome: "success" | "failure" | "cancelled" = "failure";
  try {
    const diff = await readCommitDiff(allocation.path, completion.headCommit, ctx.signal);
    await verifyWorkspace(allocation.path, completion.headCommit, ctx.signal);

    const attempt = await generatePullRequestContent({
      ctx,
      allocation,
      runtime,
      projectBindings,
      item,
      completion,
      baseBranch: defaultBranch,
      diff,
    });
    if (attempt.status !== "completed") {
      throw new Error("The Agent Runtime did not complete Pull Request preparation.");
    }
    if (attempt.changedFiles.length > 0) {
      throw new Error("The Agent Runtime modified the Pull Request workspace.");
    }
    await verifyWorkspace(allocation.path, completion.headCommit, ctx.signal);

    const content = readPullRequestContent(attempt.summary);
    const description = withIssueLink(content.description, workItemReference.number);

    await workspace.release({
      executionId: ctx.executionId,
      outcome: "success",
      policy: { retainOnFailureDays: RETAIN_ON_FAILURE_DAYS },
    });
    released = true;
    releaseOutcome = "success";

    ctx.publish({
      ...CHANGE_REQUEST_CREATION_REQUESTED,
      subject: {
        type: "pushed-branch",
        ref: `git://${completion.repositoryId}/${completion.headBranch}`,
      },
      repositoryId: completion.repositoryId,
      target: { binding: "sourceControl" },
      idempotencyKey: creationIdempotencyKey(ctx.projectId, completion),
      payload: {
        repositoryId: completion.repositoryId,
        workItemRef: completion.workItemRef,
        baseBranch: defaultBranch,
        headBranch: completion.headBranch,
        headCommit: completion.headCommit,
        title: content.title,
        description,
      },
    });
  } catch (error) {
    releaseOutcome = ctx.signal.aborted ? "cancelled" : "failure";
    throw error;
  } finally {
    if (!released) {
      await workspace.release({
        executionId: ctx.executionId,
        outcome: releaseOutcome,
        policy: { retainOnFailureDays: RETAIN_ON_FAILURE_DAYS },
      });
    }
  }
};

async function generatePullRequestContent(input: {
  readonly ctx: ModuleHandlerContext;
  readonly allocation: ModuleWorkspaceAllocation;
  readonly runtime: AgentRuntime;
  readonly projectBindings: NonNullable<ModuleHandlerContext["capabilities"]["projectBindings"]>;
  readonly item: WorkItem;
  readonly completion: DevelopmentCompletion;
  readonly baseBranch: string;
  readonly diff: string;
}): Promise<AgentRunResult> {
  const runtimeGrant =
    input.ctx.capabilities.revalidateAgentRuntime === undefined
      ? { runtime: input.runtime, projectBindings: input.projectBindings }
      : input.ctx.capabilities.revalidateAgentRuntime();
  if (runtimeGrant === undefined) {
    throw new Error("The project Agent Runtime grant is no longer available; rerun preflight.");
  }

  const objective =
    "Prepare a Pull Request for the supplied work item and commit diff.\n" +
    `Return only JSON with string fields \"title\" and \"description\".\n` +
    `Do not modify files, commit, push, or add GitHub issue-closing keywords.`;
  const ticketContent = [
    `Issue ${input.item.number}: ${input.item.title}`,
    input.item.body.slice(0, MAX_WORK_ITEM_BYTES),
    `Development summary: ${input.completion.summary ?? ""}`,
    `Pushed commit: ${input.completion.headCommit}`,
    `Target branch: ${input.baseBranch}`,
    input.diff,
  ].join("\n\n");
  const instructions = await repositoryInstructions(input.allocation.path);
  const agentRequest = buildAgentRunRequest({
    projectId: input.ctx.projectId,
    executionId: input.ctx.executionId,
    workingDirectory: input.allocation.path,
    objective,
    prompt: {
      moduleContract:
        "Write a concise, accurate Pull Request title and Markdown description using the issue and commit diff. The description must explain what changed and why. Do not add any issue-closing command; Jarvis adds the appropriate issue link after checking the target branch.",
      projectConfiguration: JSON.stringify(input.ctx.configuration),
      repositoryInstructions: instructions,
      ticketContent,
    },
    environmentAllowlist: Object.keys(
      runtimeGrant.projectBindings.runtimeSlot === undefined
        ? {}
        : (runtimeGrant.projectBindings.slots[runtimeGrant.projectBindings.runtimeSlot]
            ?.environment ?? {}),
    ),
    projectBindings: runtimeGrant.projectBindings,
    mcpSlotNames: [],
    timeoutMs: 300_000,
    outputLimitBytes: MAX_OUTPUT_BYTES,
    secretValues: secretEnvironmentValues(process.env),
  });

  let sequence = input.ctx.lastCheckpointSequence?.() ?? 0;
  const run = await runtimeGrant.runtime.start(agentRequest, input.ctx.signal);
  try {
    for await (const event of run.events()) {
      if (event.type === "started") {
        input.ctx.recordCheckpoint({
          type: "agent.started",
          sequence: ++sequence,
          timestamp: event.timestamp,
        });
      } else if (event.type === "message" && event.message !== undefined) {
        input.ctx.recordCheckpoint({
          type: "agent.message",
          sequence: ++sequence,
          timestamp: event.timestamp,
          message: event.message,
        });
      }
    }
    return await run.result();
  } catch (error) {
    await run.interrupt().catch(() => undefined);
    throw error;
  }
}

async function recoverWorkspace(
  workspace: NonNullable<ModuleHandlerContext["capabilities"]["workspace"]>,
  ctx: ModuleHandlerContext,
): Promise<(ModuleWorkspaceAllocation & { readonly retained: boolean }) | undefined> {
  if (workspace.recover === undefined) return undefined;
  try {
    return await workspace.recover({
      executionId: ctx.executionId,
      repositoryId: ctx.repositoryId ?? "",
    });
  } catch {
    return undefined;
  }
}

async function readCommitDiff(cwd: string, commit: string, signal: AbortSignal): Promise<string> {
  const result = await new GitRunner({ cwd, outputLimitBytes: MAX_DIFF_BYTES }).run(
    ["show", "--format=fuller", "--stat", "--patch", commit],
    { signal, outputLimitBytes: MAX_DIFF_BYTES },
  );
  if (!result.ok) throw new Error("Could not read the pushed Development commit diff.");
  return result.outputTruncated
    ? `${result.stdout}\n[Diff output clipped; inspect the complete commit in this workspace.]`
    : result.stdout;
}

async function verifyWorkspace(
  cwd: string,
  expectedCommit: string,
  signal: AbortSignal,
): Promise<void> {
  const git = new GitRunner({ cwd });
  const head = await git.run(["rev-parse", "HEAD"], { signal });
  const status = await git.run(["status", "--porcelain", "--untracked-files=all"], { signal });
  if (!head.ok || !status.ok || head.stdout.trim().toLowerCase() !== expectedCommit.toLowerCase()) {
    throw new Error(
      "The Pull Request workspace no longer matches the completed Development commit.",
    );
  }
  if (status.stdout.trim() !== "") {
    throw new Error("The Pull Request workspace contains uncommitted changes.");
  }
}

async function repositoryInstructions(cwd: string): Promise<string> {
  try {
    return (await readFile(resolve(cwd, "AGENTS.md"), "utf8")).slice(0, MAX_WORK_ITEM_BYTES);
  } catch {
    return "No root AGENTS.md instructions were found.";
  }
}

function readCompletion(payload: Readonly<Record<string, unknown>>): DevelopmentCompletion {
  const workItemRef = stringValue(payload, "workItemRef");
  const repositoryId = stringValue(payload, "repositoryId");
  const baseBranch = stringValue(payload, "baseBranch");
  const headBranch = stringValue(payload, "headBranch");
  const headCommit = stringValue(payload, "headCommit");
  const summary = typeof payload["summary"] === "string" ? payload["summary"] : "";
  if (
    workItemRef === undefined ||
    repositoryId === undefined ||
    baseBranch === undefined ||
    headBranch === undefined ||
    headCommit === undefined ||
    !/^[0-9a-f]{7,128}$/i.test(headCommit)
  ) {
    throw new Error("The Development completion event is invalid.");
  }
  return { workItemRef, repositoryId, baseBranch, headBranch, headCommit, summary };
}

function parseGitHubWorkItemRef(ref: string): {
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
} {
  const match = /^github:\/\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)$/.exec(ref);
  const number = Number(match?.[3]);
  if (match === null || !Number.isSafeInteger(number)) {
    throw new Error("Pull Request requires a GitHub Issue Work Item.");
  }
  return { owner: match[1]!, repository: match[2]!, number };
}

function readPullRequestContent(summary: string): PullRequestContent {
  let value: unknown;
  try {
    value = JSON.parse(summary) as unknown;
  } catch {
    throw new Error(
      "The Agent Runtime must return JSON with a Pull Request title and description.",
    );
  }
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["title", "description"].includes(key))
  ) {
    throw new Error("The Agent Runtime returned invalid Pull Request content.");
  }
  const title = typeof value["title"] === "string" ? value["title"].trim() : "";
  const description = typeof value["description"] === "string" ? value["description"].trim() : "";
  if (
    title.length === 0 ||
    title.length > MAX_TITLE_LENGTH ||
    description.length === 0 ||
    description.length > MAX_DESCRIPTION_LENGTH ||
    containsIssueClosingKeyword(description)
  ) {
    throw new Error(
      "The Agent Runtime returned invalid Pull Request title or description content.",
    );
  }
  return { title, description };
}

function withIssueLink(description: string, issueNumber: number): string {
  const result = `${description}\n\nCloses #${issueNumber}`;
  if (result.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error("The Pull Request description exceeds GitHub's size limit.");
  }
  return result;
}

async function readGitHubDefaultBranch(
  api: NonNullable<ModuleHandlerContext["capabilities"]["githubApi"]>,
  reference: ReturnType<typeof parseGitHubWorkItemRef>,
): Promise<string> {
  let response: Awaited<ReturnType<typeof api.get>>;
  try {
    response = await api.get(`/repos/${reference.owner}/${reference.repository}`);
  } catch {
    throw new Error("GitHub repository default branch could not be read.");
  }
  if (response.status < 200 || response.status >= 300 || !isRecord(response.body)) {
    throw new Error("GitHub repository default branch could not be read.");
  }
  const defaultBranch = response.body["default_branch"];
  if (typeof defaultBranch !== "string" || defaultBranch.trim() === "") {
    throw new Error("GitHub repository default branch is missing.");
  }
  return defaultBranch;
}

function containsIssueClosingKeyword(value: string): boolean {
  return /\b(?:close[sd]?|fix(?:es)?|resolve[sd]?)\s+(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+\b/i.test(
    value,
  );
}

function creationIdempotencyKey(projectId: string, completion: DevelopmentCompletion): string {
  const material = [
    projectId,
    completion.repositoryId,
    completion.workItemRef,
    completion.headCommit,
  ].join("\0");
  return `pull-request:${createHash("sha256").update(material).digest("hex")}`;
}

function branchSlug(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "work-item";
}

function stringValue(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
