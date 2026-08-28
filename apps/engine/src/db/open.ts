import Database from "better-sqlite3";
import { chmodSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type DatabaseState = "ready" | "migrating" | "failed";

export interface OpenedDatabase {
  readonly db: Database.Database;
  /** Live probe: `/v1/health` must report the database as it is now. */
  readonly state: () => DatabaseState;
  readonly appliedVersions: readonly string[];
}

/**
 * Migrations ship beside the bundle (`dist/engine/migrations/*`, see
 * TECHNOLOGY_STACK.md "Build outputs"). Paths derive from this module, never
 * from the current working directory.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

export function openDatabase(databasePath: string): OpenedDatabase {
  // LOCAL_DEVELOPMENT.md puts the data root under /tmp, where the default 0755
  // would let every local account read a database PERSISTENCE.md says will hold
  // project configuration and secret references.
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });

  // TECHNOLOGY_STACK.md: the persistence layer accepts an explicit addon path,
  // because the packaged app signs and relocates the native binding.
  const nativeBinding = process.env["JARVIS_SQLITE_ADDON"];
  // mkdirSync leaves a pre-existing data root at whatever mode it already had,
  // and the driver gives no way to set the database file's mode, so both are
  // tightened explicitly once they exist.
  chmodSync(dirname(databasePath), 0o700);

  const db = new Database(databasePath, nativeBinding === undefined ? {} : { nativeBinding });
  // ADR 0007: WAL gives durable local transactions without an external database.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  chmodSync(databasePath, 0o600);

  const appliedVersions = migrate(db);

  // `database: ready` must mean the schema is genuinely queryable, not merely
  // that no migration threw.
  db.prepare("SELECT value FROM engine_metadata WHERE key = ?").get("schema_initialized_at");

  // better-sqlite3 flips `open` to false on close, so a health check during
  // shutdown stops claiming the database is ready.
  return { db, state: () => (db.open ? "ready" : "failed"), appliedVersions };
}

function migrate(db: Database.Database): readonly string[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     ) STRICT`,
  );

  const already = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => (row as { version: string }).version),
  );

  const applied: string[] = [];
  for (const version of listMigrations()) {
    if (already.has(version)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, `${version}.sql`), "utf8");
    // One transaction per migration: a failure leaves no half-applied version.
    db.transaction(() => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime('now'))",
      ).run(version);
    })();
    applied.push(version);
  }
  return applied;
}

function listMigrations(): readonly string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.slice(0, -".sql".length))
    .sort();
}
