import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { StoredPortableProjectConfiguration } from "../../../../packages/project-runtime/src/project-types.js";
import type { ClaimedDelivery } from "../executions/delivery-consumer.js";
import { SAMPLE_PROBE_MODULE_ID } from "../executions/sample-probe-module.js";
import { EventPublisher, type PublishEventInput } from "../events/publisher.js";
import { ProjectStore, type ResolvedProjectSnapshot } from "../projects/store.js";
import { DeliveryConsumer } from "../executions/delivery-consumer.js";
import { failpoint } from "./failpoint.js";

export interface DurabilityTestHooks {
  readonly db: Database.Database;
  readonly store: ProjectStore;
  readonly publisher: EventPublisher;
  readonly consumer: DeliveryConsumer;
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
 * root wires for production (`EventPublisher`, `ProjectStore`,
 * `DeliveryConsumer`) — no test double, no bypass of Outbox/Inbox/Execution
 * Ledger. What it bypasses is Project Runtime's composition *validation*
 * (`ProjectService`), the same way `dispatcher.test.ts`/
 * `delivery-consumer.test.ts` call `ProjectStore` directly: the sample Module
 * fixture has no Module Manifest and could never pass that validation, and
 * teaching it one would make it a real Module Package, which is out of scope.
 */
export function registerDurabilityTestRoutes(
  app: FastifyInstance,
  hooks: DurabilityTestHooks,
): void {
  // Seeds a Project whose Resolved Project already has one enabled Module
  // Instance of the sample-probe fixture consuming `sample.probe.pinged` —
  // the minimum a real activation would have produced, had the fixture been
  // a real Module Package.
  app.post("/test/projects", async (request, reply) => {
    const body = request.body as { readonly id: string; readonly moduleInstanceId?: string };
    const moduleInstanceId = body.moduleInstanceId ?? "probe-1";
    const config = sampleProjectConfig(body.id);
    hooks.store.createProject({
      id: body.id,
      name: body.id,
      status: "draft",
      portableConfig: config,
      repositoryPath: `/tmp/${body.id}`,
    });
    const snapshot: ResolvedProjectSnapshot = {
      composition: config,
      moduleInstances: [
        { instanceId: moduleInstanceId, moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true },
      ],
      bindings: { slots: {}, repository: { path: `/tmp/${body.id}`, bookmarkRef: null } },
      requestRoutes: [],
    };
    hooks.store.activateProject(body.id, "test-fingerprint", snapshot);
    void reply.code(201).send({ id: body.id, moduleInstanceId });
  });

  // The inbound trigger: publishes one Event through the real
  // `EventPublisher`, inside the same kind of ambient transaction a real
  // Module's handler would open (docs/architecture/EVENTS.md "Event
  // transaction rule"). The `after-outbox-commit` failpoint sits exactly on
  // ticket #58's headline boundary: committed to the Outbox, not yet
  // dispatched.
  app.post("/test/events", async (request, reply) => {
    const input = request.body as PublishEventInput;
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
    const delivery = request.body as ClaimedDelivery;
    const outcome = hooks.consumer.consume(delivery);
    void reply.code(200).send(outcome);
  });
}

function sampleProjectConfig(id: string): StoredPortableProjectConfiguration {
  return {
    apiVersion: "jarvis.dev/project/v1",
    kind: "Project",
    metadata: { id, name: id },
    repositories: [{ id: "main", root: ".", defaultBranch: "main", remote: "origin" }],
    slots: {},
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
