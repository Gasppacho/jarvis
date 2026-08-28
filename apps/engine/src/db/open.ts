import Database from "better-sqlite3";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, parse as parsePath, resolve } from "node:path";
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
  const absolute = resolve(dataRoot);

  // `recursive: true` succeeds on an existing path and ignores `mode` there, so
  // this mode only guarantees a root that this call actually creates.
  mkdirSync(absolute, { recursive: true, mode: 0o700 });

  // lstat, not stat: a symlink planted at the expected path would otherwise
  // send every check below — and the chmod — to a directory someone else chose.
  const stats = lstatSync(absolute);
  if (stats.isSymbolicLink()) {
    throw new Error(
      `The data root ${absolute} is a symbolic link. Point JARVIS_DATA_ROOT at a real directory you own.`,
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(`The data root ${absolute} exists but is not a directory.`);
  }

  // mkdirSync(recursive) traverses every intermediate component, so checking the
  // leaf alone would miss a symlink planted higher up the chain. Canonicalise
  // before walking the ancestors — and canonicalise rather than demand an
  // already-canonical path, because on macOS /tmp and /var are themselves links.
  assertOwnedChain(realpathSync(absolute));

  // Only now, with ownership established, is tightening the mode both safe and
  // permitted.
  if ((stats.mode & 0o077) !== 0) chmodSync(absolute, 0o700);
}

/**
 * A directory is only as safe as the directories above it: whoever can write an
 * ancestor can rename or replace the leaf between this check and the open. Each
 * ancestor must therefore belong to this user or to root, and must not be
 * writable by anyone else unless the sticky bit forbids touching our entries —
 * which is exactly what makes `/tmp` (root-owned, 1777) usable.
 */
function assertOwnedChain(path: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) return;

  const { root } = parsePath(path);
  for (let current = path; ; current = dirname(current)) {
    const stats = lstatSync(current);

    if (stats.uid !== uid && stats.uid !== 0) {
      throw new Error(
        `${current} belongs to another user, so ${path} is not a safe place for project data.`,
      );
    }
    // The leaf is exempt: we own it, and the caller tightens it to 0700 next.
    // An ancestor we cannot fix is the one that lets someone swap the leaf.
    if (current !== path) {
      const writableByOthers = (stats.mode & 0o022) !== 0;
      const sticky = (stats.mode & 0o1000) !== 0;
      if (writableByOthers && !sticky) {
        throw new Error(
          `${current} is writable by other users, so ${path} is not a safe place for project data.`,
        );
      }
    }

    if (current === root) return;
  }
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
