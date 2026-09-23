import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigration, applyMigrations } from "./test-migrations.js";

describe("0039 remove project execution policy", () => {
  it("removes technical project and Development fields without preserving compatibility", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      applyMigrations(db, "0038");
      db.prepare(
        `INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
         VALUES ('project', 'Project', 'draft', ?, '2026-09-22', '2026-09-22')`,
      ).run(
        JSON.stringify({
          apiVersion: "jarvis.dev/project/v1",
          kind: "Project",
          metadata: { id: "project", name: "Project" },
          repositories: [{ id: "main", root: ".", defaultBranch: "main", remote: "origin" }],
          slots: { agentRuntime: { requires: "agent.execute" } },
          commands: { install: "pnpm install" },
          git: { branchPattern: "agent/{slug}", pushRemote: "origin" },
          workspace: { strategy: "git-worktree", maxConcurrentExecutions: 1 },
          modules: [
            {
              instanceId: "development",
              moduleId: "jarvis.module.development",
              enabled: true,
              configuration: {
                readyLabel: "ready-to-dev",
                scope: { kind: "all" },
                validationOrder: ["test"],
                maxRepairCycles: 2,
                preparation: "install",
                retainWorkspaceOnSuccess: false,
                timeoutMs: 300000,
                outputLimitBytes: 1048576,
                environmentAllowlist: ["PATH"],
              },
            },
          ],
        }),
      );
      const legacySnapshot = {
        composition: JSON.parse(
          (
            db.prepare("SELECT portable_config FROM projects WHERE id = 'project'").get() as {
              portable_config: string;
            }
          ).portable_config,
        ),
        moduleInstances: [
          {
            instanceId: "development",
            moduleId: "jarvis.module.development",
            enabled: true,
            configuration: { readyLabel: "ready-to-dev", preparation: "install" },
          },
        ],
        bindings: { slots: {}, repository: { path: "/tmp/project", bookmarkRef: null } },
        requestRoutes: [],
      };
      db.prepare(
        `INSERT INTO project_resolved_compositions
           (project_id, composition_fingerprint, resolved_project, activated_at)
         VALUES ('project', 'fingerprint', ?, '2026-09-22')`,
      ).run(JSON.stringify(legacySnapshot));

      applyMigration(db, "0039");

      const row = db.prepare("SELECT portable_config FROM projects WHERE id = 'project'").get() as {
        portable_config: string;
      };
      expect(JSON.parse(row.portable_config)).toEqual({
        apiVersion: "jarvis.dev/project/v1",
        kind: "Project",
        metadata: { id: "project", name: "Project" },
        repositories: [{ id: "main", root: "." }],
        slots: { agentRuntime: { requires: "agent.execute" } },
        modules: [
          {
            instanceId: "development",
            moduleId: "jarvis.module.development",
            enabled: true,
            configuration: { readyLabel: "ready-to-dev" },
          },
        ],
      });
      const snapshot = db
        .prepare(
          "SELECT resolved_project FROM project_resolved_compositions WHERE project_id = 'project'",
        )
        .get() as { resolved_project: string };
      expect(JSON.parse(snapshot.resolved_project)).toMatchObject({
        composition: JSON.parse(row.portable_config),
        moduleInstances: [
          expect.objectContaining({ configuration: { readyLabel: "ready-to-dev" } }),
        ],
      });
    } finally {
      db.close();
    }
  });
});
