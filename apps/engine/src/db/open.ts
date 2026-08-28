import Database from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type DatabaseState = "ready" | "migrating" | "failed";

export interface OpenedDatabase {
  readonly db: Database.Database;
  readonly state: DatabaseState;
  readonly appliedVersions: readonly string[];
}

/**
 * Migrations ship beside the bundle (`dist/engine/migrations/*`, see
 * TECHNOLOGY_STACK.md "Build outputs"). Paths derive from this module, never
 * from the current working directory.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

export function openDatabase(databasePath: string): OpenedDatabase {
  mkdirSync(dirname(databasePath), { recursive: true });

  // TECHNOLOGY_STACK.md: the persistence layer accepts an explicit addon path,
  // because the packaged app signs and relocates the native binding.
  const nativeBinding = process.env["JARVIS_SQLITE_ADDON"];
  const db = new Database(databasePath, nativeBinding === undefined ? {} : { nativeBinding });
  // ADR 0007: WAL gives durable local transactions without an external database.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const appliedVersions = migrate(db);

  // `database: ready` must mean the schema is genuinely queryable, not merely
  // that no migration threw.
  db.prepare("SELECT value FROM engine_metadata WHERE key = ?").get("schema_initialized_at");

  return { db, state: "ready", appliedVersions };
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
