import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeDescriptor } from "../../../../packages/agent-runtime/src/index.js";
import { openDatabase, type OpenedDatabase } from "../db/open.js";
import { applyMigrations } from "../db/test-migrations.js";
import { FAKE_RUNTIME_DESCRIPTOR, RuntimeDescriptorStore, RuntimeRegistry } from "./registry.js";

const descriptor = (id: string, status: RuntimeDescriptor["status"]): RuntimeDescriptor => ({
  id,
  provider: "codex",
  displayName: `Codex ${id}`,
  executablePath: `/private/tmp/${id}/codex`,
  version: "0.153.4",
  capabilities: ["agent.execute", "agent.inspect"],
  status,
});

let opened: OpenedDatabase | undefined;
let dataRoot: string | undefined;

afterEach(() => {
  if (opened?.db.open) opened.db.close();
  opened = undefined;
  if (dataRoot !== undefined) rmSync(dataRoot, { recursive: true, force: true });
  dataRoot = undefined;
});

describe("RuntimeDescriptorStore", () => {
  it("upserts by id and lists deterministically without discovery", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = new RuntimeDescriptorStore(db);
    const first = descriptor("runtime/z", "available");
    const updated = { ...first, version: "0.153.5", status: "degraded" as const };
    const second = descriptor("runtime/a", "unauthenticated");

    store.upsert(first);
    store.upsert(updated);
    store.upsert(second);

    const expected = [second, FAKE_RUNTIME_DESCRIPTOR, updated];
    expect(store.list()).toEqual(expected);

    db.prepare("DELETE FROM runtime_descriptors").run();
    const reversedStore = new RuntimeDescriptorStore(db);
    reversedStore.upsert(second);
    reversedStore.upsert(first);
    reversedStore.upsert(updated);

    expect(reversedStore.list()).toEqual(expected);
    db.close();
  });

  it("preserves descriptors across reopening the real SQLite database", () => {
    dataRoot = mkdtempSync(join(tmpdir(), "jarvis-runtime-registry-"));
    const databasePath = join(dataRoot, "jarvis.sqlite");
    const saved = descriptor("runtime/codex", "available");

    opened = openDatabase(databasePath);
    new RuntimeDescriptorStore(opened.db).upsert(saved);
    opened.db.close();
    opened = undefined;

    opened = openDatabase(databasePath);

    expect(new RuntimeDescriptorStore(opened.db).list()).toEqual([saved, FAKE_RUNTIME_DESCRIPTOR]);
  });

  it("makes a status update visible on the next list without a restart", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = new RuntimeDescriptorStore(db);
    const available = descriptor("runtime/codex", "available");

    store.upsert(available);
    store.upsert({ ...available, status: "unavailable" });

    expect(store.list()).toContainEqual({ ...available, status: "unavailable" });
    db.close();
  });

  it("discovers Codex, upserts repeated refreshes, and records disappearance", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-runtime-api-"));
    const executable = join(root, "codex");
    writeFileSync(
      executable,
      `#!/bin/sh
case "$1" in
  --version) printf 'codex-cli 0.153.4\\n' ;;
  login)
    [ "$2" = status ] || exit 2
    printf 'Logged in using ChatGPT\\n'
    ;;
esac
`,
      "utf8",
    );
    chmodSync(executable, 0o755);

    const db = new Database(":memory:");
    applyMigrations(db);
    let detected: string | null = executable;
    const registry = new RuntimeRegistry(db, {
      detector: { detect: async () => detected },
    });

    expect(await registry.discover()).toContainEqual({
      id: "runtime/codex-default",
      provider: "codex",
      displayName: "Codex — default",
      executablePath: executable,
      version: "0.153.4",
      capabilities: ["agent.execute"],
      status: "available",
    });
    const refreshed = await registry.discover();
    expect(refreshed.map(({ id }) => id)).toEqual(["runtime/codex-default", "runtime/fake-test"]);

    detected = null;
    expect(await registry.discover()).toContainEqual({
      id: "runtime/codex-default",
      provider: "codex",
      displayName: "Codex — default",
      executablePath: null,
      version: null,
      capabilities: ["agent.execute"],
      status: "unavailable",
    });

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
