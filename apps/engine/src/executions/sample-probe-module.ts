import type Database from "better-sqlite3";
import type { ModuleHandler, ModuleHandlerContext } from "./delivery-consumer.js";

/**
 * Ticket #57's deterministic sample Module fixture (issue #57 "A deterministic
 * sample Module carries the handler so the behavior is observable without any
 * real business module"; "the sample Module is a deterministic test fixture
 * and ships no business behavior"). It is not a real Module Package: it has
 * no `module.manifest.yaml`, is not in `module-registry.json`, and is never
 * reachable from a running engine (see delivery-consumer.ts's module doc
 * comment for why). It exists only for this ticket's — and #58's — tests.
 */
export const SAMPLE_PROBE_MODULE_ID = "jarvis.module.sample-probe";
export const SAMPLE_PROBE_PINGED = {
  type: "sample.probe.pinged",
  version: 1,
  kind: "fact" as const,
};
export const SAMPLE_PROBE_PONGED = {
  type: "sample.probe.ponged",
  version: 1,
  kind: "fact" as const,
};

export interface SampleProbeResult {
  readonly pingCount: number;
  readonly echoedEventId: string;
}

/**
 * The fixture's own module-owned state table (docs/architecture/PERSISTENCE.md
 * "Logical ownership": "module-specific tables: the owning module only").
 * Created ad hoc by callers — mirrors `publisher.test.ts`'s `module_state`
 * stand-in — rather than shipped in `apps/engine/src/db/migrations`, because
 * this fixture is not an official Module Package and must never appear in a
 * real user's schema.
 */
export function createSampleProbeSchema(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS sample_probe_state (
       project_id TEXT NOT NULL,
       module_instance_id TEXT NOT NULL,
       ping_count INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (project_id, module_instance_id)
     ) STRICT`,
  );
}

/**
 * Deterministic handler: increments its own per-(Project, Module Instance)
 * counter (the "Module state mutation" of issue #57's transaction), then
 * echoes a caused fact — proving the causation/correlation chain (acceptance
 * criterion 6) — unless the input payload asks it to fail
 * (`{"shouldFail": true}`), which is the deterministic failure injection the
 * redelivery-of-a-failure and rollback tests need. No randomness, no clock or
 * network dependency: the same input always produces the same outcome.
 */
export const sampleProbeHandler: ModuleHandler = (ctx: ModuleHandlerContext): SampleProbeResult => {
  const row = ctx.db
    .prepare(
      `SELECT ping_count FROM sample_probe_state WHERE project_id = ? AND module_instance_id = ?`,
    )
    .get(ctx.projectId, ctx.moduleInstanceId) as { ping_count: number } | undefined;
  const nextCount = (row?.ping_count ?? 0) + 1;

  ctx.db
    .prepare(
      `INSERT INTO sample_probe_state (project_id, module_instance_id, ping_count)
       VALUES (@projectId, @moduleInstanceId, @nextCount)
       ON CONFLICT (project_id, module_instance_id)
       DO UPDATE SET ping_count = @nextCount`,
    )
    .run({ projectId: ctx.projectId, moduleInstanceId: ctx.moduleInstanceId, nextCount });

  if (ctx.event.payload["shouldFail"] === true) {
    throw new Error("sample-probe: deterministic failure requested by payload.shouldFail");
  }

  const echoed = ctx.publish({
    type: SAMPLE_PROBE_PONGED.type,
    version: SAMPLE_PROBE_PONGED.version,
    kind: SAMPLE_PROBE_PONGED.kind,
    producer: { moduleId: SAMPLE_PROBE_MODULE_ID, moduleInstanceId: ctx.moduleInstanceId },
    subject: ctx.event.subject,
    payload: { pingCount: nextCount },
  });

  return { pingCount: nextCount, echoedEventId: echoed.id };
};
