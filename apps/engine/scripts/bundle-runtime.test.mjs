import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ensureNodeArchive, NODE_ARCHIVE_NAME } from "./bundle-runtime.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Node runtime archive cache", () => {
  it("downloads, verifies and reuses a warm cache without fetching again", async () => {
    const fixture = createFixture();
    const calls = [];
    const fetchImpl = directoryFetch(fixture.sourceDir, calls);

    const first = await ensureNodeArchive({
      baseUrl: "http://local-node.test/dist/",
      cacheDir: fixture.cacheDir,
      fetchImpl,
    });
    expect(readFileSync(first.archivePath)).toEqual(fixture.archive);
    expect(calls).toHaveLength(2);

    await ensureNodeArchive({
      baseUrl: "http://local-node.test/dist/",
      cacheDir: fixture.cacheDir,
      fetchImpl: async () => {
        throw new Error("network should not be used for a warm cache");
      },
    });
    expect(calls).toHaveLength(2);
  });

  it("reports both checksums when the published checksum differs", async () => {
    const fixture = createFixture();
    const expected = "0".repeat(64);
    writeFileSync(join(fixture.sourceDir, "SHASUMS256.txt"), `${expected}  ${NODE_ARCHIVE_NAME}\n`);

    await expect(
      ensureNodeArchive({
        baseUrl: "http://local-node.test/dist/",
        cacheDir: fixture.cacheDir,
        fetchImpl: directoryFetch(fixture.sourceDir, []),
      }),
    ).rejects.toThrow(`expected ${expected}, got ${sha256(fixture.archive)}`);
  });

  it("rejects a truncated cached archive before extraction", async () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.cacheDir, "SHASUMS256.txt"),
      readFileSync(join(fixture.sourceDir, "SHASUMS256.txt")),
    );
    writeFileSync(join(fixture.cacheDir, NODE_ARCHIVE_NAME), fixture.archive.subarray(0, 3));
    const calls = [];

    await expect(
      ensureNodeArchive({
        cacheDir: fixture.cacheDir,
        fetchImpl: async () => {
          calls.push("network");
          throw new Error("network should not be used for a cached archive");
        },
      }),
    ).rejects.toThrow(
      `expected ${sha256(fixture.archive)}, got ${sha256(fixture.archive.subarray(0, 3))}`,
    );
    expect(calls).toHaveLength(0);
  });
});

function createFixture() {
  const sourceDir = temporaryDirectory("jarvis-node-source-");
  const cacheDir = temporaryDirectory("jarvis-node-cache-");
  const archive = Buffer.from("official node archive fixture");
  writeFileSync(join(sourceDir, NODE_ARCHIVE_NAME), archive);
  writeFileSync(join(sourceDir, "SHASUMS256.txt"), `${sha256(archive)}  ${NODE_ARCHIVE_NAME}\n`);
  return { archive, cacheDir, sourceDir };
}

function temporaryDirectory(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function directoryFetch(sourceDir, calls) {
  return async (url) => {
    calls.push(String(url));
    const path = join(sourceDir, basename(new URL(url).pathname));
    if (!existsSync(path)) return new Response(null, { status: 404 });
    return new Response(readFileSync(path), { status: 200 });
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
