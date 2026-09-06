import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { defineConfig, type Options } from "tsup";

const require = createRequire(import.meta.url);
const manifest = require("./package.json") as { version: string };
const bundledModules = require("./bundled-modules.json") as Readonly<Record<string, string>>;

// tsup's shared outDir also carries build-time registered official packages.
// Clear only their generated code before entry discovery so removed packages
// cannot survive in a later bundle.
rmSync("../../dist/engine/modules", { recursive: true, force: true });

// TECHNOLOGY_STACK.md: deterministic bundle, native addon kept external so the
// release pipeline can sign `better_sqlite3.node` on its own.
const shared: Options = {
  outDir: "../../dist/engine",
  format: ["esm"],
  platform: "node",
  target: "node24",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: false,
  // Everything is bundled except the native SQLite addon, so `dist/engine/`
  // needs no pnpm store at runtime. `noExternal` wins over `external` in tsup,
  // so the driver is excluded by the pattern itself.
  noExternal: [/^(?!better-sqlite3).+/],
  external: ["better-sqlite3"],
  define: { __ENGINE_VERSION__: JSON.stringify(manifest.version) },
  // Bundled CommonJS dependencies call `require` for Node builtins. An ESM
  // bundle has none, so give them a real one instead of esbuild's throwing shim.
  banner: {
    js: [
      'import { createRequire as __jarvisCreateRequire } from "node:module";',
      "const require = __jarvisCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  outExtension: () => ({ js: ".mjs" }),
  // Review fix for ticket #58: `minifySyntax` (not full minify — names and
  // whitespace are untouched) makes esbuild constant-fold and remove dead
  // `if (__JARVIS_TEST_HOOKS__) { ... }` branches (declared per call site;
  // see e.g. src/test-support/failpoint.ts's callers). Combined with the
  // per-entry `__JARVIS_TEST_HOOKS__` below, this is what makes the
  // failpoint/test-hooks mechanism absent from the production entry by
  // construction, not merely unreachable at runtime.
  esbuildOptions(options) {
    options.minifySyntax = true;
  },
};

export default defineConfig([
  {
    ...shared,
    entry: {
      "engine.bundle": "src/main.ts",
      ...Object.fromEntries(
        Object.entries(bundledModules).map(([name, source]) => [
          `modules/${name}/dist/index`,
          source,
        ]),
      ),
    },
    // The artifact scripts/build-app.sh packages into Jarvis.app. Never true.
    define: { ...shared.define, __JARVIS_TEST_HOOKS__: "false" },
  },
  {
    ...shared,
    // Ticket #58 review fix: the Application Harness (apps/engine/test/
    // harness.ts) needs a build that genuinely has the failpoint/test-hooks
    // code, since the production entry above no longer does. Lands beside
    // the production entry in dist/engine/, so scripts/build-app.sh must
    // (and does) strip this file explicitly before assembling Jarvis.app.
    entry: { "engine.test-bundle": "src/main.ts" },
    define: { ...shared.define, __JARVIS_TEST_HOOKS__: "true" },
  },
]);
