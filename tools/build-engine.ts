/**
 * Produces the self-contained engine the macOS app embeds, in the layout
 * documented by docs/architecture/TECHNOLOGY_STACK.md "Build outputs".
 */
import { createRequire } from "node:module";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { copyFile, link, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT_DIR = join(REPO_ROOT, "dist/engine");
const require_ = createRequire(import.meta.url);

/**
 * better-sqlite3 loads its addon through `require`, which does not exist in an
 * ESM bundle. This is the standard esbuild interop banner.
 */
const ESM_REQUIRE_BANNER = [
  'import { createRequire as __jarvisCreateRequire } from "node:module";',
  "const require = __jarvisCreateRequire(import.meta.url);",
].join("\n");

/** Hard-link when possible (same volume, instant); fall back to a copy. */
async function place(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await rm(target, { force: true });
  try {
    await link(source, target);
  } catch {
    await copyFile(source, target);
  }
}

async function main(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  await build({
    entryPoints: [join(REPO_ROOT, "apps/engine/src/main.ts")],
    outfile: join(OUT_DIR, "engine.bundle.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner: { js: ESM_REQUIRE_BANNER },
    // The addon is placed next to the bundle and loaded by absolute path.
    external: ["*.node"],
    sourcemap: "linked",
    logLevel: "warning",
    metafile: false,
  });

  // Migrations stay real files so `new URL("./migrations/", import.meta.url)`
  // resolves identically from src/db/open.ts and from the built bundle.
  await cp(
    join(REPO_ROOT, "apps/engine/src/db/migrations"),
    join(OUT_DIR, "migrations"),
    {
      recursive: true,
    },
  );
  await cp(join(REPO_ROOT, "contracts"), join(OUT_DIR, "contracts"), {
    recursive: true,
  });

  // `prebuilds/` is not in better-sqlite3's exports map, so resolve the package
  // root and reach the addon from there.
  const packageRoot = dirname(
    require_.resolve("better-sqlite3/package.json", {
      paths: [join(REPO_ROOT, "apps/engine")],
    }),
  );
  const addon = join(
    packageRoot,
    "prebuilds",
    `${process.platform}-${process.arch}.node`,
  );
  await place(addon, join(OUT_DIR, "native/better_sqlite3.node"));

  // ponytail: ships the developer's Node for now. Ticket 19 downloads, verifies
  // and signs the official Node 24 LTS build for the target architecture.
  await place(process.execPath, join(OUT_DIR, "node"));

  await writeFile(
    join(OUT_DIR, "build-info.json"),
    `${JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const bundle = await stat(join(OUT_DIR, "engine.bundle.mjs"));
  process.stderr.write(
    `built dist/engine (${Math.round(bundle.size / 1024)} KiB bundle)\n`,
  );
}

await main();
