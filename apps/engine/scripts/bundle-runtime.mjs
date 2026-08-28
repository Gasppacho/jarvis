import { createRequire } from "node:module";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Copies everything the bundle needs at runtime next to it, so
 * `dist/engine/` is self-contained and ticket 19 can sign it as one tree.
 * See TECHNOLOGY_STACK.md "Build outputs".
 */
const engineRoot = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(engineRoot, "..", "..", "dist", "engine");
const require = createRequire(import.meta.url);

// Migrations are read from disk at startup, not inlined in the bundle.
rmSync(join(outDir, "migrations"), { recursive: true, force: true });
cpSync(join(engineRoot, "src", "db", "migrations"), join(outDir, "migrations"), {
  recursive: true,
});

// The SQLite driver stays external: it carries a native addon the release
// pipeline signs separately (ADR 0007).
const sqlitePackage = dirname(require.resolve("better-sqlite3/package.json"));
const sqliteOut = join(outDir, "node_modules", "better-sqlite3");
rmSync(sqliteOut, { recursive: true, force: true });
mkdirSync(dirname(sqliteOut), { recursive: true });
cpSync(sqlitePackage, sqliteOut, { recursive: true, dereference: true });

process.stdout.write(`bundled runtime into ${outDir}\n`);
