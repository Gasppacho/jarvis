import { lstatSync, readdirSync, realpathSync, type Dirent } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { SystemClock, type Clock } from "../../kernel/src/clock.js";
import { GitRunner } from "./git-runner.js";
import { WorkspaceLeaseRepository, type WorkspaceLease } from "./lease-repository.js";
import { WorkspaceManager, type WorkspaceManagerOptions } from "./workspace-manager.js";

export interface WorkspaceReconciliationProject {
  readonly id: string;
  readonly repositoryPath: string;
}

export type WorkspaceReconciliationCode =
  | "workspace.reconciliation.active-lease-closed"
  | "workspace.reconciliation.expired-retained-lease-closed"
  | "workspace.reconciliation.retained-lease-kept"
  | "workspace.reconciliation.lease-without-directory-closed"
  | "workspace.reconciliation.orphan-directory-removed"
  | "workspace.reconciliation.path-unsafe"
  | "workspace.reconciliation.lease-cleanup-failed"
  | "workspace.reconciliation.orphan-removal-failed"
  | "workspace.reconciliation.repository-unavailable"
  | "workspace.reconciliation.git-prune-failed"
  | "workspace.reconciliation.git-pruned"
  | "workspace.reconciliation.project-failed";

export interface WorkspaceProjectReconciliationReport {
  readonly projectId: string;
  readonly counts: Readonly<Partial<Record<WorkspaceReconciliationCode, number>>>;
}

export interface WorkspaceReconciliationReport {
  readonly projects: readonly WorkspaceProjectReconciliationReport[];
}

interface ReconciliationProject {
  readonly id: string;
  readonly repositoryPath?: string;
}

const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/**
 * Startup is the only reliable owner-death boundary: an active lease cannot
 * belong to the new engine process. The Manager owns all destructive cleanup;
 * this class only coordinates projects and records path-free diagnostics.
 */
export class WorkspaceReconciler {
  private readonly dataRoot: string;
  private readonly clock: Clock;
  private readonly manager: WorkspaceManager;

  public constructor(
    private readonly options: WorkspaceManagerOptions,
  ) {
    this.clock = options.clock ?? new SystemClock();
    this.manager = new WorkspaceManager(options);
    this.dataRoot = realpathSync(resolve(options.dataRoot));
  }

  public async reconcile(
    configuredProjects: readonly WorkspaceReconciliationProject[],
  ): Promise<WorkspaceReconciliationReport> {
    const projects = new Map<string, ReconciliationProject>();
    for (const project of configuredProjects) projects.set(project.id, project);
    for (const projectId of this.projectDirectories()) {
      if (!projects.has(projectId)) projects.set(projectId, { id: projectId });
    }

    const reports: WorkspaceProjectReconciliationReport[] = [];
    for (const project of [...projects.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      const counts: Partial<Record<WorkspaceReconciliationCode, number>> = {};
      try {
        await this.reconcileProject(project, counts);
      } catch {
        increment(counts, "workspace.reconciliation.project-failed");
      }
      reports.push({ projectId: project.id, counts });
    }
    return { projects: reports };
  }

  private async reconcileProject(
    project: ReconciliationProject,
    counts: Partial<Record<WorkspaceReconciliationCode, number>>,
  ): Promise<void> {
    if (!SAFE_IDENTIFIER.test(project.id)) {
      increment(counts, "workspace.reconciliation.path-unsafe");
      return;
    }

    const workspaceRoot = this.manager.workspaceRoot(project.id);
    const rootState = safeDirectory(workspaceRoot);
    const leases = this.options.leases.listOpen(project.id);
    if (rootState === "unsafe") {
      increment(counts, "workspace.reconciliation.path-unsafe");
      return;
    }

    const expected = new Set<string>();
    for (const lease of leases) {
      const workspacePath = resolve(lease.workspacePath);
      if (workspacePath === workspaceRoot || !isContained(workspaceRoot, workspacePath)) {
        increment(counts, "workspace.reconciliation.path-unsafe");
        continue;
      }

      expected.add(workspacePath);
      const pathState =
        rootState === "missing" ? "missing" : safePath(workspaceRoot, workspacePath);
      const expired = lease.status === "retained" && this.isExpired(lease);
      if (lease.status === "retained" && !expired && pathState === "present") {
        increment(counts, "workspace.reconciliation.retained-lease-kept");
        continue;
      }
      if (pathState === "unsafe") {
        increment(counts, "workspace.reconciliation.path-unsafe");
        continue;
      }

      try {
        await this.manager.reconcileLease({ lease, repositoryPath: project.repositoryPath ?? "" });
        increment(
          counts,
          pathState === "missing"
            ? "workspace.reconciliation.lease-without-directory-closed"
            : lease.status === "active"
              ? "workspace.reconciliation.active-lease-closed"
              : "workspace.reconciliation.expired-retained-lease-closed",
        );
      } catch {
        increment(counts, "workspace.reconciliation.lease-cleanup-failed");
      }
    }

    if (rootState === "present") {
      const children = readChildren(workspaceRoot);
      if (children === undefined) {
        increment(counts, "workspace.reconciliation.path-unsafe");
      } else {
        for (const entry of children) {
          const target = resolve(workspaceRoot, entry.name);
          if (expected.has(target)) continue;
          if (entry.isSymbolicLink()) {
            increment(counts, "workspace.reconciliation.path-unsafe");
            continue;
          }
          if (!entry.isDirectory()) continue;
          try {
            this.manager.removeOrphanedWorkspace(project.id, target);
            increment(counts, "workspace.reconciliation.orphan-directory-removed");
          } catch {
            increment(counts, "workspace.reconciliation.orphan-removal-failed");
          }
        }
      }
    }

    await this.prune(project, counts);
  }

  private async prune(
    project: ReconciliationProject,
    counts: Partial<Record<WorkspaceReconciliationCode, number>>,
  ): Promise<void> {
    if (project.repositoryPath === undefined) return;
    const result = await new GitRunner({
      cwd: project.repositoryPath,
      ...(this.options.gitExecutable === undefined
        ? {}
        : { executablePath: this.options.gitExecutable }),
    }).run(["worktree", "prune", "--expire", "now"]);
    if (result.ok) {
      increment(counts, "workspace.reconciliation.git-pruned");
      return;
    }
    increment(
      counts,
      result.code === "git.invalid-working-directory"
        ? "workspace.reconciliation.repository-unavailable"
        : "workspace.reconciliation.git-prune-failed",
    );
  }

  private isExpired(lease: WorkspaceLease): boolean {
    const expiry = Date.parse(lease.expiresAt);
    return !Number.isFinite(expiry) || expiry <= this.clock.now().getTime();
  }

  private projectDirectories(): string[] {
    const projectsRoot = resolve(this.dataRoot, "projects");
    if (safeDirectory(projectsRoot) !== "present") return [];
    try {
      return readdirSync(projectsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && SAFE_IDENTIFIER.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }
}

function increment(
  counts: Partial<Record<WorkspaceReconciliationCode, number>>,
  code: WorkspaceReconciliationCode,
): void {
  counts[code] = (counts[code] ?? 0) + 1;
}

function safeDirectory(path: string): "missing" | "present" | "unsafe" {
  try {
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink() || realpathSync(path) !== path)
      return "unsafe";
    return "present";
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT" ? "missing" : "unsafe";
  }
}

function safePath(root: string, path: string): "missing" | "present" | "unsafe" {
  try {
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return "unsafe";
    return isContained(root, realpathSync(path)) ? "present" : "unsafe";
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT" ? "missing" : "unsafe";
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function readChildren(root: string): Dirent[] | undefined {
  try {
    return readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
