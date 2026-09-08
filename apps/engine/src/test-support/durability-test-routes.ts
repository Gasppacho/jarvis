import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { PortableProjectConfiguration } from "../../../../packages/project-runtime/src/project-types.js";
import type { ClaimedDelivery } from "../executions/delivery-consumer.js";
import { SAMPLE_PROBE_MODULE_ID } from "../executions/sample-probe-module.js";
import { EventPublisher, type PublishEventInput } from "../events/publisher.js";
import type { ProjectService } from "../projects/service.js";
import { DeliveryConsumer } from "../executions/delivery-consumer.js";
import { EngineError } from "../errors.js";
import { failpoint } from "./failpoint.js";

const AUTOMATION_RULES_MODULE_ID = "jarvis.module.automation-rules";
const AUTOMATION_RULE_BINDING = "implementation";
const AUTOMATION_RULE_SLOT = "implementation-slot";
const REQUEST_WORKER_MODULE_ID = "jarvis.module.test-request-worker";
const REQUEST_WORKER_INSTANCE_ID = "request-worker";
const IMPLEMENTATION_REQUESTED_CONTRACT = {
  type: "development.implementation.requested",
  version: 1,
  kind: "request" as const,
};

export interface DurabilityTestHooks {
  readonly db: Database.Database;
  readonly projects: ProjectService;
  readonly publisher: EventPublisher;
  readonly consumer: DeliveryConsumer;
  readonly testRepositoryRoot: string;
}

/**
 * Ticket #58's "wiring decision": the smallest honest inbound trigger for a
 * durability demonstration, not the product's event-ingestion API (#7). Real
 * only when `JARVIS_ENABLE_TEST_HOOKS=1` — main.ts never constructs
 * `DurabilityTestHooks` otherwise, so `buildServer` never calls
 * `registerDurabilityTestRoutes` and these routes do not exist on a normally
 * launched engine (see `apps/engine/test/durability.integration.test.ts`'s
 * "no /test route exists" assertion). Deliberately outside `/v1`: this is not
 * a versioned Local API contract, so it carries none of the OpenAPI/contract
 * sync obligations `docs/contracts/LOCAL_API_V1.md` places on `/v1/*`.
 *
 * Each route is a thin pass-through to the same real ports the composition
 * root wires for production (`ProjectService`, `EventPublisher` and
 * `DeliveryConsumer`) — no test double, no bypass of Project Runtime's
 * composition validation, Outbox, Inbox or Execution Ledger. The two
 * deterministic fixture manifests are compiled into the test bundle only.
 */
export function registerDurabilityTestRoutes(
  app: FastifyInstance,
  hooks: DurabilityTestHooks,
): void {
  // Imports and activates either the sample-probe fixture or the Automation
  // Rules vertical slice through the real Project Service.
  app.post("/test/projects", async (request, reply) => {
    const body = readTestProjectRequest(request.body);
    const automation = body.kind === "automation";
    const moduleInstanceId = body.moduleInstanceId ?? (automation ? "automation-rules" : "probe-1");
    const config = automation
      ? automationProjectConfig(body.id, moduleInstanceId, body.targetMode, body.ruleTag)
      : sampleProjectConfig(body.id, moduleInstanceId);
    const repositoryPath = join(hooks.testRepositoryRoot, "repositories", body.id);
    mkdirSync(repositoryPath, { recursive: true });
    const created = hooks.projects.importProject({
      repositoryPath,
      portableConfig: config,
    });
    if (automation) {
      hooks.projects.replaceProjectBindings({
        projectId: created.id,
        bindings: {
          apiVersion: "jarvis.dev/project-bindings/v1",
          kind: "ProjectBindings",
          projectId: created.id,
          repositories: { main: { path: repositoryPath, bookmarkRef: null } },
          slots: {
            [AUTOMATION_RULE_SLOT]: {
              kind: "module-instance",
              ref: REQUEST_WORKER_INSTANCE_ID,
            },
          },
        },
      });
    }
    const report = hooks.projects.validateProject(created.id);
    if (!report.valid || typeof report.compositionFingerprint !== "string") {
      throw new EngineError(
        "project.activation-not-validated",
        409,
        `Test fixture Project ${created.id} did not produce a valid activation report.`,
      );
    }
    hooks.projects.activateProject({
      projectId: created.id,
      compositionFingerprint: report.compositionFingerprint,
    });
    void reply.code(201).send({
      id: created.id,
      moduleInstanceId,
      ...(automation ? { workerModuleInstanceId: REQUEST_WORKER_INSTANCE_ID } : {}),
    });
  });

  // The inbound trigger: publishes one Event through the real
  // `EventPublisher`, inside the same kind of ambient transaction a real
  // Module's handler would open (docs/architecture/EVENTS.md "Event
  // transaction rule"). The `after-outbox-commit` failpoint sits exactly on
  // ticket #58's headline boundary: committed to the Outbox, not yet
  // dispatched.
  app.post("/test/events", async (request, reply) => {
    const input = readPublishEventInput(request.body);
    const envelope = hooks.db.transaction(() => hooks.publisher.publish(input))();
    failpoint("after-outbox-commit");
    void reply.code(201).send(envelope);
  });

  // A manual redelivery: calls the same `DeliveryConsumer.consume` the event
  // loop calls, for a Delivery the caller already knows the identity of. This
  // is what makes acceptance criterion 4 observable — after a crash right
  // after the handler's transaction commits, the loop has nothing left
  // "unconsumed" to retry (the Delivery was already marked consumed in that
  // same transaction), so proving the redelivery contract still holds needs
  // an explicit second delivery of the same event, exactly like a real
  // at-least-once redelivery would produce.
  app.post("/test/redeliver", async (request, reply) => {
    const delivery = readClaimedDelivery(request.body);
    const outcome = hooks.consumer.consume(delivery);
    void reply.code(200).send(outcome);
  });
}

function sampleProjectConfig(id: string, moduleInstanceId: string): PortableProjectConfiguration {
  return {
    ...baseProjectConfig(id, { "sample-slot": { requires: "work-items.read", optional: true } }),
    modules: [{ instanceId: moduleInstanceId, moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true }],
  };
}

function automationProjectConfig(
  id: string,
  automationInstanceId: string,
  targetMode: "binding" | "direct",
  ruleTag: string,
): PortableProjectConfiguration {
  return {
    ...baseProjectConfig(id, {
      [AUTOMATION_RULE_SLOT]: { requires: "work-items.read" },
    }),
    modules: [
      {
        instanceId: automationInstanceId,
        moduleId: AUTOMATION_RULES_MODULE_ID,
        enabled: true,
        configuration: {
          rules: [
            {
              id: "ready-label-starts-development",
              when: {
                eventType: "scm.work-item.tag-added",
                equals: { "payload.tag": ruleTag },
              },
              emit: {
                type: IMPLEMENTATION_REQUESTED_CONTRACT.type,
                target:
                  targetMode === "direct"
                    ? { moduleInstanceId: REQUEST_WORKER_INSTANCE_ID }
                    : { binding: AUTOMATION_RULE_BINDING },
              },
            },
          ],
        },
        bindings: { [AUTOMATION_RULE_BINDING]: AUTOMATION_RULE_SLOT },
      },
      { instanceId: REQUEST_WORKER_INSTANCE_ID, moduleId: REQUEST_WORKER_MODULE_ID, enabled: true },
    ],
  };
}

function baseProjectConfig(
  id: string,
  slots: PortableProjectConfiguration["slots"],
): PortableProjectConfiguration {
  return {
    apiVersion: "jarvis.dev/project/v1",
    kind: "Project",
    metadata: { id, name: id },
    repositories: [{ id: "main", root: ".", defaultBranch: "main", remote: "origin" }],
    slots,
    commands: {},
    git: {
      branchPattern: "agent/{workItemId}-{slug}",
      commitStrategy: "conventional",
      pushRemote: "origin",
      allowForcePush: false,
    },
    workspace: { strategy: "git-worktree", maxConcurrentExecutions: 1, retainOnFailureDays: 7 },
    modules: [],
  };
}

function readTestProjectRequest(value: unknown): {
  readonly id: string;
  readonly kind: "sample" | "automation";
  readonly moduleInstanceId?: string;
  readonly targetMode: "binding" | "direct";
  readonly ruleTag: string;
} {
  if (!isRecord(value)) {
    throw new EngineError("api.invalid-request", 400, "Test Project request must be an object.");
  }
  const id = value["id"];
  const kind = value["kind"] ?? "sample";
  const moduleInstanceId = value["moduleInstanceId"];
  const targetMode = value["targetMode"] ?? "binding";
  const ruleTag = value["ruleTag"] ?? "agent:ready";
  if (
    typeof id !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(id) ||
    (kind !== "sample" && kind !== "automation") ||
    (moduleInstanceId !== undefined &&
      (typeof moduleInstanceId !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(moduleInstanceId))) ||
    (targetMode !== "binding" && targetMode !== "direct") ||
    typeof ruleTag !== "string" ||
    ruleTag.length === 0 ||
    ruleTag.length > 100
  ) {
    throw new EngineError("api.invalid-request", 400, "Test Project request is invalid.");
  }
  return {
    id,
    kind,
    ...(moduleInstanceId === undefined ? {} : { moduleInstanceId }),
    targetMode,
    ruleTag,
  };
}

function readPublishEventInput(value: unknown): PublishEventInput {
  if (!isRecord(value)) invalidTestRequest("Event request must be an object.");
  const producer = readRecord(value["producer"], "producer");
  const subject = readRecord(value["subject"], "subject");
  const causationId = value["causationId"];
  if (causationId !== null && typeof causationId !== "string") {
    invalidTestRequest("Event request field causationId is invalid.");
  }
  const kind = value["kind"];
  if (kind !== "request" && kind !== "fact") {
    invalidTestRequest("Event request field kind is invalid.");
  }
  const repositoryId = readOptionalString(value["repositoryId"], "repositoryId");
  const target = readOptionalTarget(value["target"]);
  const idempotencyKey = readOptionalString(value["idempotencyKey"], "idempotencyKey");
  const metadata = readOptionalRecord(value["metadata"], "metadata");
  return {
    type: readRequiredString(value["type"], "type"),
    version: readPositiveInteger(value["version"], "version"),
    kind,
    projectId: readRequiredString(value["projectId"], "projectId"),
    producer: {
      moduleId: readRequiredString(producer["moduleId"], "producer.moduleId"),
      moduleInstanceId: readRequiredString(
        producer["moduleInstanceId"],
        "producer.moduleInstanceId",
      ),
    },
    subject: {
      type: readRequiredString(subject["type"], "subject.type"),
      ref: readRequiredString(subject["ref"], "subject.ref"),
    },
    correlationId: readRequiredString(value["correlationId"], "correlationId"),
    causationId,
    payload: readRecord(value["payload"], "payload"),
    ...(repositoryId === undefined ? {} : { repositoryId }),
    ...(target === undefined ? {} : { target }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function readClaimedDelivery(value: unknown): ClaimedDelivery {
  if (!isRecord(value)) invalidTestRequest("Delivery request must be an object.");
  return {
    projectId: readRequiredString(value["projectId"], "projectId"),
    moduleInstanceId: readRequiredString(value["moduleInstanceId"], "moduleInstanceId"),
    moduleId: readRequiredString(value["moduleId"], "moduleId"),
    eventId: readRequiredString(value["eventId"], "eventId"),
  };
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string") invalidTestRequest(`Event request field ${field} is invalid.`);
  return value;
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return readRequiredString(value, field);
}

function readPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    invalidTestRequest(`Event request field ${field} is invalid.`);
  }
  return value;
}

function readRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) invalidTestRequest(`Event request field ${field} is invalid.`);
  return value;
}

function readOptionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return readRecord(value, field);
}

function readOptionalTarget(value: unknown): PublishEventInput["target"] {
  if (value === undefined) return undefined;
  const target = readRecord(value, "target");
  const binding = readOptionalString(target["binding"], "target.binding");
  const moduleInstanceId = readOptionalString(
    target["moduleInstanceId"],
    "target.moduleInstanceId",
  );
  return {
    ...(binding === undefined ? {} : { binding }),
    ...(moduleInstanceId === undefined ? {} : { moduleInstanceId }),
  };
}

function invalidTestRequest(message: string): never {
  throw new EngineError("api.invalid-request", 400, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
