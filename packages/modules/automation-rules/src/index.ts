import type {
  ModuleHandlerContext,
  ModuleHandlerPublishInput,
} from "../../../module-sdk/src/index.js";

export const AUTOMATION_RULES_MODULE_ID = "jarvis.module.automation-rules";
export const DEVELOPMENT_IMPLEMENTATION_REQUESTED = {
  type: "development.implementation.requested",
  version: 1,
  kind: "request",
} as const;

type RuleScalar = string | number | boolean | null;
type JsonObject = Readonly<Record<string, unknown>>;
type RuleTarget = NonNullable<ModuleHandlerPublishInput["target"]>;

interface AutomationRule {
  readonly id: string;
  readonly when: {
    readonly eventType: string;
    readonly equals?: Readonly<Record<string, RuleScalar>>;
  };
  readonly emit: {
    readonly type: string;
    readonly target: RuleTarget;
    readonly payload?: JsonObject;
  };
}

interface ImplementationRequestPayload {
  readonly [key: string]: unknown;
  readonly workItemRef: string;
  readonly repositoryId: string;
  readonly baseBranch: string;
}

export interface AutomationRulesResult {
  readonly matchedRuleIds: readonly string[];
  readonly emittedEventIds: readonly string[];
}

/** Manifest handler for the scm.work-item.tag-added fact. */
export function handleWorkItemTagAdded(ctx: ModuleHandlerContext): AutomationRulesResult {
  const matchedRuleIds: string[] = [];
  const emittedEventIds: string[] = [];

  for (const rule of readRules(ctx.configuration)) {
    if (!matches(rule, ctx)) {
      continue;
    }

    const payload = implementationPayload(ctx, rule);
    const emitted = ctx.publish({
      type: rule.emit.type,
      version: DEVELOPMENT_IMPLEMENTATION_REQUESTED.version,
      kind: DEVELOPMENT_IMPLEMENTATION_REQUESTED.kind,
      subject: ctx.event.subject,
      repositoryId: payload.repositoryId,
      target: rule.emit.target,
      idempotencyKey: idempotencyKey(ctx, rule.emit.target, payload.workItemRef),
      payload,
      ...(ctx.event.metadata === undefined ? {} : { metadata: ctx.event.metadata }),
    });

    matchedRuleIds.push(rule.id);
    emittedEventIds.push(emitted.id);
    break;
  }

  return { matchedRuleIds, emittedEventIds };
}

/**
 * Every configured Rule is honored or the whole Delivery fails. Dropping the
 * ones this Module cannot parse would silently change which Rule wins under
 * first-match-wins (packages/modules/automation-rules/CONTEXT.md "Rule Set"):
 * a Rule Set whose first entry emits an undeclared contract would quietly
 * promote the second, and the operator would see the Rule Set's documented
 * order disagree with what actually ran, with no diagnostic anywhere.
 */
function readRules(configuration: ModuleHandlerContext["configuration"]): AutomationRule[] {
  const rules = configuration["rules"];
  if (!Array.isArray(rules)) {
    return [];
  }

  return rules.map((value, index) => readRule(value) ?? unhonorableRule(value, index));
}

/** Identifies the offending Rule by position and, when it has a schema-shaped
 * one, its id — never by echoing configured values into the Ledger. */
function unhonorableRule(value: unknown, index: number): never {
  const id = isRecord(value) && typeof value["id"] === "string" ? value["id"] : undefined;
  throw new Error(
    `Automation Rule at index ${index}${id === undefined ? "" : ` (${id})`} is not one this Module can honor: it must match on a Fact type and emit ${DEVELOPMENT_IMPLEMENTATION_REQUESTED.type} to exactly one configured target.`,
  );
}

function readRule(value: unknown): AutomationRule | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string") {
    return undefined;
  }

  const whenValue = value["when"];
  const emitValue = value["emit"];
  const when = isRecord(whenValue) ? whenValue : undefined;
  const emit = isRecord(emitValue) ? emitValue : undefined;
  if (when === undefined || emit === undefined || typeof when["eventType"] !== "string") {
    return undefined;
  }

  const equalsValue = when["equals"];
  const payloadValue = emit["payload"];
  const equals = equalsValue === undefined ? undefined : readEquals(equalsValue);
  const target = readTarget(emit["target"]);
  const payload = payloadValue === undefined ? undefined : readObject(payloadValue);
  if (
    (equalsValue !== undefined && equals === undefined) ||
    emit["type"] !== DEVELOPMENT_IMPLEMENTATION_REQUESTED.type ||
    target === undefined ||
    (payloadValue !== undefined && payload === undefined)
  ) {
    return undefined;
  }

  return {
    id: value["id"],
    when: {
      eventType: when["eventType"],
      ...(equals === undefined ? {} : { equals }),
    },
    emit: {
      type: emit["type"],
      target,
      ...(payload === undefined ? {} : { payload }),
    },
  };
}

function readEquals(value: unknown): Readonly<Record<string, RuleScalar>> | undefined {
  const object = readObject(value);
  if (object === undefined) {
    return undefined;
  }

  const equals: Record<string, RuleScalar> = {};
  for (const [path, expected] of Object.entries(object)) {
    if (!isRuleScalar(expected)) {
      return undefined;
    }
    equals[path] = expected;
  }
  return equals;
}

function readTarget(value: unknown): RuleTarget | undefined {
  const target = readObject(value);
  if (target === undefined) {
    return undefined;
  }

  const binding = target["binding"];
  const moduleInstanceId = target["moduleInstanceId"];
  if (typeof binding === "string" && binding.length > 0 && moduleInstanceId === undefined) {
    return { binding };
  }
  if (
    typeof moduleInstanceId === "string" &&
    moduleInstanceId.length > 0 &&
    binding === undefined
  ) {
    return { moduleInstanceId };
  }
  return undefined;
}

function matches(rule: AutomationRule, ctx: ModuleHandlerContext): boolean {
  if (ctx.event.kind !== "fact" || rule.when.eventType !== ctx.event.type) {
    return false;
  }

  return Object.entries(rule.when.equals ?? {}).every(([path, expected]) => {
    const field = /^payload\.([A-Za-z0-9_-]+)$/.exec(path)?.[1];
    return (
      field !== undefined &&
      Object.hasOwn(ctx.event.payload, field) &&
      ctx.event.payload[field] === expected
    );
  });
}

/**
 * The Emission Template's merge rule (packages/modules/automation-rules/CONTEXT.md
 * "Emission Template"): a Rule's static `emit.payload` wins over every derived
 * value, and whatever it leaves unset is derived — `workItemRef` from the input
 * Fact, `repositoryId` and `baseBranch` from the activated project-scoped
 * context. The reference composition configures no `emit.payload` at all and is
 * fully derived by this rule.
 *
 * Nothing is invented: a required field with neither a static value nor a
 * project-scoped source throws, which the Delivery Consumer records as a
 * terminal failed Execution, rather than emitting a Request naming a repository
 * or branch that does not exist. The Fact's own payload is never consulted for
 * the repository or the branch — AGENTS.md invariant 11 makes external work-item
 * content untrusted input, and `scm.work-item.tag-added.v1` carries neither field.
 */
function implementationPayload(
  ctx: ModuleHandlerContext,
  rule: AutomationRule,
): ImplementationRequestPayload {
  const configured = rule.emit.payload ?? {};
  return {
    ...configured,
    workItemRef:
      readNonEmptyString(configured["workItemRef"]) ??
      readNonEmptyString(ctx.event.payload["workItemRef"]) ??
      ctx.event.subject.ref,
    repositoryId:
      readNonEmptyString(configured["repositoryId"]) ??
      readNonEmptyString(ctx.repositoryId) ??
      unresolved(rule, "repositoryId"),
    baseBranch:
      readNonEmptyString(configured["baseBranch"]) ??
      readNonEmptyString(ctx.repositoryDefaultBranch) ??
      unresolved(rule, "baseBranch"),
  };
}

function unresolved(rule: AutomationRule, field: string): never {
  throw new Error(
    `Automation Rule ${rule.id} cannot emit ${rule.emit.type}: ${field} has no static value and the activated Project supplies none.`,
  );
}

function idempotencyKey(
  ctx: ModuleHandlerContext,
  target: RuleTarget,
  workItemRef: string,
): string {
  const targetRef = target.moduleInstanceId ?? target.binding ?? "target";
  const generation = ctx.event.metadata?.generation ?? 1;
  const itemRef = normalizeWorkItemRef(workItemRef);
  const key = `${ctx.projectId}:${itemRef}:${targetRef}:${generation}`;
  if (key.length <= 256) {
    return key;
  }

  return `${ctx.projectId}:${ctx.event.id}:${targetRef}:${generation}`;
}

function normalizeWorkItemRef(ref: string): string {
  const issueNumber = /\/issues\/([^/]+)$/.exec(ref)?.[1];
  if (issueNumber !== undefined) {
    return `issue-${issueNumber}`;
  }

  return ref.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "work-item";
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readObject(value: unknown): JsonObject | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRuleScalar(value: unknown): value is RuleScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}
