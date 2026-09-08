import { lstatSync, mkdirSync, realpathSync, readdirSync } from "node:fs";
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
  readonly gitExecutable?: string;
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
  "workspace.path-violation" | "workspace.allocation-failed" | "git.base-not-found";

export interface WorkspaceAllocationErrorOptions {
  readonly details?: Readonly<Record<string, boolean | number | string | null>>;
  readonly retryable?: boolean;
}

export class WorkspaceAllocationError extends Error {
  public constructor(
    public readonly code: WorkspaceAllocationErrorCode,
    message: string,
    options: WorkspaceAllocationErrorOptions = {},
  ) {
    super(message);
    this.name = "WorkspaceAllocationError";
    this.failureClass = "workspace";
    this.errorClass = this.failureClass;
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? false;
  }

  public readonly failureClass: "workspace";
  public readonly errorClass: "workspace";
  public readonly details: Readonly<Record<string, boolean | number | string | null>>;
  public readonly retryable: boolean;
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
    try {
      this.dataRoot = realpathSync(resolve(options.dataRoot));
    } catch {
      throw new WorkspaceAllocationError(
        "workspace.path-violation",
        "The engine data root is not available.",
      );
    }
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
          "workspace.path-violation",
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

    assertTargetPathIsSafe(workspacePath);

    const git = new GitRunner({
      cwd: input.repositoryPath,
      ...(this.options.gitExecutable === undefined
        ? {}
        : { executablePath: this.options.gitExecutable }),
    });
    await requireGit(git.run(["rev-parse", "--git-dir"]), "validate repository");
    await requireGit(git.run(["check-ref-format", "--branch", workingBranch]), "validate branch");
    const baseRevision = await requireGit(
      git.run([
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${input.baseRevision.trim()}^{commit}`,
      ]),
      "resolve base revision",
      "git.base-not-found",
    );
    const baseRevisionSha = baseRevision.stdout.trim();
    if (!SHA.test(baseRevisionSha)) {
      throw new WorkspaceAllocationError(
        "workspace.allocation-failed",
        "Git did not return a valid Base Revision SHA.",
      );
    }

    try {
      mkdirSync(workspaceRoot, { recursive: true });
    } catch {
      throw new WorkspaceAllocationError(
        "workspace.allocation-failed",
        "The project workspace directory could not be prepared.",
        { details: { operation: "prepare-workspace-root" }, retryable: true },
      );
    }

    await requireGit(
      git.run(["worktree", "add", "--quiet", "-b", workingBranch, workspacePath, baseRevisionSha]),
      "create worktree",
    );

    try {
      const lease = this.options.leases.create({
        projectId: input.projectId,
        executionId: input.executionId,
        repositoryId: input.repositoryId,
        workingBranch,
        baseRevisionSha,
        workspacePath,
        expiresAt: input.expiresAt ?? ACTIVE_LEASE_EXPIRY,
        cleanupPolicy:
          input.project.workspace.retainOnFailureDays > 0
            ? "retain-on-failure"
            : "delete-on-failure",
        ownerPid: process.pid,
      });

      return { path: workspacePath, workingBranch, baseRevisionSha, lease };
    } catch {
      const cleanup = await removeCreatedWorktree(git, workspacePath, workingBranch);
      throw new WorkspaceAllocationError(
        "workspace.allocation-failed",
        "The workspace lease could not be stored; the worktree was rolled back.",
        {
          details: {
            operation: "store-lease",
            cleanupSucceeded: cleanup,
          },
          retryable: false,
        },
      );
    }
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
  if (
    rendered.startsWith("/") ||
    rendered.split(/[\\/]/u).some((segment) => segment === "." || segment === "..")
  ) {
    throw new WorkspaceAllocationError(
      "workspace.path-violation",
      "The working branch contains an unsafe path segment.",
    );
  }
  return rendered;
}

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function requireGit(
  result: Promise<GitCommandResult>,
  operation: string,
  failureCode: WorkspaceAllocationErrorCode = "workspace.allocation-failed",
) {
  const outcome = await result;
  if (outcome.ok) return outcome;
  const code =
    failureCode === "git.base-not-found" && outcome.code === "git.non-zero-exit"
      ? failureCode
      : "workspace.allocation-failed";
  throw new WorkspaceAllocationError(code, `Git could not ${operation}.`, {
    details: {
      operation,
      gitCode: outcome.code,
      exitCode: outcome.exitCode,
    },
    retryable: outcome.code === "git.executable-not-found",
  });
}

function assertTargetPathIsSafe(workspacePath: string): void {
  let stats;
  try {
    stats = lstatSync(workspacePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new WorkspaceAllocationError(
      "workspace.path-violation",
      "The workspace target could not be inspected.",
    );
  }
  if (stats.isSymbolicLink()) {
    throw new WorkspaceAllocationError(
      "workspace.path-violation",
      "The workspace target is not a safe directory.",
    );
  }
  if (!stats.isDirectory()) {
    throw new WorkspaceAllocationError(
      "workspace.allocation-failed",
      "The workspace target is not a directory.",
    );
  }
  try {
    if (readdirSync(workspacePath).length > 0) {
      throw new WorkspaceAllocationError(
        "workspace.allocation-failed",
        "The workspace target is not empty.",
      );
    }
  } catch (error) {
    if (error instanceof WorkspaceAllocationError) throw error;
    throw new WorkspaceAllocationError(
      "workspace.path-violation",
      "The workspace target could not be inspected.",
    );
  }
}

async function removeCreatedWorktree(
  git: GitRunner,
  workspacePath: string,
  workingBranch: string,
): Promise<boolean> {
  const removed = await git.run(["worktree", "remove", "--force", workspacePath]);
  const deletedBranch = await git.run(["branch", "-D", workingBranch]);
  await git.run(["worktree", "prune", "--expire", "now"]);
  return removed.ok && deletedBranch.ok;
}
