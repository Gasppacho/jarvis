import Database from "better-sqlite3";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, parse as parsePath, resolve } from "node:path";
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
  // Order matters: the data root is made private to this user first, so nothing
  // can be planted beside the database between the check below and the open.
  // Everything afterwards uses the canonical directory the checks validated —
  // going back to the literal path would re-open the door to an intermediate
  // symlink that was never lstat'ed.
  const dataRoot = prepareDataRoot(dirname(databasePath));
  const canonicalPath = join(dataRoot, basename(databasePath));
  assertRegularFileOrAbsent(canonicalPath);

  // TECHNOLOGY_STACK.md: the persistence layer accepts an explicit addon path,
  // because the packaged app signs and relocates the native binding.
  const nativeBinding = process.env["JARVIS_SQLITE_ADDON"];
  const db = new Database(canonicalPath, nativeBinding === undefined ? {} : { nativeBinding });
  try {
    return prepare(db, canonicalPath);
  } catch (error) {
    // chmod, a migration or the probe can all throw here. Propagating with the
    // handle open would leave the WAL un-checkpointed, which is the invariant
    // the shutdown path exists to hold. A failure to close must not replace the
    // error the operator actually needs to see.
    try {
      db.close();
    } catch {
      /* the original error below is the useful one */
    }
    throw error;
  }
}

function prepare(db: Database.Database, databasePath: string): OpenedDatabase {
  // ADR 0007: WAL gives durable local transactions without an external database.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // The driver offers no way to set the database file's mode and SQLite creates
  // it 0644. The -wal and -shm files are created lazily at first write, after
  // this call, so they inherit the mode set here.
  chmodSync(databasePath, 0o600);

  const appliedVersions = migrate(db);

  // `database: ready` must mean the schema is genuinely queryable, not merely
  // that no migration threw.
  const probe = db.prepare("SELECT value FROM engine_metadata WHERE key = ?");
  probe.get("schema_initialized_at");

  return {
    db,
    // Re-run on every call rather than frozen at open time, so `/v1/health`
    // reports a handle that has since failed instead of the state it had once.
    state: () => {
      if (!db.open) return "failed";
      try {
        probe.get("schema_initialized_at");
        return "ready";
      } catch {
        return "failed";
      }
    },
    appliedVersions,
  };
}

/**
 * LOCAL_DEVELOPMENT.md documents `JARVIS_DATA_ROOT=/tmp/jarvis-dev-<id>`, a
 * predictable path under a world-writable directory, and PERSISTENCE.md says
 * the database will hold project configuration and secret references. So the
 * engine refuses a data root it does not own rather than adopting it.
 *
 * Returns the canonical path, which is the only one later steps may use.
 */
function prepareDataRoot(dataRoot: string): string {
  const absolute = resolve(dataRoot);

  // lstat before mkdir: `mkdirSync` throws EEXIST or ENOENT for a file or a
  // dangling link, which would bury the cause under a raw errno.
  let stats = lstatIfExists(absolute);
  if (stats === undefined) {
    // `recursive: true` succeeds silently when the path is a link to a
    // directory, so something planted between the lstat above and this call
    // would survive. Hence the checks below run on both branches.
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
    stats = lstatSync(absolute);
  }

  if (stats.isSymbolicLink()) {
    throw new Error(
      `The data root ${absolute} is a symbolic link. Point JARVIS_DATA_ROOT at a real directory you own.`,
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(
      `The data root ${absolute} exists but is not a directory. Point JARVIS_DATA_ROOT at a directory.`,
    );
  }

  // `recursive: true` traverses every intermediate component, so checking the
  // leaf alone would miss a symlink planted higher up the chain. Canonicalise
  // before walking the ancestors — and canonicalise rather than demand an
  // already-canonical path, because on macOS /tmp and /var are themselves links.
  const canonical = realpathSync(absolute);
  assertOwnedChain(canonical);

  // Only now, with ownership established, is tightening the mode both safe and
  // permitted.
  if ((stats.mode & 0o077) !== 0) chmodSync(canonical, 0o700);

  return canonical;
}

/**
 * The data root is private by the time this runs, but it may have been loose
 * when the engine found it, long enough for someone to leave a link behind.
 * Opening one would put the database — and the `chmod` that follows — wherever
 * that link points.
 */
function assertRegularFileOrAbsent(databasePath: string): void {
  const stats = lstatIfExists(databasePath);
  if (stats === undefined) return;
  if (stats.isSymbolicLink()) {
    throw new Error(
      `${databasePath} is a symbolic link. Refusing to open the database through it.`,
    );
  }
  if (!stats.isFile()) {
    throw new Error(`${databasePath} exists but is not a regular file.`);
  }
}

/**
 * A directory is only as safe as the directories above it: whoever can write an
 * ancestor can rename or replace the leaf between this check and the open. Each
 * ancestor must therefore belong to this user or to root, and must not be
 * writable by anyone else unless the sticky bit forbids touching our entries —
 * which is exactly what makes `/tmp` (root-owned, 1777) usable.
 *
 * This does refuse a data root on a volume mounted 0777, such as an external
 * FAT disk under /Volumes. That is not a safe place for project data anyway,
 * and no override exists on purpose: a knob here would be the first thing a
 * confused setup reaches for.
 */
function assertOwnedChain(path: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) return;

  const { root } = parsePath(path);
  for (let current = path; ; current = dirname(current)) {
    const stats = lstatOrExplain(current);
    const isLeaf = current === path;

    // The data root itself must be ours: the mode exemption below rests on our
    // being able to tighten it. Ancestors may belong to root — /usr, /Volumes
    // and / all do — but to nobody else.
    if (isLeaf ? stats.uid !== uid : stats.uid !== uid && stats.uid !== 0) {
      throw new Error(
        `${current} belongs to another user, so ${path} is not a safe place for project data.`,
      );
    }
    // The leaf is exempt from the mode check only because we own it and the
    // caller tightens it to 0700 next. An ancestor we cannot fix is the one
    // that lets someone swap the leaf.
    if (!isLeaf) {
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

/** lstat that names the problem instead of surfacing a raw errno. */
function lstatOrExplain(path: string): Stats {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(`${path} could not be inspected (${code ?? "unknown error"}).`);
  }
}

function lstatIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    // ENOTDIR means an intermediate component is a file. Naming it beats
    // surfacing the raw errno the pre-mkdir lstat exists to avoid.
    if (code === "ENOTDIR") {
      throw new Error(
        `A parent of ${path} is a file, not a directory. Point JARVIS_DATA_ROOT at a path whose parents are all directories.`,
      );
    }
    throw error;
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
