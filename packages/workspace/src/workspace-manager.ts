import { mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { GitRunner, type GitCommandResult } from "./git-runner.js";
import { WorkspaceLeaseRepository, type WorkspaceLease } from "./lease-repository.js";

export interface WorkspaceProjectConfiguration {
  readonly git: { readonly branchPattern: string };
  readonly workspace: { readonly retainOnFailureDays: number };
}

export interface WorkspaceBranchContext {
  readonly workItemId: string;
  readonly slug: string;
}

export interface WorkspaceManagerOptions {
  readonly dataRoot: string;
  readonly leases: WorkspaceLeaseRepository;
}

export interface AllocateWorkspaceInput {
  readonly projectId: string;
  readonly executionId: string;
  readonly repositoryId: string;
  readonly repositoryPath: string;
  /** A caller must choose the revision; allocation never defaults to HEAD. */
  readonly baseRevision: string;
  /** Values are already normalized by the application boundary, not an event payload. */
  readonly branchContext: WorkspaceBranchContext;
  readonly project: WorkspaceProjectConfiguration;
  readonly expiresAt?: string;
}

export interface WorkspaceAllocation {
  readonly path: string;
  readonly workingBranch: string;
  readonly baseRevisionSha: string;
  readonly lease: WorkspaceLease;
}

export type WorkspaceAllocationErrorCode =
  "workspace.path-violation" | "workspace.allocation-failed";

export class WorkspaceAllocationError extends Error {
  public constructor(
    public readonly code: WorkspaceAllocationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceAllocationError";
  }
}

const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SAFE_BRANCH_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA = /^[0-9a-f]{40,64}$/;
const ACTIVE_LEASE_EXPIRY = "9999-12-31T23:59:59.999Z";

export class WorkspaceManager {
  private readonly dataRoot: string;

  public constructor(private readonly options: WorkspaceManagerOptions) {
    if (!isAbsolute(options.dataRoot)) {
      throw new WorkspaceAllocationError(
        "workspace.path-violation",
        "The engine data root must be an absolute path.",
      );
    }
    this.dataRoot = realpathSync(resolve(options.dataRoot));
  }

  public async allocate(input: AllocateWorkspaceInput): Promise<WorkspaceAllocation> {
    assertIdentifier(input.projectId, "project");
    assertIdentifier(input.executionId, "execution");
    if (input.baseRevision.trim().length === 0 || input.baseRevision.startsWith("-")) {
      throw new WorkspaceAllocationError(
        "workspace.allocation-failed",
        "An explicit Base Revision is required.",
      );
    }
    for (const value of Object.values(input.branchContext)) {
      if (!SAFE_BRANCH_VALUE.test(value)) {
        throw new WorkspaceAllocationError(
          "workspace.allocation-failed",
          "Branch parameters are invalid.",
        );
      }
    }

    const workingBranch = renderBranch(input.project.git.branchPattern, {
      ...input.branchContext,
      projectId: input.projectId,
      executionId: input.executionId,
    });
    const workspaceRoot = resolve(this.dataRoot, "projects", input.projectId, "workspaces");
    const workspacePath = resolve(workspaceRoot, input.executionId);
    if (!isContained(workspaceRoot, workspacePath)) {
      throw new WorkspaceAllocationError(
        "workspace.path-violation",
        "The workspace path is outside the project workspaces root.",
      );
    }

    const git = new GitRunner({ cwd: input.repositoryPath });
    await requireGit(git.run(["check-ref-format", "--branch", workingBranch]), "validate branch");
    const baseRevision = await requireGit(
      git.run([
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${input.baseRevision.trim()}^{commit}`,
      ]),
      "resolve base revision",
    );
    const baseRevisionSha = baseRevision.stdout.trim();
    if (!SHA.test(baseRevisionSha)) {
      throw new WorkspaceAllocationError(
        "workspace.allocation-failed",
        "Git did not return a valid Base Revision SHA.",
      );
    }

    mkdirSync(workspaceRoot, { recursive: true });
    await requireGit(
      git.run(["worktree", "add", "--quiet", "-b", workingBranch, workspacePath, baseRevisionSha]),
      "create worktree",
    );

    const lease = this.options.leases.create({
      projectId: input.projectId,
      executionId: input.executionId,
      repositoryId: input.repositoryId,
      workingBranch,
      baseRevisionSha,
      workspacePath,
      expiresAt: input.expiresAt ?? ACTIVE_LEASE_EXPIRY,
      cleanupPolicy:
        input.project.workspace.retainOnFailureDays > 0 ? "retain-on-failure" : "delete-on-failure",
      ownerPid: process.pid,
    });

    return { path: workspacePath, workingBranch, baseRevisionSha, lease };
  }
}

function assertIdentifier(value: string, subject: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new WorkspaceAllocationError(
      "workspace.path-violation",
      `The ${subject} identifier is invalid.`,
    );
  }
}

function renderBranch(pattern: string, values: Readonly<Record<string, string>>): string {
  const rendered = pattern.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new WorkspaceAllocationError(
        "workspace.allocation-failed",
        `The validated branch pattern contains an unresolved placeholder ${placeholder}.`,
      );
    }
    return value;
  });
  if (rendered.includes("{") || rendered.includes("}")) {
    throw new WorkspaceAllocationError(
      "workspace.allocation-failed",
      "The validated branch pattern contains invalid placeholders.",
    );
  }
  return rendered;
}

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function requireGit(result: Promise<GitCommandResult>, operation: string) {
  const outcome = await result;
  if (outcome.ok) return outcome;
  throw new WorkspaceAllocationError("workspace.allocation-failed", `Git could not ${operation}.`);
}
