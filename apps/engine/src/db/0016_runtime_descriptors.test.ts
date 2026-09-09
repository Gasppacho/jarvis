import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, applyMigrations } from "./test-migrations.js";

let db: Database.Database | undefined;

afterEach(() => db?.close());

describe("0016_runtime_descriptors", () => {
  it("creates runtime_descriptors on an empty database", () => {
    db = new Database(":memory:");

    applyMigrations(db);

    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'runtime_descriptors'").get(),
    ).toEqual({
      name: "runtime_descriptors",
    });
  });

  it("upgrades a database created before the runtime descriptor ticket", () => {
    db = new Database(":memory:");

    applyMigrations(db, "0015");
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'runtime_descriptors'").get(),
    ).toBeUndefined();

    applyMigration(db, "0016");

    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'runtime_descriptors'").get(),
    ).toEqual({
      name: "runtime_descriptors",
    });
  });
});
