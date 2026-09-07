import type Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

/**
 * Applies the shipped migration files to an in-memory test database, in the
 * same order `migrate()` (apps/engine/src/db/open.ts) applies them.
 *
 * Tests whose subject *is* a schema guarantee — the `deliveries` unique index
 * that makes redispatch idempotent, the `status`/`kind` CHECK constraints —
 * must run against the real DDL, not a hand-copy that can silently drift from
 * it.
 *
 * `upToVersion` (a migration's four-digit prefix, e.g. `"0007"`) stops after
 * that migration instead of applying the whole chain. Every ordinary test
 * seeds an empty database, so its migrations never exercise a data-rewriting
 * branch (an `UPDATE ... WHERE` backfill) against a row that predates it —
 * that seam needs the chain paused mid-way, a row inserted by hand, then the
 * rest of the chain applied on top (0008_events_correlation_id.test.ts).
 */
export function applyMigrations(db: Database.Database, upToVersion?: string): void {
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .filter((name) => upToVersion === undefined || name.slice(0, 4) <= upToVersion)
    .sort()) {
    db.exec(readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8"));
  }
}

/**
 * Applies exactly one migration file by its four-digit version prefix (e.g.
 * `"0008"`), for a test that needs the chain paused mid-way — insert a row by
 * hand, then apply one more migration on top of it — rather than the whole
 * chain in one call (see `applyMigrations`'s `upToVersion`).
 */
export function applyMigration(db: Database.Database, version: string): void {
  const file = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .find((name) => name.startsWith(version));
  if (file === undefined) throw new Error(`No migration file found for version "${version}".`);
  db.exec(readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8"));
}
