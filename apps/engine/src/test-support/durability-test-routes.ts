import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
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
import type {
  WorkspaceManager,
  WorkspaceProjectConfiguration,
} from "../../../../packages/workspace/src/workspace-manager.js";

export interface DurabilityTestHooks {
  readonly db: Database.Database;
  readonly projects: ProjectService;
  readonly publisher: EventPublisher;
  readonly consumer: DeliveryConsumer;
  readonly workspace: WorkspaceManager;
  readonly testRepositoryRoot: string;
}

const TEST_WORKSPACE_PROJECT: WorkspaceProjectConfiguration = {
  git: { branchPattern: "agent/{workItemId}-{slug}" },
  workspace: { maxConcurrentExecutions: 1, retainOnFailureDays: 7 },
};

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
  // Imports and activates the sample-probe fixture through the real Project
  // Service.
  app.post("/test/projects", async (request, reply) => {
    const body = readTestProjectRequest(request.body);
    const moduleInstanceId = body.moduleInstanceId ?? "probe-1";
    const config = sampleProjectConfig(body.id, moduleInstanceId);
    const repositoryPath =
      body.repositoryPath ?? join(hooks.testRepositoryRoot, "repositories", body.id);
    mkdirSync(repositoryPath, { recursive: true });
    if (!existsSync(join(repositoryPath, ".git"))) {
      mkdirSync(join(repositoryPath, ".git"));
    }
    const canonicalRepositoryPath = realpathSync(repositoryPath);
    const packageJsonPath = join(canonicalRepositoryPath, "package.json");
    const originalPackageJson = existsSync(packageJsonPath)
      ? readFileSync(packageJsonPath, "utf8")
      : undefined;
    writeFileSync(packageJsonPath, `${JSON.stringify({ name: body.id }, null, 2)}\n`, "utf8");
    const created = hooks.projects.importProject({
      repositoryPath: canonicalRepositoryPath,
      portableConfig: undefined,
    });
    if (originalPackageJson === undefined) unlinkSync(packageJsonPath);
    else writeFileSync(packageJsonPath, originalPackageJson, "utf8");
    hooks.projects.replaceProjectConfiguration({
      projectId: created.id,
      portableConfig: config,
      writeToRepository: false,
    });
    const report = await hooks.projects.preflightProject(created.id);
    if (!report.valid) {
      throw new EngineError(
        "project.activation-not-validated",
        409,
        `Test fixture Project ${created.id} did not produce a valid activation report.`,
      );
    }
    await hooks.projects.activatePreflightProject({
      projectId: created.id,
      compositionFingerprint: report.compositionFingerprint,
    });
    void reply.code(201).send({
      id: created.id,
      moduleInstanceId,
    });
  });

  app.post("/test/workspaces/allocate", async (request, reply) => {
    const body = readTestWorkspaceRequest(request.body);
    const allocation = await hooks.workspace.allocate({
      ...body,
      project: TEST_WORKSPACE_PROJECT,
      repositoryId: body.repositoryId ?? "main",
    });
    void reply.code(201).send(allocation);
  });

  app.post("/test/workspaces/release", async (request, reply) => {
    const body = readTestWorkspaceReleaseRequest(request.body);
    const released = await hooks.workspace.release({ ...body, project: TEST_WORKSPACE_PROJECT });
    void reply.code(200).send(released);
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

function baseProjectConfig(
  id: string,
  slots: PortableProjectConfiguration["slots"],
): PortableProjectConfiguration {
  return {
    apiVersion: "jarvis.dev/project/v1",
    kind: "Project",
    metadata: { id, name: id },
    repositories: [{ id: "main", root: "." }],
    slots,
    modules: [],
  };
}

function readTestProjectRequest(value: unknown): {
  readonly id: string;
  readonly kind: "sample";
  readonly moduleInstanceId?: string;
  readonly repositoryPath?: string;
} {
  if (!isRecord(value)) {
    throw new EngineError("api.invalid-request", 400, "Test Project request must be an object.");
  }
  const id = value["id"];
  const kind = value["kind"] ?? "sample";
  const moduleInstanceId = value["moduleInstanceId"];
  const repositoryPath = value["repositoryPath"];
  if (
    typeof id !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(id) ||
    kind !== "sample" ||
    (moduleInstanceId !== undefined &&
      (typeof moduleInstanceId !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(moduleInstanceId))) ||
    (repositoryPath !== undefined &&
      (typeof repositoryPath !== "string" || !isAbsolute(repositoryPath)))
  ) {
    throw new EngineError("api.invalid-request", 400, "Test Project request is invalid.");
  }
  return {
    id,
    kind,
    ...(moduleInstanceId === undefined ? {} : { moduleInstanceId }),
    ...(repositoryPath === undefined ? {} : { repositoryPath }),
  };
}

function readTestWorkspaceRequest(value: unknown): {
  readonly projectId: string;
  readonly executionId: string;
  readonly repositoryId?: string;
  readonly repositoryPath: string;
  readonly baseRevision: string;
  readonly branchContext: { readonly workItemId: string; readonly slug: string };
  readonly expiresAt?: string;
} {
  if (!isRecord(value)) invalidTestRequest("Workspace allocation request must be an object.");
  const branchContext = readRecord(value["branchContext"], "branchContext");
  const request = {
    projectId: readRequiredString(value["projectId"], "projectId"),
    executionId: readRequiredString(value["executionId"], "executionId"),
    repositoryPath: readRequiredString(value["repositoryPath"], "repositoryPath"),
    baseRevision: readRequiredString(value["baseRevision"], "baseRevision"),
    branchContext: {
      workItemId: readRequiredString(branchContext["workItemId"], "branchContext.workItemId"),
      slug: readRequiredString(branchContext["slug"], "branchContext.slug"),
    },
    ...(value["repositoryId"] === undefined
      ? {}
      : { repositoryId: readRequiredString(value["repositoryId"], "repositoryId") }),
    ...(value["expiresAt"] === undefined
      ? {}
      : { expiresAt: readRequiredString(value["expiresAt"], "expiresAt") }),
  };
  if (!isAbsolute(request.repositoryPath)) {
    invalidTestRequest("Workspace allocation repositoryPath must be absolute.");
  }
  return request;
}

function readTestWorkspaceReleaseRequest(value: unknown): {
  readonly projectId: string;
  readonly executionId: string;
  readonly repositoryPath: string;
  readonly outcome: "success" | "failure" | "cancelled";
} {
  if (!isRecord(value)) invalidTestRequest("Workspace release request must be an object.");
  const outcome = value["outcome"];
  const repositoryPath = readRequiredString(value["repositoryPath"], "repositoryPath");
  if (
    !isAbsolute(repositoryPath) ||
    !["success", "failure", "cancelled"].includes(String(outcome))
  ) {
    invalidTestRequest("Workspace release request is invalid.");
  }
  return {
    projectId: readRequiredString(value["projectId"], "projectId"),
    executionId: readRequiredString(value["executionId"], "executionId"),
    repositoryPath,
    outcome: outcome as "success" | "failure" | "cancelled",
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
