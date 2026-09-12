import type { components } from "../api/generated/local-api.js";
import type { ExecutionCheckpoint } from "../executions/checkpoints.js";
import type { LedgerExecutionSummary } from "../executions/ledger.js";
import type { EventDetail } from "../events/timeline.js";
import type { WorkItemReadinessSnapshot } from "../../../../packages/modules/github/src/work-item-readiness.js";
import type { WorkspaceLease } from "../../../../packages/workspace/src/lease-repository.js";

type Detail = components["schemas"]["ExecutionDetailV1"];
type DetailEvent = components["schemas"]["ExecutionDetailEvent"];
type DetailStep = components["schemas"]["ExecutionDetailStep"];
type DetailCheck = components["schemas"]["ExecutionDetailCheck"];
type DetailExecution = components["schemas"]["ExecutionDetailExecution"];
type DetailFailure = NonNullable<Detail["failure"]>;

const MAX_EXCERPT = 512;
const MAX_EVENTS = 100;
const MAX_EXECUTIONS = 100;
const MAX_CHECKPOINTS = 10_000;
const MAX_CHECKS = 100;

const STEP_LABELS = {
  "issue-received": "Issue reçue",
  "eligibility-confirmed": "Éligibilité confirmée",
  "workspace-prepared": "Workspace préparé",
  "agent-running": "Agent en cours",
  checks: "Checks",
  "commit-push": "Commit et push",
  "pull-request": "Création de la Pull Request",
} as const;

type StepId = keyof typeof STEP_LABELS;

export interface ExecutionDetailInput {
  readonly projectId: string;
  readonly correlationId: string | null;
  readonly anchor: LedgerExecutionSummary;
  readonly executions: readonly LedgerExecutionSummary[];
  readonly events: readonly EventDetail[];
  readonly checkpoints: ReadonlyMap<string, readonly ExecutionCheckpoint[]>;
  readonly leases: ReadonlyMap<string, WorkspaceLease | undefined>;
  readonly readiness: readonly WorkItemReadinessSnapshot[];
  readonly retryDeliveryId: string | null;
}

export function buildExecutionDetail(input: ExecutionDetailInput): Detail {
  const executions = uniqueExecutions(input.anchor, input.executions);
  const checkpointEntries = executions
    .flatMap((execution) =>
      (input.checkpoints.get(execution.id) ?? []).map((checkpoint) => ({ execution, checkpoint })),
    )
    .slice(-MAX_CHECKPOINTS);
  const workItem = buildWorkItem(input.events, input.readiness);
  const latestExecution = executions.at(-1);
  const failedExecution =
    latestExecution !== undefined &&
    (latestExecution.error !== null || isTerminalFailure(latestExecution.status))
      ? latestExecution
      : undefined;
  const activeExecution = executions.find(
    (execution) => execution.status === "running" || execution.status === "cancelling",
  );
  const failureEvent =
    failedExecution === undefined
      ? undefined
      : input.events.find((event) =>
          ["development.implementation.failed", "scm.change-request.creation-failed"].includes(
            event.type,
          ),
        );
  const failure = buildFailure(failedExecution, failureEvent, input.retryDeliveryId);
  const createdPullRequest = input.events.find(
    (event) => event.type === "scm.change-request.created",
  );
  const requestedPullRequest = input.events.find(
    (event) => event.type === "scm.change-request.creation-requested",
  );
  const checks = buildChecks(checkpointEntries);
  const steps = buildSteps({
    events: input.events,
    executions,
    checkpoints: checkpointEntries,
    leases: input.leases,
    checks,
    failure,
    pullRequestCreated: createdPullRequest !== undefined,
    pullRequestRequested: requestedPullRequest !== undefined,
  });
  const detailEvents = input.events.slice(0, MAX_EVENTS).map(toEvent);
  const inputEventIds = unique(executions.map((execution) => execution.inputEventId));
  const causationIds = unique(
    input.events.map((event) => event.causationId).filter((id): id is string => id !== null),
  );

  return {
    apiVersion: "jarvis.dev/execution-detail/v1",
    kind: "ExecutionDetail",
    projectId: input.projectId,
    correlationId: input.correlationId,
    workItem,
    executions: executions.map((execution) => toExecution(execution, input.correlationId)),
    steps,
    checks,
    agentExcerpts: checkpointEntries
      .filter(
        ({ checkpoint }) =>
          checkpoint.type === "agent.message" && typeof checkpoint.payload["message"] === "string",
      )
      .slice(-8)
      .map(({ execution, checkpoint }) => {
        const text = String(checkpoint.payload["message"]);
        return {
          occurredAt: checkpoint.occurredAt,
          executionId: execution.id,
          text: truncate(sanitizeText(text), MAX_EXCERPT).value,
          truncated: text.length > MAX_EXCERPT,
        };
      }),
    workspace: latestWorkspace(executions, input.leases),
    artifacts: null,
    pullRequest:
      createdPullRequest === undefined
        ? null
        : toPullRequest(createdPullRequest, requestedPullRequest, workItem),
    lastEvent: detailEvents[0] ?? null,
    technical: {
      inputEventIds,
      correlationId: input.correlationId,
      causationIds,
      events: detailEvents,
    },
    failure,
    retryDeliveryId: input.retryDeliveryId,
    cancellableExecutionId: activeExecution?.id ?? null,
  };
}

function uniqueExecutions(
  anchor: LedgerExecutionSummary,
  executions: readonly LedgerExecutionSummary[],
): LedgerExecutionSummary[] {
  const byId = new Map<string, LedgerExecutionSummary>();
  for (const execution of [...executions, anchor]) byId.set(execution.id, execution);
  const ordered = [...byId.values()].sort((left, right) =>
    `${left.createdAt}\u0000${left.id}`.localeCompare(`${right.createdAt}\u0000${right.id}`),
  );
  if (ordered.length <= MAX_EXECUTIONS) return ordered;
  return [
    ...ordered.filter((execution) => execution.id !== anchor.id).slice(-MAX_EXECUTIONS + 1),
    anchor,
  ].sort((left, right) =>
    `${left.createdAt}\u0000${left.id}`.localeCompare(`${right.createdAt}\u0000${right.id}`),
  );
}

function toExecution(
  execution: LedgerExecutionSummary,
  correlationId: string | null,
): DetailExecution {
  return {
    id: execution.id,
    projectId: execution.projectId,
    moduleInstanceId: execution.moduleInstanceId,
    status: execution.status,
    attempt: execution.attempt,
    createdAt: execution.createdAt,
    error:
      execution.error === null ? null : truncate(sanitizeText(execution.error), MAX_EXCERPT).value,
    completedAt: execution.completedAt,
    inputEventId: execution.inputEventId,
    replayed: execution.replayed,
    correlationId,
    durationMs: duration(execution.createdAt, execution.completedAt),
  };
}

function buildWorkItem(
  events: readonly EventDetail[],
  readiness: readonly WorkItemReadinessSnapshot[],
): Detail["workItem"] {
  const source = events.find((event) => stringValue(event.payload, "workItemRef") !== undefined);
  const ref = source === undefined ? undefined : stringValue(source.payload, "workItemRef");
  const subjectRef = source?.subjectRef;
  const workItemRef = ref ?? subjectRef;
  if (workItemRef === undefined || workItemRef.trim() === "") return null;
  const snapshot = readiness.find((item) => item.workItemRef === workItemRef);
  const title = snapshot?.title ?? stringValue(source?.payload, "title") ?? null;
  const issueNumber =
    snapshot?.issueNumber ?? Number(/\/issues\/(\d+)$/.exec(workItemRef)?.[1] ?? NaN);
  return {
    ref: truncate(sanitizeText(workItemRef), 512).value,
    title: title === null ? null : truncate(sanitizeText(title), MAX_EXCERPT).value,
    issueNumber: Number.isSafeInteger(issueNumber) && issueNumber > 0 ? issueNumber : null,
    repositoryId:
      snapshot?.repositoryId ??
      stringValue(source?.payload, "repositoryId") ??
      source?.repositoryId ??
      null,
  };
}

function buildChecks(
  entries: readonly {
    readonly execution: LedgerExecutionSummary;
    readonly checkpoint: ExecutionCheckpoint;
  }[],
): DetailCheck[] {
  const starts = new Map<
    string,
    { execution: LedgerExecutionSummary; checkpoint: ExecutionCheckpoint }
  >();
  const checks = new Map<string, DetailCheck>();
  for (const entry of entries) {
    const { checkpoint, execution } = entry;
    if (
      checkpoint.type === "validation.started" &&
      typeof checkpoint.payload["check"] === "string"
    ) {
      const name = truncate(sanitizeText(String(checkpoint.payload["check"])), 256).value;
      starts.set(name, entry);
      checks.set(name, {
        name,
        status: "unavailable",
        durationMs: null,
        startedAt: checkpoint.occurredAt,
        completedAt: null,
        output: null,
        executionId: execution.id,
      });
    }
    if (checkpoint.type === "validation.failed") {
      const name = truncate(
        sanitizeText(stringValue(checkpoint.payload, "check") ?? "Validation"),
        256,
      ).value;
      const start = starts.get(name);
      checks.set(name, {
        name,
        status: "failed",
        durationMs: duration(start?.checkpoint.occurredAt ?? null, checkpoint.occurredAt),
        startedAt: start?.checkpoint.occurredAt ?? null,
        completedAt: checkpoint.occurredAt,
        output: truncate(sanitizeText(stringValue(checkpoint.payload, "output") ?? ""), MAX_EXCERPT)
          .value,
        executionId: execution.id,
      });
    }
    if (checkpoint.type === "commit.created") {
      const validation = checkpoint.payload["validation"];
      if (isValidationSnapshot(validation)) {
        for (const command of validation.commands.slice(0, MAX_CHECKS)) {
          const start = starts.get(command.name);
          checks.set(command.name, {
            name: truncate(sanitizeText(command.name), 256).value,
            status: "passed",
            durationMs: command.durationMs,
            startedAt: start?.checkpoint.occurredAt ?? null,
            completedAt: checkpoint.occurredAt,
            output: null,
            executionId: execution.id,
          });
        }
      }
    }
  }
  return [...checks.values()].slice(0, MAX_CHECKS);
}

function buildSteps(input: {
  readonly events: readonly EventDetail[];
  readonly executions: readonly LedgerExecutionSummary[];
  readonly checkpoints: readonly {
    readonly execution: LedgerExecutionSummary;
    readonly checkpoint: ExecutionCheckpoint;
  }[];
  readonly leases: ReadonlyMap<string, WorkspaceLease | undefined>;
  readonly checks: readonly DetailCheck[];
  readonly failure: DetailFailure | null;
  readonly pullRequestCreated: boolean;
  readonly pullRequestRequested: boolean;
}): DetailStep[] {
  const event = (types: readonly string[]) =>
    input.events.find((item) => types.includes(item.type));
  const checkpoint = (type: ExecutionCheckpoint["type"]) =>
    input.checkpoints.find((item) => item.checkpoint.type === type);
  const latestActive = input.executions.find(
    (execution) => execution.status === "running" || execution.status === "cancelling",
  );
  const cancelled = input.executions.at(-1)?.status === "cancelled";
  const failedStep = input.failure?.stepId ?? null;
  const result = (id: StepId, evidence: Evidence | undefined, detail: string): DetailStep => {
    const failed = failedStep === id && !cancelled;
    const status = failed
      ? "failed"
      : evidence !== undefined
        ? evidence.active
          ? "active"
          : "proved"
        : cancelled && id === "agent-running"
          ? "cancelled"
          : "unavailable";
    return {
      id,
      label: STEP_LABELS[id],
      status,
      occurredAt: evidence?.occurredAt ?? null,
      completedAt: evidence?.completedAt ?? null,
      executionId: evidence?.executionId ?? null,
      detail,
    };
  };

  const received = event(["scm.work-item.tag-added", "scm.work-item.ready"]);
  const ready = event(["scm.work-item.ready", "development.implementation.requested"]);
  const preparation = checkpoint("preparation.completed");
  const leaseEntry = input.executions
    .map((execution) => ({ execution, lease: input.leases.get(execution.id) }))
    .find((entry) => entry.lease !== undefined);
  const agent = checkpoint("agent.started");
  const validation = input.checks[0];
  const commit = checkpoint("commit.created");
  const pushed = checkpoint("branch.pushed");
  const requested = event(["scm.change-request.creation-requested"]);
  const created = event(["scm.change-request.created"]);
  const terminal =
    input.executions.find((execution) => execution.id === latestActive?.id) ??
    input.executions.at(-1);

  return [
    result(
      "issue-received",
      received === undefined
        ? undefined
        : evidence(
            received.occurredAt,
            received.occurredAt,
            executionForEvent(received, input.executions),
          ),
      received === undefined
        ? "Information indisponible"
        : "Le journal prouve la réception de l’issue.",
    ),
    result(
      "eligibility-confirmed",
      ready === undefined
        ? undefined
        : evidence(ready.occurredAt, ready.occurredAt, executionForEvent(ready, input.executions)),
      ready === undefined
        ? "Information indisponible"
        : "Le fait de readiness prouve l’éligibilité.",
    ),
    result(
      "workspace-prepared",
      preparation === undefined && leaseEntry === undefined
        ? undefined
        : preparation !== undefined
          ? evidence(
              preparation.checkpoint.occurredAt,
              preparation.checkpoint.occurredAt,
              preparation.execution.id,
            )
          : evidence(leaseEntry!.lease!.createdAt, null, leaseEntry!.execution.id),
      preparation === undefined && leaseEntry === undefined
        ? "Information indisponible"
        : "Le workspace est enregistré par le moteur.",
    ),
    result(
      "agent-running",
      agent === undefined
        ? undefined
        : evidence(
            agent.checkpoint.occurredAt,
            terminal?.completedAt ?? null,
            agent.execution.id,
            latestActive?.id === agent.execution.id,
          ),
      agent === undefined ? "Information indisponible" : "Un checkpoint agent est enregistré.",
    ),
    result(
      "checks",
      validation === undefined
        ? undefined
        : evidence(
            validation.startedAt ?? validation.completedAt ?? "",
            validation.completedAt,
            validation.executionId,
          ),
      validation === undefined
        ? "Information indisponible"
        : "Les résultats de validation sont enregistrés.",
    ),
    result(
      "commit-push",
      pushed !== undefined
        ? evidence(pushed.checkpoint.occurredAt, pushed.checkpoint.occurredAt, pushed.execution.id)
        : commit !== undefined
          ? evidence(commit.checkpoint.occurredAt, null, commit.execution.id, true)
          : undefined,
      pushed !== undefined
        ? "Le commit et le push sont prouvés."
        : commit !== undefined
          ? "Le commit est prouvé; le push reste à confirmer."
          : "Information indisponible",
    ),
    result(
      "pull-request",
      created !== undefined
        ? evidence(
            created.occurredAt,
            created.occurredAt,
            executionForEvent(created, input.executions),
          )
        : requested !== undefined
          ? evidence(
              requested.occurredAt,
              null,
              executionForEvent(requested, input.executions),
              true,
            )
          : undefined,
      created !== undefined
        ? "La Pull Request est créée et attend une revue manuelle."
        : requested !== undefined
          ? "La création de la Pull Request est demandée."
          : "Information indisponible",
    ),
  ];
}

interface Evidence {
  readonly occurredAt: string;
  readonly completedAt: string | null;
  readonly executionId: string | null;
  readonly active?: boolean;
}

function evidence(
  occurredAt: string,
  completedAt: string | null,
  executionId: string | null,
  active = false,
): Evidence {
  return { occurredAt, completedAt, executionId, active };
}

function executionForEvent(
  event: EventDetail,
  executions: readonly LedgerExecutionSummary[],
): string | null {
  return executions.find((execution) => execution.inputEventId === event.id)?.id ?? null;
}

function buildFailure(
  execution: LedgerExecutionSummary | undefined,
  event: EventDetail | undefined,
  retryDeliveryId: string | null,
): DetailFailure | null {
  if (execution === undefined && event === undefined) return null;
  const payload = event?.payload;
  const code =
    stringValue(payload, "code") ??
    (execution?.status === "timed-out"
      ? "execution.timed-out"
      : execution?.status === "cancelled"
        ? "execution.cancelled"
        : "execution.failed");
  const message =
    execution?.error ??
    stringValue(payload, "message") ??
    (execution?.status === "timed-out"
      ? "L’exécution a dépassé son délai."
      : execution?.status === "cancelled"
        ? "L’exécution a été annulée."
        : "L’exécution a échoué.");
  const retryable = retryDeliveryId !== null;
  const stepId = failureStep(code, execution?.status);
  return {
    code: truncate(sanitizeText(code), 128).value,
    message: truncate(sanitizeText(message), MAX_EXCERPT).value,
    retryable,
    impact:
      execution?.status === "timed-out"
        ? "Aucun résultat final n’a été confirmé."
        : execution?.status === "cancelled"
          ? "Le travail a été interrompu; le résultat durable reste affiché."
          : "Le parcours s’est arrêté avant sa fin.",
    nextAction:
      retryDeliveryId !== null
        ? "Relancer cette livraison ou ouvrir les détails techniques."
        : "Ouvrir les détails techniques pour diagnostiquer l’exécution.",
    stepId,
  };
}

function failureStep(
  code: string,
  status: LedgerExecutionSummary["status"] | undefined,
): StepId | null {
  if (/validation|check/i.test(code)) return "checks";
  if (/workspace|preparation/i.test(code)) return "workspace-prepared";
  if (/push|commit/i.test(code)) return "commit-push";
  if (/pull|change-request/i.test(code)) return "pull-request";
  return status === "failed" || status === "timed-out" || status === "cancelled"
    ? "agent-running"
    : null;
}

function isTerminalFailure(status: LedgerExecutionSummary["status"]): boolean {
  return status === "failed" || status === "timed-out" || status === "cancelled";
}

function latestWorkspace(
  executions: readonly LedgerExecutionSummary[],
  leases: ReadonlyMap<string, WorkspaceLease | undefined>,
): Detail["workspace"] {
  for (const execution of [...executions].reverse()) {
    const lease = leases.get(execution.id);
    if (lease !== undefined) {
      return {
        path: lease.workspacePath,
        repositoryId: lease.repositoryId,
        branch: lease.workingBranch,
        baseRevisionSha: lease.baseRevisionSha,
        status: lease.status,
        executionId: lease.executionId,
      };
    }
  }
  return null;
}

function toPullRequest(
  created: EventDetail,
  requested: EventDetail | undefined,
  workItem: Detail["workItem"],
): Detail["pullRequest"] {
  const payload = created.payload;
  const requestPayload = requested?.payload;
  const ref = stringValue(payload, "changeRequestRef") ?? created.subjectRef;
  const title = stringValue(requestPayload, "title");
  return {
    ref: truncate(sanitizeText(ref), 512).value,
    number: integerValue(payload, "externalNumber"),
    title: title === undefined ? null : truncate(sanitizeText(title), MAX_EXCERPT).value,
    url: safeExternalUrl(stringValue(payload, "url")),
    repositoryId:
      stringValue(payload, "repositoryId") ??
      workItem?.repositoryId ??
      created.repositoryId ??
      null,
  };
}

function toEvent(event: EventDetail): DetailEvent {
  const sanitized = sanitizeValue(event.payload);
  const json = JSON.stringify(sanitized) ?? "{}";
  return {
    id: event.id,
    type: event.type,
    version: event.version,
    kind: event.kind,
    occurredAt: event.occurredAt,
    producer: event.producer,
    correlationId: event.correlationId,
    causationId: event.causationId,
    subjectRef: event.subjectRef,
    payloadExcerpt: truncate(json, MAX_EXCERPT).value,
  };
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "<redacted>";
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  let count = 0;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    if (count++ >= 20) break;
    sanitized[sanitizeText(key)] =
      /token|secret|password|credential|authorization|cookie|session|private.?key/i.test(key)
        ? "<redacted>"
        : sanitizeValue(record[key], depth + 1);
  }
  return sanitized;
}

function sanitizeText(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(/((?:authorization|proxy-authorization)\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1<redacted>")
    .replace(
      /((?:["']?)(?:token|secret|password|passwd|authorization|credential|api[_-]?key|access[_-]?(?:key|token)|private[_-]?key|cookie|session)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;{}]+)/gi,
      "$1<redacted>",
    )
    .replace(
      /\b(?:gh[opsru]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]+)\b/g,
      "<redacted>",
    )
    .replace(/\bfile:\/\/[^\s"'<>;,)\]}]+/gi, "<path>")
    .replace(/(^|[\s("'`=:])\/(?!\/)[^\s"'`<>]+/g, "$1<path>")
    .replace(/(^|[\s("'`=:])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>]+/g, "$1<path>");
}

function safeExternalUrl(value: string | undefined): string | null {
  if (value === undefined || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname === "/"
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function truncate(
  value: string,
  limit: number,
): { readonly value: string; readonly truncated: boolean } {
  return value.length <= limit
    ? { value, truncated: false }
    : { value: `${value.slice(0, Math.max(0, limit - 1))}…`, truncated: true };
}

function duration(start: string | null, end: string | null): number | null {
  if (start === null || end === null) return null;
  const elapsed = Date.parse(end) - Date.parse(start);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

function stringValue(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const child = (value as Record<string, unknown>)[key];
  return typeof child === "string" && child.trim() !== "" ? child : undefined;
}

function integerValue(value: unknown, key: string): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const child = (value as Record<string, unknown>)[key];
  return typeof child === "number" && Number.isSafeInteger(child) && child > 0 ? child : null;
}

function isValidationSnapshot(value: unknown): value is {
  readonly commands: readonly { readonly name: string; readonly durationMs: number }[];
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const commands = (value as Record<string, unknown>)["commands"];
  return (
    Array.isArray(commands) &&
    commands
      .slice(0, MAX_CHECKS)
      .every(
        (command) =>
          typeof command === "object" &&
          command !== null &&
          typeof (command as Record<string, unknown>)["name"] === "string" &&
          typeof (command as Record<string, unknown>)["durationMs"] === "number",
      )
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
