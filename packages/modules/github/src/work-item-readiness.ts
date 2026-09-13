import type Database from "better-sqlite3";
import type { Clock } from "../../../kernel/src/clock.js";
import type {
  GitHubApi,
  WorkItemReadinessAssessment,
  WorkItemReadinessCapability,
  WorkItemStateObservation,
} from "../../../module-sdk/src/index.js";

const MAX_PAGES = 100;
const PAGE_SIZE = 100;

export interface WorkItemReadinessSnapshot {
  readonly moduleInstanceId: string;
  readonly repositoryId: string;
  readonly workItemRef: string;
  readonly issueNumber: number | null;
  readonly title: string | null;
  readonly tag: string | null;
  readonly ruleMatches: boolean;
  readonly status: "ready" | "blocked" | "impossible";
  readonly reason: string;
  readonly blockerRefs: readonly string[];
  readonly observedAt: string;
  readonly admittedAt: string | null;
}

export interface WorkItemObservationSnapshot extends WorkItemStateObservation {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly workItemRef: string;
  readonly observedAt: string;
  readonly observationRevision: number;
}

/** Reads one complete provider snapshot without labels, rules, or admission policy. */
export async function observeGitHubWorkItemState(input: {
  readonly api: GitHubApi;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}): Promise<WorkItemStateObservation> {
  let issue;
  try {
    issue = await input.api.get(`/repos/${input.owner}/${input.repository}/issues/${input.number}`);
  } catch {
    return unavailableObservation("provider-unavailable");
  }
  if (issue.status < 200 || issue.status >= 300) {
    return unavailableObservation(responseReason(issue));
  }
  if (!isRecord(issue.body) || Object.hasOwn(issue.body, "pull_request")) {
    return unavailableObservation("observation-incomplete");
  }
  const number = issue.body["number"];
  const title = issue.body["title"];
  const state = issue.body["state"];
  if (
    number !== input.number ||
    !Number.isSafeInteger(number) ||
    typeof title !== "string" ||
    title.trim() === "" ||
    (state !== "open" && state !== "closed")
  ) {
    return unavailableObservation("observation-incomplete");
  }
  const tags = readTags(issue.body["labels"]);
  if (tags === undefined) return unavailableObservation("observation-incomplete");
  const dependencies = await readDependencies(input);
  if (dependencies.status !== "complete") return unavailableObservation(dependencies.reasonCode);
  return {
    title: title.slice(0, 256),
    state,
    tags,
    dependencies: { status: "complete", openWorkItemRefs: dependencies.openWorkItemRefs },
    verification: "verified",
    reasonCode: null,
  };
}

function readTags(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const tags = value.map((tag) => {
    if (!isRecord(tag) || typeof tag["name"] !== "string") return undefined;
    const name = tag["name"];
    return name.length >= 1 && name.length <= 200 ? name : undefined;
  });
  if (tags.some((tag) => tag === undefined)) return undefined;
  const names = tags as string[];
  return new Set(names).size === names.length ? names : undefined;
}

async function readDependencies(input: {
  readonly api: GitHubApi;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}): Promise<
  | { readonly status: "complete"; readonly openWorkItemRefs: readonly string[] }
  | { readonly status: "unavailable"; readonly reasonCode: string }
> {
  const openWorkItemRefs: string[] = [];
  try {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await input.api.get(
        `/repos/${input.owner}/${input.repository}/issues/${input.number}/dependencies/blocked_by?per_page=${PAGE_SIZE}&page=${page}`,
      );
      if (response.status < 200 || response.status >= 300 || !Array.isArray(response.body)) {
        return { status: "unavailable", reasonCode: responseReason(response) };
      }
      for (const blocker of response.body) {
        if (!isRecord(blocker))
          return { status: "unavailable", reasonCode: "observation-incomplete" };
        if (Object.hasOwn(blocker, "pull_request")) continue;
        const blockerNumber = blocker["number"];
        if (
          typeof blockerNumber !== "number" ||
          !Number.isSafeInteger(blockerNumber) ||
          blockerNumber < 1 ||
          (blocker["state"] !== "open" && blocker["state"] !== "closed")
        ) {
          return { status: "unavailable", reasonCode: "observation-incomplete" };
        }
        if (blocker["state"] === "open") {
          const ref = `github://${input.owner}/${input.repository}/issues/${blockerNumber}`;
          if (ref.length > 2048) {
            return { status: "unavailable", reasonCode: "observation-incomplete" };
          }
          openWorkItemRefs.push(ref);
        }
      }
      if (!hasNextPage(response.headers)) {
        return { status: "complete", openWorkItemRefs: [...new Set(openWorkItemRefs)] };
      }
    }
  } catch {
    return { status: "unavailable", reasonCode: "provider-unavailable" };
  }
  return { status: "unavailable", reasonCode: "observation-incomplete" };
}

function unavailableObservation(reasonCode: string): WorkItemStateObservation {
  return {
    title: "",
    state: "unknown",
    tags: [],
    dependencies: { status: "unknown", openWorkItemRefs: [] },
    verification: "unavailable",
    reasonCode,
  };
}

function responseReason(response: {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
}): string {
  const remaining =
    response.headers?.["x-ratelimit-remaining"] ?? response.headers?.["X-RateLimit-Remaining"];
  if (response.status === 429 || (response.status === 403 && remaining === "0")) {
    return "provider-rate-limited";
  }
  if (response.status === 401 || response.status === 403) return "provider-unauthorized";
  if (response.status >= 500 || response.status === 408) return "provider-unavailable";
  return "observation-incomplete";
}

/** Public provider policy used both by polling and Development admission. */
export async function assessGitHubWorkItemReadiness(input: {
  readonly api: GitHubApi;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
  readonly tag: string;
}): Promise<WorkItemReadinessAssessment> {
  if (input.tag.trim() === "") {
    return { status: "impossible", reason: "ready-label-unknown", blockerRefs: [] };
  }
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
          (blocker["state"] !== "open" && blocker["state"] !== "closed")
        ) {
          return { status: "impossible", reason: "dependency-state-unavailable", blockerRefs: [] };
        }
        if (blocker["state"] === "open") {
          blockerRefs.push(
            `github://${input.owner}/${input.repository}/issues/${blocker["number"]}`,
          );
        }
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

  public wasAdmitted(projectId: string, repositoryId: string, workItemRef: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM github_work_item_readiness WHERE project_id = ? AND repository_id = ? AND work_item_ref = ? AND admitted_at IS NOT NULL",
        )
        .get(projectId, repositoryId, workItemRef) !== undefined
    );
  }

  public isCurrentObservation(
    projectId: string,
    repositoryId: string,
    workItemRef: string,
    observationRevision: number,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT observation_revision FROM github_work_item_readiness
         WHERE project_id = ? AND repository_id = ? AND work_item_ref = ?`,
      )
      .get(projectId, repositoryId, workItemRef) as { observation_revision: number } | undefined;
    return row?.observation_revision === observationRevision;
  }

  public list(projectId: string, limit = 100): readonly WorkItemReadinessSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT module_instance_id, repository_id, work_item_ref, issue_number, title, tag,
                rule_matches, status, reason, blocker_refs, observed_at, admitted_at,
                observation_revision
         FROM github_work_item_readiness
         WHERE project_id = @projectId
         ORDER BY observed_at DESC, repository_id, work_item_ref
         LIMIT @limit`,
      )
      .all({ projectId, limit }) as ReadinessRow[];
    return rows.map((row) => ({
      moduleInstanceId: row.module_instance_id,
      repositoryId: row.repository_id,
      workItemRef: row.work_item_ref,
      issueNumber: row.issue_number,
      title: row.title,
      tag: row.tag,
      ruleMatches: row.rule_matches === 1,
      status: row.status,
      reason: row.reason,
      blockerRefs: parseBlockerRefs(row.blocker_refs),
      observedAt: row.observed_at,
      admittedAt: row.admitted_at,
    }));
  }

  public listObserved(
    projectId: string,
    repositoryId: string,
  ): readonly WorkItemObservationSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT project_id, repository_id, work_item_ref, title, state, tags,
                dependencies_status, open_work_item_refs, verification, reason_code,
                observed_at, observation_revision
         FROM github_work_item_observations
         WHERE project_id = ? AND repository_id = ?
         ORDER BY work_item_ref`,
      )
      .all(projectId, repositoryId) as ObservationRow[];
    return rows.map((row) => ({
      projectId: row.project_id,
      repositoryId: row.repository_id,
      workItemRef: row.work_item_ref,
      title: row.title,
      state: row.state,
      tags: parseStringArray(row.tags),
      dependencies: {
        status: row.dependencies_status,
        openWorkItemRefs: parseStringArray(row.open_work_item_refs),
      },
      verification: row.verification,
      reasonCode: row.reason_code,
      observedAt: row.observed_at,
      observationRevision: row.observation_revision,
    }));
  }

  public recordObserved(input: {
    readonly projectId: string;
    readonly repositoryId: string;
    readonly workItemRef: string;
    readonly title: string;
    readonly observation: WorkItemStateObservation;
    readonly observedAt: string;
  }): number {
    this.db
      .prepare(
        `INSERT INTO github_work_item_observations
           (project_id, repository_id, work_item_ref, title, state, tags,
            dependencies_status, open_work_item_refs, verification, reason_code,
            observed_at, observation_revision)
         VALUES (@projectId, @repositoryId, @workItemRef, @title, @state, @tags,
                 @dependenciesStatus, @openWorkItemRefs, @verification, @reasonCode,
                 @observedAt, 1)
         ON CONFLICT (project_id, repository_id, work_item_ref) DO UPDATE SET
           title = excluded.title,
           state = excluded.state,
           tags = excluded.tags,
           dependencies_status = excluded.dependencies_status,
           open_work_item_refs = excluded.open_work_item_refs,
           verification = excluded.verification,
           reason_code = excluded.reason_code,
           observed_at = excluded.observed_at,
           observation_revision = github_work_item_observations.observation_revision + 1`,
      )
      .run({
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        workItemRef: input.workItemRef,
        title: input.title,
        state: input.observation.state,
        tags: JSON.stringify(input.observation.tags),
        dependenciesStatus: input.observation.dependencies.status,
        openWorkItemRefs: JSON.stringify(input.observation.dependencies.openWorkItemRefs),
        verification: input.observation.verification,
        reasonCode: input.observation.reasonCode,
        observedAt: input.observedAt,
      });
    const row = this.db
      .prepare(
        `SELECT observation_revision FROM github_work_item_observations
         WHERE project_id = ? AND repository_id = ? AND work_item_ref = ?`,
      )
      .get(input.projectId, input.repositoryId, input.workItemRef) as {
      readonly observation_revision: number;
    };
    return row.observation_revision;
  }

  public bind(projectId: string, moduleInstanceId: string): WorkItemReadinessCapability {
    return {
      wasAdmitted: (repositoryId, workItemRef) =>
        this.wasAdmitted(projectId, repositoryId, workItemRef),
      isCurrentObservation: (repositoryId, workItemRef, observationRevision) =>
        this.isCurrentObservation(projectId, repositoryId, workItemRef, observationRevision),
      observe: ({
        repositoryId,
        workItemRef,
        status,
        reason,
        blockerRefs,
        observedAt,
        issueNumber,
        title,
        tag,
        ruleMatches = true,
        admit = true,
        observationRevision,
      }) => {
        const written = this.db
          .prepare(
            `INSERT INTO github_work_item_readiness
               (project_id, module_instance_id, repository_id, work_item_ref, issue_number, title, tag,
                rule_matches, status, reason, blocker_refs, observed_at, admitted_at, observation_revision)
             VALUES (@projectId, @moduleInstanceId, @repositoryId, @workItemRef, @issueNumber, @title, @tag,
                     @ruleMatches, @status, @reason, @blockerRefs, @observedAt, NULL,
                     COALESCE(@observationRevision, 0))
             ON CONFLICT (project_id, repository_id, work_item_ref) DO UPDATE SET
               issue_number = COALESCE(excluded.issue_number, github_work_item_readiness.issue_number),
               title = COALESCE(excluded.title, github_work_item_readiness.title),
               tag = COALESCE(excluded.tag, github_work_item_readiness.tag),
               rule_matches = excluded.rule_matches,
               status = excluded.status,
               reason = excluded.reason,
               blocker_refs = excluded.blocker_refs,
               observed_at = excluded.observed_at,
               observation_revision = excluded.observation_revision
             WHERE excluded.observation_revision >= github_work_item_readiness.observation_revision`,
          )
          .run({
            projectId,
            moduleInstanceId,
            repositoryId,
            workItemRef,
            issueNumber: issueNumber ?? null,
            title: title ?? null,
            tag: tag ?? null,
            ruleMatches: ruleMatches ? 1 : 0,
            status,
            reason,
            blockerRefs: JSON.stringify(blockerRefs),
            observedAt,
            observationRevision: observationRevision ?? null,
          });
        if (written.changes !== 1 || status !== "ready" || !admit) return false;
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

interface ReadinessRow {
  readonly module_instance_id: string;
  readonly repository_id: string;
  readonly work_item_ref: string;
  readonly issue_number: number | null;
  readonly title: string | null;
  readonly tag: string | null;
  readonly rule_matches: number;
  readonly status: WorkItemReadinessSnapshot["status"];
  readonly reason: string;
  readonly blocker_refs: string;
  readonly observed_at: string;
  readonly admitted_at: string | null;
  readonly observation_revision: number;
}

interface ObservationRow {
  readonly project_id: string;
  readonly repository_id: string;
  readonly work_item_ref: string;
  readonly title: string;
  readonly state: WorkItemStateObservation["state"];
  readonly tags: string;
  readonly dependencies_status: WorkItemStateObservation["dependencies"]["status"];
  readonly open_work_item_refs: string;
  readonly verification: WorkItemStateObservation["verification"];
  readonly reason_code: string | null;
  readonly observed_at: string;
  readonly observation_revision: number;
}

function parseBlockerRefs(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((ref) => typeof ref === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function parseStringArray(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}
