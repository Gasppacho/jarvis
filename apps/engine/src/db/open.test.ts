import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./open.ts";

describe("openDatabase", () => {
  const roots: string[] = [];

  function newRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "jarvis-db-"));
    roots.push(root);
    return root;
  }

  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  it("creates the data root, enables WAL and applies migrations", () => {
    const opened = openDatabase(join(newRoot(), "nested"));
    try {
      expect(opened.status).toBe("ready");
      expect(opened.db?.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(
        opened.db?.prepare("SELECT count(*) n FROM engine_metadata").get(),
      ).toEqual({ n: 0 });
    } finally {
      opened.close();
    }
  });

  it("applies each migration exactly once across restarts", () => {
    const root = newRoot();
    const applied = (): string[] => {
      const opened = openDatabase(root);
      try {
        expect(opened.db).not.toBeNull();
        const rows = opened
          .db!.prepare("SELECT name FROM schema_migrations ORDER BY name")
          .all();
        return (rows as { name: string }[]).map((row) => row.name);
      } finally {
        opened.close();
      }
    };

    const first = applied();
    expect(first).toContain("0001_init.sql");
    expect(applied()).toEqual(first);
  });

  it("reports a failure instead of throwing, so health can stay actionable", () => {
    const root = newRoot();
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "a file where a directory must be");

    const opened = openDatabase(join(blocked, "data"));
    try {
      expect(opened.status).toBe("failed");
      expect(opened.db).toBeNull();
      expect(opened.failure).toBeTruthy();
    } finally {
      opened.close();
    }
  });
});
