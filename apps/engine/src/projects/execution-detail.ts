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
  "workspace-prepared": "Préparation du projet",
  "agent-running": "Développement",
  checks: "Vérifications",
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
  if (failure?.code === "execution.failed") {
    const phase = checkpointEntries.findLast(
      ({ execution, checkpoint }) =>
        execution.id === failedExecution?.id && checkpoint.type !== "agent.message",
    )?.checkpoint.type;
    failure.stepId =
      phase === "validation.started" || phase === "validation.failed"
        ? "checks"
        : phase === "preparation.started" || phase === "preparation.failed"
          ? "workspace-prepared"
          : phase === "commit.created"
            ? "commit-push"
            : phase?.startsWith("agent.")
              ? "agent-running"
              : null;
  }
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
  });
  const failedCheck =
    steps.find((step) => step.id === "checks")?.status === "proved"
      ? undefined
      : checks.findLast((check) => check.status === "failed");
  const validationFailure =
    failedCheck === undefined || latestExecution?.status === "cancelled"
      ? null
      : {
          code: "git.validation-failed",
          message: `La commande ${failedCheck.name} a échoué (tentative ${failedCheck.attempt}).`,
          retryable: false,
          impact:
            "Aucune modification n’est publiée tant que toutes les vérifications n’ont pas réussi.",
          nextAction: activeExecution
            ? "La tentative continue ; le résultat précédent reste dans l’historique ci-dessous."
            : "Consultez la sortie de la commande pour corriger la cause avant de relancer.",
          stepId: "checks" as const,
        };
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
    failure:
      failure?.code === "git.validation-failed" && validationFailure !== null
        ? {
            ...failure,
            message: validationFailure.message,
            impact: validationFailure.impact,
            nextAction: validationFailure.nextAction,
          }
        : (failure ?? validationFailure),
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
  const checks: DetailCheck[] = [];
  let executionId: string | undefined;
  let attempt = 1;
  const current = new Map<string, DetailCheck>();
  for (const { checkpoint, execution } of entries) {
    if (execution.id !== executionId) {
      executionId = execution.id;
      attempt = 1;
      current.clear();
    }
    if (checkpoint.type === "agent.repair-started") {
      attempt += 1;
      current.clear();
    }
    const name = truncate(
      sanitizeText(stringValue(checkpoint.payload, "check") ?? "Validation"),
      256,
    ).value;
    const add = (name: string): DetailCheck => {
      const check: DetailCheck = {
        name,
        attempt,
        status: "unavailable",
        durationMs: null,
        startedAt: null,
        completedAt: null,
        output: null,
        executionId: execution.id,
      };
      checks.push(check);
      current.set(name, check);
      return check;
    };
    if (checkpoint.type === "validation.started") {
      // Older journals did not record repairs. A repeated check starts a new plan attempt.
      if (current.has(name)) {
        attempt += 1;
        current.clear();
      }
      const check = add(name);
      check.status =
        execution.status === "cancelled"
          ? "cancelled"
          : execution.status === "running" || execution.status === "cancelling"
            ? "running"
            : "unavailable";
      check.startedAt = checkpoint.occurredAt;
    }
    if (checkpoint.type === "validation.failed" || checkpoint.type === "validation.completed") {
      const check = current.get(name) ?? add(name);
      check.status = checkpoint.type === "validation.completed" ? "passed" : "failed";
      check.completedAt = checkpoint.occurredAt;
      check.durationMs = duration(check.startedAt, check.completedAt);
      check.output =
        check.status === "failed"
          ? truncate(sanitizeText(stringValue(checkpoint.payload, "output") ?? ""), MAX_EXCERPT)
              .value
          : null;
    }
    if (
      checkpoint.type === "commit.created" &&
      isValidationSnapshot(checkpoint.payload["validation"])
    ) {
      const commands = checkpoint.payload["validation"].commands.slice(0, MAX_CHECKS);
      if ([...current.values()].some((check) => check.status === "failed")) {
        attempt += 1;
        current.clear();
      }
      for (const command of commands) {
        const name = truncate(sanitizeText(command.name), 256).value;
        const check = current.get(name) ?? add(name);
        check.status = "passed";
        check.durationMs = command.durationMs;
        check.completedAt ??= checkpoint.occurredAt;
      }
    }
  }
  return checks.slice(-MAX_CHECKS);
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
}): DetailStep[] {
  const event = (types: readonly string[]) =>
    input.events.find((item) => types.includes(item.type));
  const checkpoint = (...types: ExecutionCheckpoint["type"][]) =>
    input.checkpoints.findLast((item) => types.includes(item.checkpoint.type));
  const latest = input.executions.at(-1);
  const cancelled = latest?.status === "cancelled";
  const active = input.executions.find(
    (execution) => execution.status === "running" || execution.status === "cancelling",
  );
  const received = event([
    "scm.work-item.observed",
    "scm.work-item.ready",
    "scm.work-item.tag-added",
  ]);
  const ready = event(["development.implementation.requested"]);
  const preparation = checkpoint(
    "preparation.started",
    "preparation.completed",
    "preparation.failed",
  );
  const agent = checkpoint("agent.started", "agent.repair-started");
  const validation = checkpoint("validation.started", "validation.failed", "validation.completed");
  const commit = checkpoint("commit.created");
  const pushed = checkpoint("branch.pushed");
  const requested = event(["scm.change-request.creation-requested"]);
  const created = event(["scm.change-request.created"]);
  const after = (left: typeof agent, right: typeof agent) =>
    left !== undefined &&
    (right === undefined || input.checkpoints.indexOf(left) > input.checkpoints.indexOf(right));
  const agentActive =
    agent !== undefined && active?.id === agent.execution.id && after(agent, validation);
  const validationStart = input.checkpoints.find(
    (entry) =>
      entry.checkpoint.type === "validation.started" &&
      agent !== undefined &&
      entry.execution.id === agent.execution.id &&
      after(entry, agent),
  );
  const validationCancelled =
    cancelled && validation?.checkpoint.type === "validation.started" && after(validation, agent);
  const latestCheck = input.checks.at(-1);
  const currentChecks = input.checks.filter(
    (check) =>
      check.executionId === latestCheck?.executionId && check.attempt === latestCheck?.attempt,
  );
  const checksPassed =
    (commit !== undefined && !after(agent, commit) && !after(validation, commit)) ||
    (validation?.checkpoint.type === "validation.completed" &&
      validation.checkpoint.payload["planComplete"] === true &&
      !after(agent, validation) &&
      currentChecks.every((check) => check.status === "passed"));
  const failedCheck = checksPassed
    ? undefined
    : input.checks.findLast((check) => check.status === "failed");
  const fromCheckpoint = (entry: typeof agent, completed = true): Evidence | undefined =>
    entry === undefined
      ? undefined
      : evidence(
          entry.checkpoint.occurredAt,
          completed ? entry.checkpoint.occurredAt : null,
          entry.execution.id,
        );
  const fromEvent = (entry: EventDetail | undefined, completed = true): Evidence | undefined =>
    entry === undefined
      ? undefined
      : evidence(
          entry.occurredAt,
          completed ? entry.occurredAt : null,
          executionForEvent(entry, input.executions),
        );
  const result = (
    id: StepId,
    proof: Evidence | undefined,
    status: DetailStep["status"],
    detail: string,
  ): DetailStep => ({
    id,
    label: STEP_LABELS[id],
    status:
      cancelled && (status === "active" || status === "repairing")
        ? "cancelled"
        : !cancelled && input.failure?.stepId === id
          ? "failed"
          : status,
    occurredAt: proof?.occurredAt ?? null,
    completedAt: proof?.completedAt ?? null,
    executionId: proof?.executionId ?? null,
    detail:
      cancelled && (status === "active" || status === "repairing" || status === "cancelled")
        ? "Cette étape a été interrompue par l’annulation. Les résultats précédents restent dans l’historique."
        : detail,
  });
  const notStarted = "Pas encore commencé";
  const lease = input.executions
    .map((execution) => input.leases.get(execution.id))
    .findLast((lease) => lease !== undefined);
  return [
    result(
      "issue-received",
      fromEvent(received),
      received ? "proved" : "unavailable",
      received ? "L’issue a été reçue." : "Information indisponible",
    ),
    result(
      "eligibility-confirmed",
      fromEvent(ready),
      ready ? "proved" : "unavailable",
      ready ? "L’issue a été admise pour ce projet." : "Information indisponible",
    ),
    result(
      "workspace-prepared",
      fromCheckpoint(preparation, preparation?.checkpoint.type !== "preparation.started") ??
        (lease ? evidence(lease.createdAt, null, lease.executionId) : undefined),
      preparation?.checkpoint.type === "preparation.failed"
        ? "failed"
        : preparation?.checkpoint.type === "preparation.completed" || agent
          ? "proved"
          : lease
            ? "active"
            : "not-started",
      preparation?.checkpoint.type === "preparation.failed"
        ? "La préparation a échoué."
        : preparation?.checkpoint.type === "preparation.completed" || agent
          ? "Le projet est préparé dans son espace de travail."
          : lease
            ? "Préparation en cours."
            : notStarted,
    ),
    result(
      "agent-running",
      agent
        ? evidence(
            agent.checkpoint.occurredAt,
            validationStart?.checkpoint.occurredAt ?? null,
            agent.execution.id,
          )
        : undefined,
      agentActive
        ? "active"
        : agent
          ? after(agent, validation) && !commit
            ? cancelled
              ? "cancelled"
              : "unavailable"
            : "proved"
          : cancelled
            ? "cancelled"
            : "not-started",
      agentActive
        ? agent.checkpoint.type === "agent.repair-started"
          ? "L’agent répare la modification après l’échec des vérifications."
          : "L’agent développe l’issue."
        : validation || commit
          ? "L’agent a terminé sa modification."
          : agent
            ? "Le résultat de l’agent reste à confirmer."
            : notStarted,
    ),
    ...(validation !== undefined || input.checks.length > 0
      ? [
          result(
            "checks",
            fromCheckpoint(validation, validation?.checkpoint.type !== "validation.started"),
            checksPassed
              ? "proved"
              : validationCancelled
                ? "cancelled"
                : agentActive && failedCheck
                  ? "repairing"
                  : validation?.checkpoint.type === "validation.started" &&
                      active?.id === validation.execution.id
                    ? "active"
                    : failedCheck
                      ? "failed"
                      : validation
                        ? cancelled
                          ? "cancelled"
                          : "unavailable"
                        : "not-started",
            checksPassed
              ? "Toutes les commandes de cette tentative ont réussi."
              : failedCheck
                ? `Tentative ${failedCheck.attempt} : ${failedCheck.name} a échoué. ${agentActive ? "Réparation en cours ; le résultat reste à vérifier." : "Le résultat reste visible dans l’historique des vérifications."}`
                : validation?.checkpoint.type === "validation.started"
                  ? "Les commandes du projet sont en cours de vérification."
                  : validation
                    ? "Résultat non confirmé."
                    : notStarted,
          ),
        ]
      : []),
    result(
      "commit-push",
      fromCheckpoint(pushed ?? commit, pushed !== undefined),
      pushed ? "proved" : commit ? "active" : "not-started",
      pushed
        ? "Le commit est poussé sur le dépôt distant."
        : commit
          ? "Commit créé ; envoi en cours."
          : notStarted,
    ),
    result(
      "pull-request",
      fromEvent(created ?? requested, created !== undefined),
      created ? "proved" : requested ? "active" : "not-started",
      created
        ? "La Pull Request est créée et attend une revue manuelle."
        : requested
          ? "GitHub crée la Pull Request."
          : notStarted,
    ),
  ];
}

interface Evidence {
  readonly occurredAt: string;
  readonly completedAt: string | null;
  readonly executionId: string | null;
}

function evidence(
  occurredAt: string,
  completedAt: string | null,
  executionId: string | null,
): Evidence {
  return { occurredAt, completedAt, executionId };
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
    stringValue(payload, "message") ??
    execution?.error ??
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
        path: `projects/${lease.projectId}/workspaces/${lease.executionId}`,
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
