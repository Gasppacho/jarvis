import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { WorkItemReadinessStore } from "../../../../packages/modules/github/src/work-item-readiness.js";
import { applyMigration, applyMigrations } from "./test-migrations.js";

let db: Database.Database | undefined;

afterEach(() => db?.close());

describe("0035_readiness_observation_revision", () => {
  it("keeps a newer readiness observation when an older fact arrives late", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, "0034");
    applyMigration(db, "0035");
    db.prepare(
      `INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
       VALUES ('project-223', 'Project 223', 'active', '{}', '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z')`,
    ).run();

    const store = new WorkItemReadinessStore(db, {
      now: () => new Date("2026-09-14T00:00:00.000Z"),
    });
    const readiness = store.bind("project-223", "github");
    const observation = {
      repositoryId: "github://Gasppacho/jarvis",
      workItemRef: "github://Gasppacho/jarvis/issues/223",
      reason: "ready",
      blockerRefs: [],
      observedAt: "2026-09-14T00:00:02.000Z",
      ruleMatches: true,
      admit: false,
    } as const;

    expect(readiness.observe({ ...observation, status: "ready", observationRevision: 2 })).toBe(
      false,
    );
    expect(
      readiness.observe({
        ...observation,
        status: "blocked",
        reason: "open-native-blockers",
        observedAt: "2026-09-14T00:00:01.000Z",
        observationRevision: 1,
      }),
    ).toBe(false);
    expect(
      readiness.isCurrentObservation?.(observation.repositoryId, observation.workItemRef, 2),
    ).toBe(true);
    expect(
      db
        .prepare(
          `SELECT status, reason, observation_revision
           FROM github_work_item_readiness
           WHERE project_id = ? AND repository_id = ? AND work_item_ref = ?`,
        )
        .get("project-223", observation.repositoryId, observation.workItemRef),
    ).toEqual({ status: "ready", reason: "ready", observation_revision: 2 });
  });
});
