import { lstatSync, mkdirSync, realpathSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { SystemClock, type Clock } from "../../kernel/src/clock.js";
import { GitRunner, type GitCommandResult } from "./git-runner.js";
import {
  WorkspaceLeaseRepository,
  type WorkspaceLease,
  type WorkspaceLeaseClaim,
} from "./lease-repository.js";

export interface WorkspaceProjectConfiguration {
  readonly git: { readonly branchPattern: string };
  readonly workspace: {
    readonly maxConcurrentExecutions: number;
    readonly retainOnFailureDays: number;
  };
}

export interface WorkspaceBranchContext {
  readonly workItemId: string;
  readonly slug: string;
}

export interface WorkspaceManagerOptions {
  readonly dataRoot: string;
  readonly leases: WorkspaceLeaseRepository;
  readonly clock?: Clock;
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

export type WorkspaceReleaseOutcome = "success" | "failure" | "cancelled";

export interface ReleaseWorkspaceInput {
  readonly projectId: string;
  readonly executionId: string;
  readonly repositoryPath: string;
  readonly project: WorkspaceProjectConfiguration;
  readonly outcome: WorkspaceReleaseOutcome;
}

export type WorkspaceAllocationErrorCode =
  | "workspace.path-violation"
  | "workspace.allocation-failed"
  | "workspace.branch-conflict"
  | "workspace.concurrency-limit"
  | "git.base-not-found";

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

export type WorkspaceReleaseErrorCode =
  "workspace.path-violation" | "workspace.lease-not-found" | "workspace.release-failed";

export class WorkspaceReleaseError extends Error {
  public constructor(
    public readonly code: WorkspaceReleaseErrorCode,
    message: string,
    options: WorkspaceAllocationErrorOptions = {},
  ) {
    super(message);
    this.name = "WorkspaceReleaseError";
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
  private readonly clock: Clock;

  public constructor(private readonly options: WorkspaceManagerOptions) {
    this.clock = options.clock ?? new SystemClock();
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

    if (
      !Number.isInteger(input.project.workspace.maxConcurrentExecutions) ||
      input.project.workspace.maxConcurrentExecutions < 1
    ) {
      throw new WorkspaceAllocationError(
        "workspace.allocation-failed",
        "The project workspace concurrency limit is invalid.",
      );
    }
    const existing = this.options.leases.findActiveByExecution(input.projectId, input.executionId);
    if (existing !== undefined) return allocationFromLease(existing);

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

    let claim: WorkspaceLeaseClaim;
    try {
      claim = this.options.leases.claim(
        {
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
        },
        input.project.workspace.maxConcurrentExecutions,
      );
    } catch {
      throw new WorkspaceAllocationError(
        "workspace.allocation-failed",
        "The workspace lease could not be claimed.",
        { details: { operation: "claim-lease" }, retryable: true },
      );
    }

    if (claim.kind === "existing") return allocationFromLease(claim.lease);
    if (claim.kind === "branch-conflict") {
      throw new WorkspaceAllocationError(
        "workspace.branch-conflict",
        "The working branch is already leased by another execution.",
        {
          details: { repositoryId: input.repositoryId, workingBranch },
          retryable: false,
        },
      );
    }
    if (claim.kind === "concurrency-limit") {
      throw new WorkspaceAllocationError(
        "workspace.concurrency-limit",
        `The project workspace concurrency limit is ${claim.maxConcurrentExecutions}; release an active workspace before allocating another.`,
        {
          details: { maxConcurrentExecutions: claim.maxConcurrentExecutions },
          retryable: false,
        },
      );
    }

    try {
      mkdirSync(workspaceRoot, { recursive: true });
    } catch {
      releaseLease(this.options.leases, input.projectId, claim.lease.id);
      throw new WorkspaceAllocationError(
        "workspace.allocation-failed",
        "The project workspace directory could not be prepared.",
        { details: { operation: "prepare-workspace-root" }, retryable: true },
      );
    }

    try {
      await requireGit(
        git.run([
          "worktree",
          "add",
          "--quiet",
          "-b",
          workingBranch,
          workspacePath,
          baseRevisionSha,
        ]),
        "create worktree",
      );
    } catch (error: unknown) {
      releaseLease(this.options.leases, input.projectId, claim.lease.id);
      throw error;
    }

    return allocationFromLease(claim.lease);
  }

  public async release(input: ReleaseWorkspaceInput): Promise<WorkspaceLease> {
    assertReleaseIdentifier(input.projectId, "project");
    assertReleaseIdentifier(input.executionId, "execution");
    if (!isReleaseOutcome(input.outcome)) {
      throw new WorkspaceReleaseError(
        "workspace.release-failed",
        "The workspace release outcome is invalid.",
      );
    }

    const lease = this.options.leases.findByExecution(input.projectId, input.executionId);
    if (lease === undefined) {
      throw new WorkspaceReleaseError(
        "workspace.lease-not-found",
        "The workspace lease for this execution was not found.",
      );
    }
    if (lease.status === "released") return lease;

    if (input.outcome !== "success") {
      if (lease.status === "retained") return lease;
      const retained = this.options.leases.markRetained(
        input.projectId,
        lease.id,
        retentionExpiry(this.clock, input.project.workspace.retainOnFailureDays),
      );
      if (retained === undefined) {
        throw new WorkspaceReleaseError(
          "workspace.release-failed",
          "The workspace lease could not be retained.",
          { details: { operation: "retain-lease" }, retryable: true },
        );
      }
      return retained;
    }

    const workspaceRoot = resolve(this.dataRoot, "projects", input.projectId, "workspaces");
    const workspacePath = resolve(lease.workspacePath);
    const exists = assertReleasePathIsSafe(workspaceRoot, workspacePath);
    if (exists) {
      try {
        rmSync(workspacePath, { recursive: true, force: true });
      } catch {
        throw new WorkspaceReleaseError(
          "workspace.release-failed",
          "The workspace directory could not be removed.",
          { details: { operation: "remove-workspace" }, retryable: true },
        );
      }
    }

    const git = new GitRunner({
      cwd: input.repositoryPath,
      ...(this.options.gitExecutable === undefined
        ? {}
        : { executablePath: this.options.gitExecutable }),
    });
    const prune = await git.run(["worktree", "prune", "--expire", "now"]);
    if (!prune.ok) {
      throw new WorkspaceReleaseError(
        "workspace.release-failed",
        "Git could not prune the released worktree.",
        {
          details: {
            operation: "prune-worktree",
            gitCode: prune.code,
            exitCode: prune.exitCode,
          },
          retryable: prune.code === "git.executable-not-found",
        },
      );
    }

    const released = this.options.leases.release(input.projectId, lease.id);
    if (released === undefined) {
      throw new WorkspaceReleaseError(
        "workspace.release-failed",
        "The workspace lease could not be released.",
        { details: { operation: "release-lease" }, retryable: true },
      );
    }
    return released;
  }
}

function allocationFromLease(lease: WorkspaceLease): WorkspaceAllocation {
  return {
    path: lease.workspacePath,
    workingBranch: lease.workingBranch,
    baseRevisionSha: lease.baseRevisionSha,
    lease,
  };
}

function releaseLease(leases: WorkspaceLeaseRepository, projectId: string, leaseId: string): void {
  try {
    const released = leases.release(projectId, leaseId);
    if (released?.status === "released") return;
  } catch {
    // Fall through to the typed failure below; a live leaked claim must not be hidden.
  }
  throw new WorkspaceAllocationError(
    "workspace.allocation-failed",
    "The workspace lease could not be released after allocation failed.",
    { details: { operation: "release-lease", leaseId }, retryable: true },
  );
}

function assertReleaseIdentifier(value: string, subject: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new WorkspaceReleaseError(
      "workspace.path-violation",
      `The ${subject} identifier is invalid.`,
    );
  }
}

function isReleaseOutcome(value: string): value is WorkspaceReleaseOutcome {
  return value === "success" || value === "failure" || value === "cancelled";
}

function retentionExpiry(clock: Clock, days: number): string {
  const millisecondsPerDay = 24 * 60 * 60 * 1_000;
  if (!Number.isSafeInteger(days) || days < 0) {
    throw new WorkspaceReleaseError(
      "workspace.release-failed",
      "The workspace failure retention period is invalid.",
    );
  }
  const timestamp = clock.now().getTime() + days * millisecondsPerDay;
  const expiry = new Date(timestamp);
  if (Number.isNaN(expiry.getTime())) {
    throw new WorkspaceReleaseError(
      "workspace.release-failed",
      "The workspace failure retention period is invalid.",
    );
  }
  return expiry.toISOString();
}

function assertReleasePathIsSafe(workspaceRoot: string, workspacePath: string): boolean {
  if (workspaceRoot === workspacePath || !isContained(workspaceRoot, workspacePath)) {
    throw new WorkspaceReleaseError(
      "workspace.path-violation",
      "The workspace path is outside the project workspaces root.",
    );
  }

  let rootStats;
  try {
    rootStats = lstatSync(workspaceRoot);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new WorkspaceReleaseError(
      "workspace.path-violation",
      "The project workspaces root could not be inspected.",
    );
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new WorkspaceReleaseError(
      "workspace.path-violation",
      "The project workspaces root is not a safe directory.",
    );
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(workspaceRoot);
  } catch {
    throw new WorkspaceReleaseError(
      "workspace.path-violation",
      "The project workspaces root could not be resolved.",
    );
  }
  if (canonicalRoot !== workspaceRoot) {
    throw new WorkspaceReleaseError(
      "workspace.path-violation",
      "The project workspaces root is not a safe directory.",
    );
  }

  let targetStats;
  try {
    targetStats = lstatSync(workspacePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new WorkspaceReleaseError(
      "workspace.path-violation",
      "The workspace target could not be inspected.",
    );
  }
  if (targetStats.isSymbolicLink() || !targetStats.isDirectory()) {
    throw new WorkspaceReleaseError(
      "workspace.path-violation",
      "The workspace target is not a safe directory.",
    );
  }
  let canonicalTarget: string;
  try {
    canonicalTarget = realpathSync(workspacePath);
  } catch {
    throw new WorkspaceReleaseError(
      "workspace.path-violation",
      "The workspace target could not be resolved.",
    );
  }
  if (!isContained(canonicalRoot, canonicalTarget) || canonicalTarget === canonicalRoot) {
    throw new WorkspaceReleaseError(
      "workspace.path-violation",
      "The workspace path is outside the project workspaces root.",
    );
  }
  return true;
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
