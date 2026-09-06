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
 */
export function applyMigrations(db: Database.Database): void {
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8"));
  }
}
