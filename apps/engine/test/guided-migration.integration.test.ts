import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { startReferenceWorkflowFixture } from "./reference-workflow-fixture.js";
import { classifyGuidedMigration, migratedConfiguration } from "../src/projects/migration.js";
import type { PortableProjectConfiguration } from "../../../packages/project-runtime/src/project-types.js";

describe("guided historical project migration", () => {
  it("refuses every non-D06 rule shape with a precise reason", () => {
    const base = {
      apiVersion: "jarvis.dev/project/v1",
      kind: "Project",
      metadata: { id: "p", name: "P" },
      repositories: [{ id: "main", root: ".", defaultBranch: "main", remote: "origin" }],
      slots: {},
      commands: {},
      git: {
        branchPattern: "x",
        commitStrategy: "conventional",
        pushRemote: "origin",
        allowForcePush: false,
      },
      workspace: { strategy: "git-worktree", maxConcurrentExecutions: 1, retainOnFailureDays: 7 },
      modules: [
        {
          instanceId: "github",
          moduleId: "jarvis.module.github",
          enabled: true,
          configuration: { readyLabel: "custom" },
        },
        {
          instanceId: "rules",
          moduleId: "jarvis.module.automation-rules",
          enabled: true,
          configuration: {
            rules: [
              {
                id: "r",
                when: { eventType: "scm.work-item.tag-added", equals: { "payload.tag": "custom" } },
                emit: {
                  type: "development.implementation.requested",
                  target: { moduleInstanceId: "development" },
                },
              },
            ],
          },
        },
        { instanceId: "development", moduleId: "jarvis.module.development", enabled: true },
      ],
    } as unknown as PortableProjectConfiguration;
    const bindings = {
      apiVersion: "jarvis.dev/project-bindings/v1",
      kind: "ProjectBindings",
      projectId: "p",
      repositories: {},
      slots: {},
    } as const;
    expect(classifyGuidedMigration(base, bindings).reasons.map(({ code }) => code)).toContain(
      "unknown-condition",
    );
    const extraRule = structuredClone(base);
    (extraRule.modules[1]!.configuration as Record<string, unknown>)["rules"] = [
      ...(extraRule.modules[1]!.configuration as { rules: unknown[] }).rules,
      (extraRule.modules[1]!.configuration as { rules: unknown[] }).rules[0],
    ];
    expect(classifyGuidedMigration(extraRule, bindings).reasons.map(({ code }) => code)).toContain(
      "rule-count",
    );
    const payloadRule = structuredClone(base);
    (
      (payloadRule.modules[1]!.configuration as { rules: Record<string, unknown>[] }).rules[0]![
        "emit"
      ] as Record<string, unknown>
    )["payload"] = { tag: "custom" };
    expect(
      classifyGuidedMigration(payloadRule, bindings).reasons.map(({ code }) => code),
    ).toContain("emission-shape");
  });

  it("preserves an exact optional work item scope", () => {
    const configuration = {
      apiVersion: "jarvis.dev/project/v1",
      kind: "Project",
      metadata: { id: "p", name: "P" },
      repositories: [{ id: "main", root: ".", defaultBranch: "main", remote: "origin" }],
      slots: {},
      commands: {},
      git: {
        branchPattern: "x",
        commitStrategy: "conventional",
        pushRemote: "origin",
        allowForcePush: false,
      },
      workspace: { strategy: "git-worktree", maxConcurrentExecutions: 1, retainOnFailureDays: 7 },
      modules: [
        {
          instanceId: "github",
          moduleId: "jarvis.module.github",
          enabled: true,
          configuration: { readyLabel: "custom" },
        },
        {
          instanceId: "rules",
          moduleId: "jarvis.module.automation-rules",
          enabled: true,
          configuration: {
            rules: [
              {
                id: "r",
                when: {
                  eventType: "scm.work-item.ready",
                  equals: {
                    "payload.tag": "custom",
                    "payload.workItemRef": "github://owner/repo/issues/7",
                  },
                },
                emit: {
                  type: "development.implementation.requested",
                  target: { moduleInstanceId: "development" },
                },
              },
            ],
          },
        },
        { instanceId: "development", moduleId: "jarvis.module.development", enabled: true },
      ],
    } as unknown as PortableProjectConfiguration;
    const bindings = {
      apiVersion: "jarvis.dev/project-bindings/v1",
      kind: "ProjectBindings",
      projectId: "p",
      repositories: {},
      slots: {},
    } as const;
    const classified = classifyGuidedMigration(configuration, bindings);
    expect(classified.reasons).toEqual([]);
    const migrated = migratedConfiguration(configuration, classified.plan!);
    expect(
      migrated.modules.find(({ moduleId }) => moduleId === "jarvis.module.development")
        ?.configuration?.["scope"],
    ).toBeUndefined();
    const allConfiguration = structuredClone(configuration);
    const allWhen = (
      allConfiguration.modules[1]!.configuration!["rules"] as Record<string, unknown>[]
    )[0]!["when"] as Record<string, unknown>;
    allWhen["equals"] = { "payload.tag": "custom" };
    expect(
      classifyGuidedMigration(allConfiguration, bindings).plan?.destination,
    ).not.toHaveProperty("scope");
  });

  it("previews and applies exact D06 once, preserving the local backup across restart", async () => {
    const fixture = await startReferenceWorkflowFixture("guided-migration", {}, true, false);
    try {
      const detail = (await (
        await fixture.engine.call(`/v1/projects/${fixture.projectId}`)
      ).json()) as { portableConfig: PortableProjectConfiguration };
      const scoped = structuredClone(detail.portableConfig);
      const rulesModule = scoped.modules.find(
        ({ moduleId }) => moduleId === "jarvis.module.automation-rules",
      )!;
      const rules = rulesModule.configuration!["rules"] as Record<string, unknown>[];
      const when = rules[0]!["when"] as Record<string, unknown>;
      (when["equals"] as Record<string, unknown>)["payload.workItemRef"] =
        "github://Gasppacho/jarvis/issues/231";
      const saved = await fixture.engine.call(`/v1/projects/${fixture.projectId}/configuration`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ portableConfig: scoped, writeToRepository: false }),
      });
      expect(saved.status).toBe(200);
      const db = new Database(`${fixture.engine.dataRoot}/jarvis.sqlite`);
      db.prepare("UPDATE projects SET status = 'paused' WHERE id = ?").run(fixture.projectId);
      db.close();

      const preview = await fixture.engine.call(
        `/v1/projects/${fixture.projectId}/migration/preview`,
        { method: "POST" },
      );
      const previewBody = (await preview.json()) as Record<string, any>;
      expect(preview.status).toBe(200);
      expect(previewBody["canApply"]).toBe(true);
      expect((previewBody["plan"] as Record<string, any>)["destination"]).toMatchObject({
        compositionMode: "fixed-modules",
        readyLabel: "ready-for-agent",
      });
      expect((previewBody["plan"] as Record<string, any>)["destination"]).not.toHaveProperty(
        "scope",
      );
      expect((previewBody["plan"] as Record<string, any>)["removedModule"]).toBe(
        "jarvis.module.automation-rules",
      );

      const applied = await fixture.engine.call(
        `/v1/projects/${fixture.projectId}/migration/apply`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            compositionFingerprint: previewBody["compositionFingerprint"],
            writeToRepository: false,
          }),
        },
      );
      const appliedBody = (await applied.json()) as Record<string, any>;
      expect(applied.status, JSON.stringify(appliedBody)).toBe(200);
      expect(appliedBody["applied"]).toBe(true);
      expect(
        ((appliedBody["backup"] as Record<string, any>)["configuration"] as Record<string, any>)[
          "modules"
        ],
      ).toHaveLength(3);
      expect(appliedBody["configuration"]).toMatchObject({ compositionMode: "fixed-modules" });
      const migratedModules = (appliedBody["configuration"] as Record<string, unknown>)[
        "modules"
      ] as { moduleId: string; configuration?: Record<string, unknown> }[];
      expect(
        migratedModules.find(({ moduleId }) => moduleId === "jarvis.module.github")?.configuration,
      ).not.toHaveProperty("readyLabel");
      expect(
        migratedModules.find(({ moduleId }) => moduleId === "jarvis.module.development")
          ?.configuration?.["readyLabel"],
      ).toBe("ready-for-agent");
      expect(
        migratedModules.find(({ moduleId }) => moduleId === "jarvis.module.development")
          ?.configuration,
      ).not.toHaveProperty("scope");

      await fixture.restart();
      const retry = await fixture.engine.call(`/v1/projects/${fixture.projectId}/migration/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          compositionFingerprint: previewBody["compositionFingerprint"],
          writeToRepository: false,
        }),
      });
      expect(await retry.json()).toEqual(appliedBody);
    } finally {
      await fixture.dispose();
    }
  });
});
