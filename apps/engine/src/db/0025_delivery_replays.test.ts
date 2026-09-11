import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, applyMigrations } from "./test-migrations.js";

let db: Database.Database | undefined;
afterEach(() => db?.close());

describe("0025_delivery_replays", () => {
  it("adds an explicit replay marker that defaults to an automatic attempt", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, "0024");
    applyMigration(db, "0025");

    expect(
      db
        .prepare("PRAGMA table_info(deliveries)")
        .all()
        .find((column) => (column as { name: string }).name === "replay_requested"),
    ).toMatchObject({ name: "replay_requested", notnull: 1, dflt_value: "0" });
  });
});
