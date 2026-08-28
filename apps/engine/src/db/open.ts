import Database from "better-sqlite3";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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
  prepareDataRoot(dirname(databasePath));

  // TECHNOLOGY_STACK.md: the persistence layer accepts an explicit addon path,
  // because the packaged app signs and relocates the native binding.
  const nativeBinding = process.env["JARVIS_SQLITE_ADDON"];
  const db = new Database(databasePath, nativeBinding === undefined ? {} : { nativeBinding });

  // ADR 0007: WAL gives durable local transactions without an external database.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // The driver offers no way to set the database file's mode and SQLite creates
  // it 0644. The -wal and -shm files inherit the mode set here.
  chmodSync(databasePath, 0o600);

  const appliedVersions = migrate(db);

  // `database: ready` must mean the schema is genuinely queryable, not merely
  // that no migration threw.
  db.prepare("SELECT value FROM engine_metadata WHERE key = ?").get("schema_initialized_at");

  // Probed per call rather than frozen at open time, so `/v1/health` reports the
  // handle as it is rather than as it was.
  return { db, state: () => (db.open ? "ready" : "failed"), appliedVersions };
}

/**
 * LOCAL_DEVELOPMENT.md documents `JARVIS_DATA_ROOT=/tmp/jarvis-dev-<id>`, a
 * predictable path under a world-writable directory, and PERSISTENCE.md says
 * the database will hold project configuration and secret references. So the
 * engine refuses a data root it does not own rather than adopting it.
 */
function prepareDataRoot(dataRoot: string): void {
  // `recursive: true` succeeds on an existing path and ignores `mode` there, so
  // this mode only guarantees a root that this call actually creates.
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });

  // lstat, not stat: a symlink planted at the expected path would otherwise
  // send every check below — and the chmod — to a directory someone else chose.
  const stats = lstatSync(dataRoot);
  if (stats.isSymbolicLink()) {
    throw new Error(
      `The data root ${dataRoot} is a symbolic link. Point JARVIS_DATA_ROOT at a real directory you own.`,
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(`The data root ${dataRoot} exists but is not a directory.`);
  }

  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(
      `The data root ${dataRoot} belongs to another user. Refusing to store project data there.`,
    );
  }

  // Only now, with ownership established, is tightening the mode both safe and
  // permitted.
  if ((stats.mode & 0o077) !== 0) chmodSync(dataRoot, 0o700);
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
