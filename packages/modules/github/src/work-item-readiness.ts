import type Database from "better-sqlite3";
import type { Clock } from "../../../kernel/src/clock.js";
import type { WorkItemReadinessCapability } from "../../../module-sdk/src/index.js";
import type { GitHubApi, WorkItemReadinessAssessment } from "../../../module-sdk/src/index.js";

const MAX_PAGES = 100;
const PAGE_SIZE = 100;

/** Public provider policy used both by polling and Development admission. */
export async function assessGitHubWorkItemReadiness(input: {
  readonly api: GitHubApi;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
  readonly tag: string;
}): Promise<WorkItemReadinessAssessment> {
  try {
    const issue = await input.api.get(
      `/repos/${input.owner}/${input.repository}/issues/${input.number}`,
    );
    if (!isRecord(issue.body) || issue.status < 200 || issue.status >= 300) {
      return { status: "impossible", reason: "work-item-unavailable", blockerRefs: [] };
    }
    if (issue.body["pull_request"] !== undefined) {
      return { status: "blocked", reason: "work-item-is-pull-request", blockerRefs: [] };
    }
    if (issue.body["state"] !== "open" && issue.body["state"] !== "closed") {
      return { status: "impossible", reason: "work-item-state-unavailable", blockerRefs: [] };
    }
    if (issue.body["state"] === "closed") {
      return { status: "blocked", reason: "work-item-closed", blockerRefs: [] };
    }
    if (!Array.isArray(issue.body["labels"])) {
      return { status: "impossible", reason: "work-item-labels-unavailable", blockerRefs: [] };
    }
    const labels: string[] = [];
    for (const label of issue.body["labels"]) {
      if (!isRecord(label) || typeof label["name"] !== "string") {
        return { status: "impossible", reason: "work-item-labels-unavailable", blockerRefs: [] };
      }
      labels.push(label["name"]);
    }
    if (!labels.includes(input.tag)) {
      return { status: "blocked", reason: "ready-label-missing", blockerRefs: [] };
    }
    const blockerRefs: string[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await input.api.get(
        `/repos/${input.owner}/${input.repository}/issues/${input.number}/dependencies/blocked_by?per_page=${PAGE_SIZE}&page=${page}`,
      );
      if (!Array.isArray(response.body) || response.status < 200 || response.status >= 300) {
        return { status: "impossible", reason: "dependency-state-unavailable", blockerRefs: [] };
      }
      for (const blocker of response.body) {
        if (
          !isRecord(blocker) ||
          typeof blocker["number"] !== "number" ||
          !Number.isSafeInteger(blocker["number"]) ||
          blocker["number"] < 1 ||
          blocker["state"] !== "open"
        ) {
          return { status: "impossible", reason: "dependency-state-unavailable", blockerRefs: [] };
        }
        blockerRefs.push(`github://${input.owner}/${input.repository}/issues/${blocker["number"]}`);
      }
      if (!hasNextPage(response.headers)) {
        return blockerRefs.length === 0
          ? { status: "ready", reason: "no-open-native-blockers", blockerRefs }
          : { status: "blocked", reason: "open-native-blockers", blockerRefs };
      }
    }
  } catch {
    return { status: "impossible", reason: "dependency-state-unavailable", blockerRefs: [] };
  }
  return { status: "impossible", reason: "dependency-pagination-incomplete", blockerRefs: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNextPage(headers: Readonly<Record<string, string>> | undefined): boolean {
  return /rel="next"/.test(headers?.["link"] ?? headers?.["Link"] ?? "");
}

/** GitHub Module state: current readiness diagnostics and one-time admission. */
export class WorkItemReadinessStore {
  public constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
  ) {}

  public bind(projectId: string, moduleInstanceId: string): WorkItemReadinessCapability {
    return {
      observe: ({ repositoryId, workItemRef, status, reason, blockerRefs, observedAt }) => {
        this.db
          .prepare(
            `INSERT INTO github_work_item_readiness
               (project_id, module_instance_id, repository_id, work_item_ref, status, reason, blocker_refs, observed_at, admitted_at)
             VALUES (@projectId, @moduleInstanceId, @repositoryId, @workItemRef, @status, @reason, @blockerRefs, @observedAt, NULL)
             ON CONFLICT (project_id, repository_id, work_item_ref) DO UPDATE SET
               status = excluded.status,
               reason = excluded.reason,
               blocker_refs = excluded.blocker_refs,
               observed_at = excluded.observed_at`,
          )
          .run({
            projectId,
            moduleInstanceId,
            repositoryId,
            workItemRef,
            status,
            reason,
            blockerRefs: JSON.stringify(blockerRefs),
            observedAt,
          });
        if (status !== "ready") return false;
        return (
          this.db
            .prepare(
              `UPDATE github_work_item_readiness
               SET admitted_at = @admittedAt
               WHERE project_id = @projectId AND repository_id = @repositoryId
                 AND work_item_ref = @workItemRef
                 AND status = 'ready' AND admitted_at IS NULL`,
            )
            .run({
              projectId,
              moduleInstanceId,
              repositoryId,
              workItemRef,
              admittedAt: this.clock.now().toISOString(),
            }).changes === 1
        );
      },
    };
  }
}
