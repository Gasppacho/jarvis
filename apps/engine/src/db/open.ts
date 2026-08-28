import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

/**
 * Both paths are derived from this module's own location, never from the
 * working directory, so they resolve inside `Jarvis.app/Contents/Resources/engine`
 * once the bundle is built (docs/architecture/MACOS_APP.md).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));
const BUNDLED_ADDON = fileURLToPath(
  new URL("./native/better_sqlite3.node", import.meta.url),
);

export const DATABASE_FILENAME = "jarvis.db";

/** Mirrors HealthResponse.database in contracts/openapi/local-api.v1.yaml. */
export type DatabaseStatus = "ready" | "migrating" | "failed";

export interface OpenedDatabase {
  readonly db: Database.Database | null;
  readonly status: DatabaseStatus;
  /** Safe to surface to the user: no path secrets, no SQL values. */
  readonly failure?: string;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** Injected so migration bookkeeping is deterministic under test. */
  readonly now?: () => Date;
}

function applyMigrations(db: Database.Database, now: () => Date): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name       TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     ) STRICT`,
  );

  const applied = new Set(
    (
      db.prepare("SELECT name FROM schema_migrations").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  const record = db.prepare(
    "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
  );

  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      record.run(file, now().toISOString());
    })();
  }
}

/**
 * Opens the single WAL database and brings it to the current schema. A failure
 * is reported rather than thrown: the shell must be able to show an actionable
 * error instead of facing a dead process (MVP_SPEC user story 3).
 */
export function openDatabase(
  dataRoot: string,
  options: OpenDatabaseOptions = {},
): OpenedDatabase {
  const now = options.now ?? (() => new Date());
  let db: Database.Database | null = null;

  try {
    mkdirSync(dataRoot, { recursive: true });
    db = new Database(
      join(dataRoot, DATABASE_FILENAME),
      // Present only in a built bundle; in-repo runs use the package prebuild.
      existsSync(BUNDLED_ADDON) ? { nativeBinding: BUNDLED_ADDON } : {},
    );
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    applyMigrations(db, now);

    const handle = db;
    return { db: handle, status: "ready", close: () => handle.close() };
  } catch (error) {
    db?.close();
    return {
      db: null,
      status: "failed",
      failure: error instanceof Error ? error.message : String(error),
      close: () => {},
    };
  }
}
