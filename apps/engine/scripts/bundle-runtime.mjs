import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const NODE_VERSION = "24.16.0";

const NODE_PLATFORM = "darwin-arm64";
const NODE_RELEASE_NAME = `node-v${NODE_VERSION}-${NODE_PLATFORM}`;
export const NODE_ARCHIVE_NAME = `${NODE_RELEASE_NAME}.tar.gz`;
const NODE_DOWNLOAD_BASE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/`;

/**
 * Copies everything the bundle needs at runtime next to it, so
 * `dist/engine/` is self-contained and ticket 19 can sign it as one tree.
 * See TECHNOLOGY_STACK.md "Build outputs".
 */
const engineRoot = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(engineRoot, "..", "..", "dist", "engine");
const require = createRequire(import.meta.url);
const bundledModules = require("../bundled-modules.json");

export async function bundleRuntime() {
  // Migrations are read from disk at startup, not inlined in the bundle.
  rmSync(join(outDir, "migrations"), { recursive: true, force: true });
  cpSync(join(engineRoot, "src", "db", "migrations"), join(outDir, "migrations"), {
    recursive: true,
  });

  // Project import validates a repository's committed portable config at runtime.
  // Keep that contract beside the bundle so the packaged app never reaches back
  // into the source checkout to find it.
  const contractsOut = join(outDir, "contracts", "schemas");
  rmSync(join(outDir, "contracts"), { recursive: true, force: true });
  mkdirSync(contractsOut, { recursive: true });
  for (const schema of [
    "project-config.v1.schema.json",
    "project-bindings.v1.schema.json",
    "module-manifest.v1.schema.json",
    "event-envelope.v1.schema.json",
  ]) {
    cpSync(
      join(engineRoot, "..", "..", "contracts", "schemas", schema),
      join(contractsOut, schema),
    );
  }
  cpSync(
    join(engineRoot, "..", "..", "contracts", "module-config"),
    join(outDir, "contracts", "module-config"),
    { recursive: true },
  );
  cpSync(join(engineRoot, "..", "..", "contracts", "events"), join(outDir, "contracts", "events"), {
    recursive: true,
  });

  // ADR 0011: production discovers only official Module Packages registered in
  // the build. Copying their declarative Manifests creates that registry without
  // coupling the Kernel to any module's application or domain code.
  const modulesOut = join(outDir, "modules");
  const registeredModuleNames = Object.keys(bundledModules).sort();
  for (const name of registeredModuleNames) {
    const manifest = join(
      engineRoot,
      "..",
      "..",
      "packages",
      "modules",
      name,
      "module.manifest.yaml",
    );
    const packageOut = join(modulesOut, name);
    mkdirSync(packageOut, { recursive: true });
    cpSync(manifest, join(packageOut, "module.manifest.yaml"));
  }
  writeFileSync(
    join(outDir, "module-registry.json"),
    `${JSON.stringify({ packages: registeredModuleNames }, null, 2)}\n`,
  );

  // tsup bundles the SQLite driver JavaScript. Only the arm64 native addon is
  // copied separately so the release pipeline can sign one declared binary;
  // no node_modules tree ships in the app (ADR 0007).
  const sqlitePackage = dirname(require.resolve("better-sqlite3/package.json"));
  rmSync(join(outDir, "node_modules"), { recursive: true, force: true });
  const nativeOut = join(outDir, "native", "better_sqlite3.node");
  rmSync(join(outDir, "native"), { recursive: true, force: true });
  mkdirSync(dirname(nativeOut), { recursive: true });
  cpSync(join(sqlitePackage, "prebuilds", "darwin-arm64.node"), nativeOut, {
    dereference: true,
  });

  // TECHNOLOGY_STACK.md lists `dist/engine/node` among the build outputs. The
  // official arm64 release lives beside the bundle, so neither tests nor the
  // packaged app reaches for PATH.
  const nodeOut = join(outDir, "node");
  await installBundledNode(nodeOut);
  assertSelfContained(nodeOut);

  process.stdout.write(`bundled runtime into ${outDir}\n`);
  return outDir;
}

export async function ensureNodeArchive({
  cacheDir = defaultNodeCacheDir(),
  baseUrl = NODE_DOWNLOAD_BASE_URL,
  fetchImpl = fetch,
} = {}) {
  mkdirSync(cacheDir, { recursive: true });

  const archivePath = join(cacheDir, NODE_ARCHIVE_NAME);
  const checksumsPath = join(cacheDir, "SHASUMS256.txt");
  const checksums = existsSync(checksumsPath)
    ? readFileSync(checksumsPath, "utf8")
    : await downloadText(new URL("SHASUMS256.txt", withTrailingSlash(baseUrl)), fetchImpl);
  const expectedHash = parseArchiveChecksum(checksums);

  if (!existsSync(checksumsPath)) writeCacheFile(checksumsPath, checksums);

  const archive = existsSync(archivePath)
    ? readFileSync(archivePath)
    : await downloadBytes(new URL(NODE_ARCHIVE_NAME, withTrailingSlash(baseUrl)), fetchImpl);
  const actualHash = sha256(archive);
  if (actualHash !== expectedHash) {
    throw new Error(
      `Node archive SHA-256 mismatch for ${NODE_ARCHIVE_NAME}: expected ${expectedHash}, got ${actualHash}`,
    );
  }

  if (!existsSync(archivePath)) writeCacheFile(archivePath, archive);
  return { archivePath, expectedHash };
}

export async function installBundledNode(nodeOut, options) {
  const { archivePath } = await ensureNodeArchive(options);
  const extractionRoot = mkdtempSync(join(tmpdir(), "jarvis-node-"));
  try {
    try {
      execFileSync("tar", ["-xzf", archivePath, "-C", extractionRoot], { stdio: "ignore" });
    } catch (cause) {
      throw new Error(`Failed to extract verified Node archive ${archivePath}.`, { cause });
    }

    const extractedNode = join(extractionRoot, NODE_RELEASE_NAME, "bin", "node");
    if (!existsSync(extractedNode)) {
      throw new Error(`Verified Node archive does not contain ${NODE_RELEASE_NAME}/bin/node.`);
    }

    mkdirSync(dirname(nodeOut), { recursive: true });
    cpSync(extractedNode, nodeOut, { dereference: true });
    chmodSync(nodeOut, 0o755);
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

function defaultNodeCacheDir() {
  return join(homedir(), "Library", "Caches", "Jarvis", "node", NODE_VERSION);
}

function withTrailingSlash(baseUrl) {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

async function downloadBytes(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Node download failed for ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function downloadText(url, fetchImpl) {
  return (await downloadBytes(url, fetchImpl)).toString("utf8");
}

function parseArchiveChecksum(checksums) {
  for (const line of checksums.split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/);
    if (
      (name === NODE_ARCHIVE_NAME || name === `*${NODE_ARCHIVE_NAME}`) &&
      /^[a-f0-9]{64}$/i.test(hash ?? "")
    ) {
      return hash.toLowerCase();
    }
  }
  throw new Error(`SHASUMS256.txt has no valid checksum for ${NODE_ARCHIVE_NAME}.`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeCacheFile(target, contents) {
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { flag: "wx" });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

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

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await bundleRuntime();
}
