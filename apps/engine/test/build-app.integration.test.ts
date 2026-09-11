import { execFileSync } from "node:child_process";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const buildScript = join(repoRoot, "scripts", "build-app.sh");
const roots: string[] = [];

function writeArtifact(root: string, relativePath: string): void {
  const path = join(root, "dist", "engine", relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "fixture");
}

function fixtureRoot(extraPath?: string): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-build-app-"));
  roots.push(root);

  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "apps", "macos", ".build", "debug"), { recursive: true });
  cpSync(buildScript, join(root, "scripts", "build-app.sh"));
  cpSync(
    join(repoRoot, "scripts", "build-manifest.mjs"),
    join(root, "scripts", "build-manifest.mjs"),
  );
  chmodSync(join(root, "scripts", "build-app.sh"), 0o755);
  writeFileSync(join(root, "package.json"), '{"version":"0.1.0"}\n');
  writeFileSync(join(root, "apps", "macos", ".build", "debug", "Jarvis"), "binary");

  const swift = join(root, "bin", "swift");
  writeFileSync(
    swift,
    '#!/bin/bash\nset -euo pipefail\nif [[ " $* " == *" --show-bin-path "* ]]; then\n  printf \'%s\\n\' "$JARVIS_BUILD_APP_TEST_BIN"\nfi\n',
  );
  chmodSync(swift, 0o755);

  for (const artifact of [
    "engine.bundle.mjs",
    "engine.bundle.mjs.map",
    "node",
    "module-registry.json",
    "native/better_sqlite3.node",
    "modules/example/module.manifest.yaml",
    "modules/example/dist/index.mjs",
    "contracts/schemas/example.json",
    "migrations/0001_init.sql",
  ]) {
    writeArtifact(root, artifact);
  }

  if (extraPath !== undefined) {
    const path = join(root, "dist", "engine", extraPath);
    if (extraPath === "fixtures" || extraPath === "tests") {
      mkdirSync(path, { recursive: true });
    } else {
      writeArtifact(root, extraPath);
    }
  }

  return root;
}

type BuildResult = { status: number; stdout: string; stderr: string };

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString();
  return "";
}

function runBuild(root: string): BuildResult {
  try {
    return {
      status: 0,
      stdout: execFileSync("/bin/bash", [join(root, "scripts", "build-app.sh")], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          JARVIS_BUILD_APP_TEST_BIN: join(root, "apps", "macos", ".build", "debug"),
          JARVIS_MANIFEST_HEALTH_JSON: JSON.stringify({ engineVersion: "0.1.0", apiVersion: "v1" }),
          JARVIS_MANIFEST_SCHEMA_VERSION: "0001_init",
          JARVIS_MANIFEST_NODE_VERSION: "v24.16.0",
          JARVIS_MANIFEST_BUILD_COMMIT: "test-commit",
          PATH: `${join(root, "bin")}:${process.env["PATH"] ?? ""}`,
        },
      }),
      stderr: "",
    };
  } catch (error: unknown) {
    const result = error as { status?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      status: typeof result.status === "number" ? result.status : 1,
      stdout: asText(result.stdout),
      stderr: asText(result.stderr),
    };
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("scripts/build-app.sh", () => {
  it("assembles a clean declared engine bundle", () => {
    const root = fixtureRoot();
    const result = runBuild(root);

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, "dist", "Jarvis.app", "Contents", "Resources", "engine"))).toBe(
      true,
    );
    const manifest = JSON.parse(
      readFileSync(
        join(root, "dist", "Jarvis.app", "Contents", "Resources", "build-manifest.json"),
        "utf8",
      ),
    ) as unknown;
    const validate = new Ajv2020({ strict: true }).compile(
      JSON.parse(
        readFileSync(
          join(repoRoot, "contracts", "schemas", "build-manifest.v1.schema.json"),
          "utf8",
        ),
      ),
    );
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(manifest).toEqual({
      appVersion: "0.1.0",
      engineVersion: "0.1.0",
      apiVersion: "v1",
      schemaVersion: "0001_init",
      nodeVersion: "v24.16.0",
      buildCommit: "test-commit",
    });
  });

  it.each(["engine.test-bundle.mjs", ".env", "fixtures", "tests", "not-declared.txt"])(
    "refuses assembled engine artifact %s and names its path",
    (extraPath) => {
      const root = fixtureRoot(extraPath);
      const result = runBuild(root);
      const assembledPath = join(
        root,
        "dist",
        "Jarvis.app",
        "Contents",
        "Resources",
        "engine",
        extraPath,
      );

      expect(result.status).not.toBe(0);
      expect(existsSync(assembledPath)).toBe(true);
      expect(`${result.stdout}\n${result.stderr}`).toContain(assembledPath);
    },
  );
});
