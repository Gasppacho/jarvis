import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = fileURLToPath(new URL("..", import.meta.url));

export async function writeBuildManifest({ app, sourceRoot = SCRIPT_ROOT } = {}) {
  if (typeof app !== "string" || app.length === 0) throw new Error("--app is required.");
  const engineRoot = join(app, "Contents", "Resources", "engine");
  const node = join(engineRoot, "node");
  const bundle = join(engineRoot, "engine.bundle.mjs");
  const infoPlist = join(app, "Contents", "Info.plist");
  const output = join(app, "Contents", "Resources", "build-manifest.json");

  for (const path of [node, bundle, infoPlist]) {
    if (!existsSync(path)) throw new Error(`Manifest input is missing: ${path}`);
  }

  const appVersion = execFileSync(
    "plutil",
    ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", infoPlist],
    {
      encoding: "utf8",
    },
  ).trim();
  const nodeVersion =
    process.env["JARVIS_MANIFEST_NODE_VERSION"] ??
    execFileSync(node, ["--version"], { encoding: "utf8" }).trim();
  const probe =
    process.env["JARVIS_MANIFEST_HEALTH_JSON"] === undefined
      ? await readBundledHealth(node, bundle, engineRoot)
      : {
          health: JSON.parse(process.env["JARVIS_MANIFEST_HEALTH_JSON"]),
          schemaVersion:
            process.env["JARVIS_MANIFEST_SCHEMA_VERSION"] ?? latestMigration(engineRoot),
        };
  const health = probe.health;
  const schemaVersion = probe.schemaVersion;
  const buildCommit =
    process.env["JARVIS_MANIFEST_BUILD_COMMIT"] ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim();

  const manifest = {
    appVersion: requiredValue("appVersion", appVersion),
    engineVersion: requiredValue("engineVersion", health.engineVersion),
    apiVersion: requiredValue("apiVersion", health.apiVersion),
    schemaVersion: requiredValue("schemaVersion", schemaVersion),
    nodeVersion: requiredValue("nodeVersion", nodeVersion),
    buildCommit: requiredValue("buildCommit", buildCommit),
  };
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (
    serialized.includes(sourceRoot) ||
    serialized.includes(process.env["JARVIS_API_TOKEN"] ?? "\u0000")
  ) {
    throw new Error("Build manifest contains a build-machine path or secret.");
  }

  const temporary = `${output}.${randomUUID()}.tmp`;
  writeFileSync(temporary, serialized, { flag: "wx", mode: 0o644 });
  renameSync(temporary, output);
  return { output, manifest };
}

function latestMigration(engineRoot) {
  const migrations = readdirSync(join(engineRoot, "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.slice(0, -4))
    .sort();
  const latest = migrations.at(-1);
  if (latest === undefined) throw new Error("No database migration is bundled.");
  return latest;
}

function requiredValue(name, value) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Manifest field ${name} is empty.`);
  return value;
}

async function readBundledHealth(node, bundle, engineRoot) {
  const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-manifest-data-"));
  const token = randomUUID();
  const child = spawn(node, [bundle], {
    cwd: engineRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: dataRoot,
      TMPDIR: dataRoot,
      JARVIS_DATA_ROOT: dataRoot,
      JARVIS_API_TOKEN: token,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const line = await waitForLine(child, () => stdout, stderr);
    const handshake = JSON.parse(line);
    const response = await fetch(`http://127.0.0.1:${handshake.port}/v1/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Bundled health returned HTTP ${response.status}.`);
    const health = await response.json();
    if (health.status !== "ready" || health.database !== "ready") {
      throw new Error("Bundled health was not ready.");
    }
    await fetch(`http://127.0.0.1:${handshake.port}/v1/system/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    await onceExit(child);
    const appliedSchemaVersion = execFileSync(
      "sqlite3",
      [
        join(dataRoot, "jarvis.sqlite"),
        "SELECT version FROM schema_migrations ORDER BY rowid DESC LIMIT 1;",
      ],
      { encoding: "utf8" },
    ).trim();
    return { health, schemaVersion: requiredValue("schemaVersion", appliedSchemaVersion) };
  } catch (error) {
    child.kill("SIGTERM");
    await onceExit(child).catch(() => undefined);
    throw new Error(
      `Could not read bundled Engine health: ${String(error)}${stderr ? `\n${stderr}` : ""}`,
      { cause: error },
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

function waitForLine(child, readStdout, stderr) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`Engine did not report ready.${stderr ? `\n${stderr}` : ""}`)),
      15_000,
    );
    const check = () => {
      const newline = readStdout().indexOf("\n");
      if (newline >= 0) {
        clearTimeout(deadline);
        resolve(readStdout().slice(0, newline));
        return;
      }
      if (child.exitCode !== null) {
        clearTimeout(deadline);
        reject(new Error(`Engine exited before ready with code ${child.exitCode}.`));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

function onceExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

const invokedPath = process.argv[1];
const isMainModule =
  invokedPath !== undefined &&
  realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));

if (isMainModule) {
  const appIndex = process.argv.indexOf("--app");
  const rootIndex = process.argv.indexOf("--source-root");
  const app = appIndex >= 0 ? process.argv[appIndex + 1] : undefined;
  const sourceRoot = rootIndex >= 0 ? process.argv[rootIndex + 1] : SCRIPT_ROOT;
  writeBuildManifest({ app, sourceRoot })
    .then(({ output }) => process.stdout.write(`build-manifest: ${output}\n`))
    .catch((error) => {
      process.stderr.write(`build-manifest: ${String(error)}\n`);
      process.exitCode = 1;
    });
}
