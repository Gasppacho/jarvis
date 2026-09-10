import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db/open.js";
import { applyMigrations } from "../db/test-migrations.js";
import {
  ConnectionDescriptorStore,
  ConnectionRegistry,
  type ConnectionDescriptor,
  type ConnectionRegistration,
} from "./registry.js";

const registration = (id: string, secretRef = `keychain://${id}`): ConnectionRegistration => ({
  id,
  provider: "github",
  accountLabel: `GitHub ${id}`,
  capabilities: ["github.api", "work-items.read"],
  secretRef,
});

const descriptor = (
  id: string,
  status: ConnectionDescriptor["status"],
  secretRef = `keychain://${id}`,
): ConnectionDescriptor => ({ ...registration(id, secretRef), status });

let opened: OpenedDatabase | undefined;
let dataRoot: string | undefined;

afterEach(() => {
  if (opened?.db.open) opened.db.close();
  opened = undefined;
  if (dataRoot !== undefined) rmSync(dataRoot, { recursive: true, force: true });
  dataRoot = undefined;
});

describe("ConnectionDescriptorStore", () => {
  it("upserts all descriptor fields once and lists by id, independent of insertion order", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = new ConnectionDescriptorStore(db);
    const first = descriptor("connection/z", "available");
    const updated = {
      ...first,
      accountLabel: "Updated account",
      capabilities: ["github.api"],
      secretRef: "keychain://updated",
      status: "revoked" as const,
    };
    const second = descriptor("connection/a", "unavailable");

    store.upsert(first);
    store.upsert(updated);
    store.upsert(second);

    expect(store.list()).toEqual([second, updated]);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM connections WHERE id = ?").get(first.id),
    ).toEqual({ count: 1 });

    db.prepare("DELETE FROM connections").run();
    store.upsert(second);
    store.upsert(updated);

    expect(store.list()).toEqual([second, updated]);
    db.close();
  });

  it("rejects a lifecycle status outside the documented values in SQLite", () => {
    const db = new Database(":memory:");
    applyMigrations(db);

    expect(() =>
      db
        .prepare(
          `INSERT INTO connections
             (id, provider, account_label, capabilities, status, secret_ref)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "connection/invalid",
          "github",
          "Invalid",
          JSON.stringify(["github.api"]),
          "checking",
          "keychain://invalid",
        ),
    ).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM connections").get()).toEqual({ count: 0 });
    db.close();
  });
});

describe("ConnectionRegistry", () => {
  it("registers unauthenticated descriptors without a secret value", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const registry = new ConnectionRegistry(db);

    const saved = registry.register(registration("connection/github"));

    expect(saved).toEqual({
      ...registration("connection/github"),
      status: "unauthenticated",
    });
    expect(Object.keys(saved).sort()).toEqual([
      "accountLabel",
      "capabilities",
      "id",
      "provider",
      "secretRef",
      "status",
    ]);
    expect(JSON.stringify(saved)).not.toContain("ghs_secret_value");
    db.close();
  });

  it("preserves every field after reopening the real SQLite database", () => {
    dataRoot = mkdtempSync(join(tmpdir(), "jarvis-connection-registry-"));
    const databasePath = join(dataRoot, "jarvis.sqlite");
    const saved = descriptor("connection/github", "available", "keychain://account");

    opened = openDatabase(databasePath);
    const firstRegistry = new ConnectionRegistry(opened.db);
    firstRegistry.upsert(saved);
    opened.db.close();
    opened = undefined;

    opened = openDatabase(databasePath);

    expect(new ConnectionRegistry(opened.db).list()).toEqual([saved]);
  });
});
