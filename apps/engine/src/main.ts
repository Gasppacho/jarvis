import { readdirSync, readFileSync, writeSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { SystemClock } from "../../../packages/kernel/src/clock.js";
import { SystemIdGenerator } from "../../../packages/kernel/src/id-generator.js";
import {
  EventEnvelopeContractRegistry,
  type EventPayloadContract,
} from "../../../packages/eventing/src/envelope.js";
import { resolveRequestConsumer as resolveProjectRequestConsumer } from "../../../packages/eventing/src/routing.js";
import { deriveProjectSubscriptions } from "../../../packages/project-runtime/src/project-subscriptions.js";
import { SavedProjectCompositionValidator } from "../../../packages/project-runtime/src/composition-validator.js";
import {
  AUTOMATION_RULES_MODULE_ID,
  handleWorkItemTagAdded,
} from "../../../packages/modules/automation-rules/src/index.js";
import { ConfigError, loadConfig } from "./config.js";
import { openDatabase, type DatabaseState, type OpenedDatabase } from "./db/open.js";
import { buildServer } from "./http/server.js";
import { watchParentProcess } from "./parent-watch.js";
import { API_VERSION } from "./version.js";
import { AtomicProjectConfigurationWriter } from "./projects/repository-config-writer.js";
import { LocalRepositoryAccessibility } from "./projects/repository-accessibility.js";
import { ProjectService, RepositoryDiscoveryService } from "./projects/service.js";
import { EventJournalReader } from "./events/timeline.js";
import { ExecutionLedgerReader } from "./executions/ledger.js";
import { EmptyProjectResourceGrants } from "./projects/resource-grants.js";
import { ProjectStore } from "./projects/store.js";
import { loadBundledModuleHost } from "./modules/bundled-module-registry.js";
import { EventPublisher } from "./events/publisher.js";
import {
  DEFAULT_LEASE_MS,
  OutboxDispatcher,
  type RequestConsumerResolver,
  type OpenSubscriptionsPort,
} from "./events/dispatcher.js";
import { startEventLoop } from "./events/dispatch-loop.js";
import {
  DeliveryConsumer,
  type ModuleConfigurationLookup,
  type ModuleHandler,
  type ModuleHandlerLookup,
  type ModulePublishedContractsLookup,
  type ModuleRepositoryDefaultBranchLookup,
} from "./executions/delivery-consumer.js";
import {
  SAMPLE_PROBE_MODULE_ID,
  SAMPLE_PROBE_PINGED,
  createSampleProbeSchema,
  createSampleProbeHandler,
} from "./executions/sample-probe-module.js";
import type { DurabilityTestHooks } from "./test-support/durability-test-routes.js";
import { LiveUpdateHub } from "./stream/hub.js";

/** See apps/engine/src/events/dispatcher.ts's identical declaration for why
 * this exists and how tsup.config.ts's `define` makes it eliminate the
 * `JARVIS_ENABLE_TEST_HOOKS` check below from the production bundle. */
declare const __JARVIS_TEST_HOOKS__: boolean | undefined;

const SHUTDOWN_GRACE_MS = 5_000;
const STDERR_FD = 2;
const REQUEST_WORKER_MODULE_ID = "jarvis.test.request-worker";
const REQUEST_WORKER_CONTRACT = {
  type: "development.implementation.requested",
  version: 1,
  kind: "request" as const,
};
const requestWorkerHandler: ModuleHandler = () => ({ handled: true });
/**
 * Measured on macOS rather than argued from the docs, because two readings of
 * them disagreed:
 *
 *   - `process.stderr.write` of 200 KB followed by `process.exit` delivers only
 *     65 536 bytes to a pipe. The tail — the part that names the failure — is
 *     lost every time.
 *   - `process.stderr.write` to a closed pipe does not throw; it emits an async
 *     `error`, which without a listener kills the process. That is fatal on the
 *     orphan path, where the shell is gone by definition and the write happens
 *     just before the database is closed.
 *   - `writeSync` delivers all 200 KB before exit, and throws EPIPE
 *     synchronously, which a `try` can actually contain.
 *
 * So: synchronous write, guarded. Never throws — every caller either is on its
 * way out or must keep the engine reachable, and losing the process before the
 * message is out is worse than losing the message.
 */
function report(message: string): void {
  try {
    writeSync(STDERR_FD, message);
  } catch {
    /* the shell is gone; there is nobody left to tell */
  }
}

async function main(): Promise<void> {
  // Pino writes to this stream on every request. Once the shell is gone the
  // write fails asynchronously, and an unhandled `error` would take the engine
  // down before it could close the database.
  process.stderr.on("error", () => {});

  const config = loadConfig(process.env);
  // Ticket #60: one per Engine Session, keyed by the same `sessionId` the
  // ready handshake already reports to the shell (config.ts) — the Engine
  // Session identifier this ticket's stream reuses rather than inventing a
  // second one.
  const liveUpdates = new LiveUpdateHub(config.sessionId);
  const runtimeRoot = dirname(fileURLToPath(import.meta.url));
  const modules = loadBundledModuleHost(runtimeRoot);
  for (const diagnostic of modules.diagnostics()) {
    report(
      `jarvis-engine: rejected bundled Module Package ${diagnostic.packageName}: ${diagnostic.issues.join("; ")}\n`,
    );
  }

  let opened: OpenedDatabase | undefined;
  let app: FastifyInstance | undefined;
  let shuttingDown = false;
  let announced = false;
  let stopEventLoop: (() => void) | undefined;

  /** Returns false when the WAL could not be checkpointed. */
  function closeDatabase(): boolean {
    if (opened === undefined) return true;
    try {
      if (opened.db.open) opened.db.close();
      return true;
    } catch (error) {
      report(`jarvis-engine: could not close the database.\n${String(error)}\n`);
      return false;
    }
  }

  async function shutdown(exitCode: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    // Deliberately not unref'd: if closing hangs and the remaining handles
    // drain, an unref'd timer would let Node exit 0 without closing the
    // database. The `finally` below always calls process.exit, so this timer
    // can never delay a shutdown that does complete.
    setTimeout(() => {
      report("jarvis-engine: shutdown timed out; forcing exit.\n");
      closeDatabase();
      process.exit(exitCode === 0 ? 1 : exitCode);
    }, SHUTDOWN_GRACE_MS);

    let code = exitCode;
    try {
      // Stopped before the database closes: a tick that started while the
      // engine listened must not run against a handle that has since closed.
      stopEventLoop?.();
      // Ticket #60: Fastify's default `forceCloseConnections: "idle"` does
      // not consider an open SSE response idle (it is a request Fastify is
      // still actively responding to), so `app.close()` below would wait on
      // it indefinitely. Ending every open stream first is what keeps
      // shutdown prompt with a client still attached.
      liveUpdates.closeAll();
      if (app !== undefined) await app.close();
    } catch (error) {
      report(`jarvis-engine: shutdown failed.\n${String(error)}\n`);
      code = 1;
    } finally {
      // Closing the handle is what checkpoints the WAL, so its failure is the
      // one that must not be reported as a clean shutdown.
      if (!closeDatabase()) code = 1;
      process.exit(code);
    }
  }

  // Registered before the database is opened so no startup phase is ever left
  // under the default signal disposition. openDatabase is synchronous today, so
  // a signal during migrations is queued rather than handled mid-flight; this
  // ordering is what keeps that true if any of it becomes async.
  // Exits non-zero until the handshake is out, so the shell never reads a clean
  // exit from an engine that never became ready.
  const onSignal = (): void => void shutdown(announced ? 0 : 1);
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  // Registered before the database is opened so that no *asynchronous* phase
  // of startup is left unwatched.
  //
  // ponytail: it cannot fire during migrations themselves — openDatabase is
  // synchronous and blocks the event loop, so a shell that dies mid-migration
  // is noticed only once it returns. Migrations are a single small file today;
  // revisit with an explicit orphan check between steps if they grow.
  watchParentProcess({
    onOrphaned: () => {
      report("jarvis-engine: the shell went away; shutting down.\n");
      void shutdown(announced ? 0 : 1);
    },
  });

  // SYSTEM.md startup protocol: migrations complete before the ready handshake,
  // so the shell never sees a `ready` engine with an unmigrated database.
  //
  // Ticket 02: a database that cannot be opened degrades the engine instead of
  // killing it. The shell stays up, `/v1/health` reports degraded and the
  // project routes answer 503 until the database is reachable again, so the
  // app can explain what is wrong (MVP_SPEC.md user story 3). No safety guard
  // above is bypassed: a degraded engine creates no database file, it only
  // reports that it cannot.
  try {
    opened = openDatabase(config.databasePath);
  } catch (error) {
    report(
      `jarvis-engine: the database could not be opened: ${String(error)}\n` +
        "Continuing degraded: /v1/health reports degraded and project routes answer 503 engine.database-unavailable.\n",
    );
  }
  const database = opened;
  const repositoryDiscovery = new RepositoryDiscoveryService();
  const resourceGrants = new EmptyProjectResourceGrants();
  const projectStore =
    database === undefined ? undefined : new ProjectStore(database.db, new SystemClock());
  const projects =
    database === undefined || projectStore === undefined
      ? undefined
      : new ProjectService(
          projectStore,
          modules,
          new AtomicProjectConfigurationWriter(),
          resourceGrants,
          new SavedProjectCompositionValidator(modules),
          new LocalRepositoryAccessibility(),
          new EventJournalReader(database.db),
          new ExecutionLedgerReader(database.db),
        );

  // Ticket #58 ("the whole durable path must be demonstrable end to end"):
  // Outbox dispatcher, Delivery consumer and their loop are wired for real,
  // unconditionally, using the same `ProjectStore`/`ModuleHost` routing a real
  // Module Instance would resolve through (docs/architecture/EVENTS.md
  // "Routing > Facts"). The Automation Rules handler is registered here;
  // provider adapters will become additional production event sources in
  // later tickets. The loop is also reachable through the test-only inbound
  // publication route below, without making that route part of the product API.
  //
  // `JARVIS_ENABLE_TEST_HOOKS=1` additively registers an inbound publication
  // route for the Application Harness. See test-support/
  // durability-test-routes.ts's module doc comment for why that is test-only
  // rather than a product API.
  //
  // Review fix for ticket #58: the `JARVIS_ENABLE_TEST_HOOKS` check itself is
  // gated behind the same compile-time `__JARVIS_TEST_HOOKS__` flag
  // dispatcher.ts and delivery-consumer.ts declare (tsup.config.ts's
  // `define`), so the production entry never even carries this env var name
  // as a string — an ambient `launchctl setenv JARVIS_ENABLE_TEST_HOOKS 1`
  // has nothing to turn on there.
  let testHooksEnabled = false;
  if (typeof __JARVIS_TEST_HOOKS__ === "undefined" || __JARVIS_TEST_HOOKS__) {
    testHooksEnabled = process.env["JARVIS_ENABLE_TEST_HOOKS"] === "1";
  }
  let durabilityTestHooks: DurabilityTestHooks | undefined;
  if (database !== undefined && projectStore !== undefined) {
    const clock = new SystemClock();
    const ids = new SystemIdGenerator();
    const envelopeSchemaPath = join(
      runtimeRoot,
      "contracts",
      "schemas",
      "event-envelope.v1.schema.json",
    );
    const envelopes = new EventEnvelopeContractRegistry({
      eventEnvelopeV1: JSON.parse(readFileSync(envelopeSchemaPath, "utf8")) as object,
      eventPayloads: loadEventPayloadContracts(runtimeRoot),
    });
    const publisher = new EventPublisher(database.db, clock, ids, envelopes);
    const sampleProbeHandler = createSampleProbeHandler(database.db);
    const openSubscriptions: OpenSubscriptionsPort = (projectId) =>
      deriveProjectSubscriptions(
        projectId,
        projectStore.getResolvedProject(projectId)?.moduleInstances ?? [],
        {
          composition: (moduleId) => {
            const bundled = modules.composition(moduleId);
            if (bundled !== undefined) return bundled;
            if (!testHooksEnabled) return undefined;
            if (moduleId === SAMPLE_PROBE_MODULE_ID) return { consumes: [SAMPLE_PROBE_PINGED] };
            if (moduleId === REQUEST_WORKER_MODULE_ID) {
              return { consumes: [REQUEST_WORKER_CONTRACT] };
            }
            return undefined;
          },
        },
      ).items;
    const requestConsumerResolver: RequestConsumerResolver = (projectId, envelope) => {
      const snapshot = projectStore.getResolvedProject(projectId);
      return snapshot === undefined ? undefined : resolveProjectRequestConsumer(envelope, snapshot);
    };
    const configurations: ModuleConfigurationLookup = (projectId, moduleInstanceId) =>
      projectStore
        .getResolvedProject(projectId)
        ?.moduleInstances.find((instance) => instance.instanceId === moduleInstanceId)
        ?.configuration;
    const repositoryDefaultBranches: ModuleRepositoryDefaultBranchLookup = (
      projectId,
      repositoryId,
    ) => {
      const repositories =
        projectStore.getResolvedProject(projectId)?.composition.repositories ?? [];
      return (
        repositories.find((repository) => repository.id === repositoryId)?.defaultBranch ??
        repositories[0]?.defaultBranch
      );
    };
    const publishedContracts: ModulePublishedContractsLookup = (moduleId) =>
      modules.composition(moduleId)?.produces;
    // Test tuning only (docs/engineering/TEST_FIXTURES.md): a normally
    // launched engine never sets this, and the default matches the
    // production lease `OutboxDispatcher` has always used.
    const leaseMs = parseLeaseMs(process.env["JARVIS_OUTBOX_LEASE_MS"]) ?? DEFAULT_LEASE_MS;
    const dispatcher = new OutboxDispatcher(
      database.db,
      clock,
      ids,
      envelopes,
      openSubscriptions,
      leaseMs,
      requestConsumerResolver,
    );
    const handlers: ModuleHandlerLookup = (moduleId) => {
      if (moduleId === AUTOMATION_RULES_MODULE_ID) return handleWorkItemTagAdded;
      if (testHooksEnabled && moduleId === SAMPLE_PROBE_MODULE_ID) return sampleProbeHandler;
      if (testHooksEnabled && moduleId === REQUEST_WORKER_MODULE_ID) return requestWorkerHandler;
      return undefined;
    };
    if (testHooksEnabled) createSampleProbeSchema(database.db);
    const consumer = new DeliveryConsumer(
      database.db,
      clock,
      ids,
      publisher,
      handlers,
      configurations,
      repositoryDefaultBranches,
      publishedContracts,
    );
    stopEventLoop = startEventLoop({ db: database.db, dispatcher, consumer, liveUpdates });
    if (testHooksEnabled) {
      durabilityTestHooks = { db: database.db, store: projectStore, publisher, consumer };
    }
  }

  app = buildServer({
    config,
    databaseState: (): DatabaseState => database?.state() ?? "failed",
    repositoryDiscovery,
    projects,
    modules,
    isShuttingDown: () => shuttingDown,
    onShutdownRequested: () => {
      void shutdown(0);
    },
    liveUpdates,
    ...(durabilityTestHooks === undefined ? {} : { durabilityTestHooks }),
  });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    // The migrations have already run, so bailing here without closing would
    // leave the whole schema in an un-checkpointed WAL.
    closeDatabase();
    throw error;
  }
  const address = app.server.address() as AddressInfo;

  // The one and only stdout line. Everything else the engine says goes to stderr.
  process.stdout.write(
    `${JSON.stringify({
      type: "ready",
      port: address.port,
      apiVersion: API_VERSION,
      sessionId: config.sessionId,
    })}\n`,
  );
  announced = true;
}

function loadEventPayloadContracts(runtimeRoot: string): readonly EventPayloadContract[] {
  return readdirSync(join(runtimeRoot, "contracts", "events"), { withFileTypes: true }).flatMap(
    (entry) => {
      if (!entry.isFile()) return [];
      const match = /^(.*)\.v(\d+)\.schema\.json$/.exec(entry.name);
      if (match === null) return [];
      return [
        {
          type: match[1]!,
          version: Number(match[2]),
          schema: JSON.parse(
            readFileSync(join(runtimeRoot, "contracts", "events", entry.name), "utf8"),
          ) as object,
        },
      ];
    },
  );
}

/** `undefined` for unset/empty/non-numeric, same convention as config.ts's `parsePort`. */
function parseLeaseMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "" || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

main().catch((error: unknown) => {
  // Bootstrap failures must be actionable: the shell surfaces this text verbatim.
  if (error instanceof ConfigError) {
    report(`jarvis-engine: ${error.message}\n${error.remedy}\n`);
  } else {
    report(`jarvis-engine: failed to start.\n${String(error)}\n`);
  }
  process.exit(1);
});
