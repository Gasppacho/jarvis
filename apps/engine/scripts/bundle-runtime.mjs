import { execFileSync } from "node:child_process";
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

// TECHNOLOGY_STACK.md lists `dist/engine/node` among the build outputs. Copying
// it here means one rule holds everywhere: the Node runtime lives beside the
// bundle, so neither the tests nor the packaged app ever reach for PATH.
// ponytail: the development Node is copied as-is; ticket 19 pins and signs an
// official LTS build instead.
const nodeOut = join(outDir, "node");
cpSync(process.execPath, nodeOut, { dereference: true });
assertSelfContained(nodeOut);

process.stdout.write(`bundled runtime into ${outDir}\n`);

/**
 * A Homebrew Node links against /opt/homebrew/lib (icu4c, brotli, openssl…),
 * and an app assembled from such a machine cannot exec its engine anywhere
 * else. Failing here beats shipping a bundle that dies with "could not be
 * launched" on someone else's Mac.
 */
function assertSelfContained(binary) {
  const linkage = execFileSync("otool", ["-L", binary], { encoding: "utf8" });
  const foreign = linkage
    .split("\n")
    // A universal binary emits one `path:` header per architecture slice, not
    // just one overall, so headers are dropped by shape rather than by index.
    .filter((line) => line.startsWith("\t"))
    .map((line) => line.trim().split(" ")[0])
    .filter((path) => path && !path.startsWith("/usr/lib/") && !path.startsWith("/System/"));

  if (foreign.length > 0) {
    throw new Error(
      `${binary} links against non-system libraries, so the bundle would only run on this machine:\n` +
        foreign.map((path) => `  ${path}`).join("\n") +
        "\nUse an official Node build from nodejs.org rather than a package-manager one.",
    );
  }
}
