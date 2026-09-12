import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { StoredPortableProjectConfiguration } from "../../../../packages/project-runtime/src/project-types.js";
import { parseRepositoryRemote } from "./discovery.js";
import { ProjectRepositoryResolver } from "./repository-resolution.js";
import type { ResolvedProjectSnapshot } from "./store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Project repository resolution", () => {
  it.each([
    "https://github.com/Gasppacho/jarvis.git",
    "https://github.com/Gasppacho/jarvis",
    "git@github.com:Gasppacho/jarvis.git",
    "git@github.com:Gasppacho/jarvis",
    "alice@github.com:Gasppacho/jarvis.git",
    "ssh://git@github.com/Gasppacho/jarvis.git",
    "ssh://git@github.com/Gasppacho/jarvis",
  ])("normalizes %s to the same GitHub identity", (remote) => {
    expect(parseRepositoryRemote(remote)).toEqual({
      provider: "github",
      owner: "Gasppacho",
      repository: "jarvis",
    });
  });

  it.each(["http://github.com/Gasppacho/jarvis.git", "file://github.com/Gasppacho/jarvis.git"])(
    "does not treat unsupported URL scheme %s as a GitHub identity",
    (remote) => {
      expect(parseRepositoryRemote(remote)).toEqual({ provider: null });
    },
  );

  it("resolves each portable ID through its selected remote, regardless of module order", () => {
    const root = repositoryFixture(
      [
        '[remote "origin"]',
        "\turl = git@github.com:Gasppacho/jarvis.git",
        '[remote "upstream"]',
        "\turl = https://github.com/Other/repo.git",
      ].join("\n"),
    );
    const result = new ProjectRepositoryResolver().validate(
      configuration(
        [
          { id: "main", remote: "origin" },
          { id: "secondary", remote: "upstream" },
        ],
        ["secondary", "main"],
      ),
      root,
    );

    expect(result.findings).toEqual([]);
    expect(result.repositoryIdentities).toEqual([
      { repositoryId: "main", provider: "github", owner: "Gasppacho", name: "jarvis" },
      { repositoryId: "secondary", provider: "github", owner: "Other", name: "repo" },
    ]);
  });

  it("refuses a selected remote with multiple URLs instead of choosing one", () => {
    const root = repositoryFixture(
      [
        '[remote "origin"]',
        "\turl = git@github.com:Gasppacho/jarvis.git",
        "\turl = https://Other/repo.git",
      ].join("\n"),
    );
    const result = new ProjectRepositoryResolver().validate(
      configuration([{ id: "main", remote: "origin" }], ["main"]),
      root,
    );

    expect(result.findings).toMatchObject([
      {
        severity: "error",
        message: expect.stringContaining("exactly one URL"),
      },
    ]);
    expect(result.repositoryIdentities).toEqual([]);
  });

  it.each([
    {
      name: "unknown ID",
      repositories: [{ id: "main", remote: "origin" }],
      references: ["missing"],
      remote: "git@github.com:Gasppacho/jarvis.git",
      action: "Use a repository ID declared by the Project",
      identityCount: 1,
    },
    {
      name: "absent remote",
      repositories: [{ id: "main", remote: "missing" }],
      references: ["main"],
      remote: "git@github.com:Gasppacho/jarvis.git",
      action: "Configure the declared remote",
      identityCount: 0,
    },
    {
      name: "unsupported provider",
      repositories: [{ id: "main", remote: "origin" }],
      references: ["main"],
      remote: "https://gitlab.com/Gasppacho/jarvis.git",
      action: "Select a supported GitHub remote",
      identityCount: 0,
    },
  ])(
    "reports an actionable error for an $name",
    ({ repositories, references, remote, action, identityCount }) => {
      const root = repositoryFixture(`[remote "origin"]\n\turl = ${remote}\n`);
      const result = new ProjectRepositoryResolver().validate(
        configuration(repositories, references),
        root,
      );

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({ severity: "error" });
      expect(result.findings[0]?.message).toContain("Impact:");
      expect(result.findings[0]?.message).toContain(`Action: ${action}`);
      expect(result.repositoryIdentities).toHaveLength(identityCount);
    },
  );

  it("keeps a unique historical slug readable and rejects an ambiguous one", () => {
    const uniqueRoot = repositoryFixture(
      '[remote "origin"]\n\turl = git@github.com:Gasppacho/jarvis.git\n',
    );
    const resolver = new ProjectRepositoryResolver();
    const unique = resolver.validate(
      configuration([{ id: "main", remote: "origin" }], ["Gasppacho/jarvis.git"]),
      uniqueRoot,
    );
    expect(unique.findings).toMatchObject([
      {
        severity: "warning",
        message: expect.stringContaining('portable repository ID "main"'),
        repositoryReferenceReplacement: {
          field: "/configuration/repositories",
          from: "Gasppacho/jarvis.git",
          to: "main",
        },
      },
    ]);

    const ambiguousRoot = repositoryFixture(
      [
        '[remote "origin"]',
        "\turl = git@github.com:Gasppacho/jarvis.git",
        '[remote "upstream"]',
        "\turl = https://github.com/Gasppacho/jarvis.git",
      ].join("\n"),
    );
    const ambiguous = resolver.validate(
      configuration(
        [
          { id: "main", remote: "origin" },
          { id: "secondary", remote: "upstream" },
        ],
        ["Gasppacho/jarvis"],
      ),
      ambiguousRoot,
    );
    expect(ambiguous.findings).toMatchObject([
      {
        severity: "error",
        message: expect.stringContaining("unique declared portable repository ID"),
      },
    ]);
  });

  it("keeps remote credentials and machine paths out of validation findings", () => {
    const root = repositoryFixture(
      '[remote "origin"]\n\turl = https://secret:token@github.com/Gasppacho/jarvis.git\n',
    );
    const result = new ProjectRepositoryResolver().validate(
      configuration([{ id: "main", remote: "origin" }], ["Gasppacho/jarvis"]),
      root,
    );

    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("token");
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("does not resolve a pre-#188 snapshot from a remote that changed after activation", () => {
    const root = repositoryFixture(
      '[remote "origin"]\n\turl = git@github.com:Gasppacho/jarvis.git\n',
    );
    const project = configuration([{ id: "main", remote: "origin" }], ["main"]);
    const snapshot: ResolvedProjectSnapshot = {
      composition: project,
      moduleInstances: project.modules,
      bindings: { slots: {}, repository: { path: root, bookmarkRef: null } },
      requestRoutes: [],
    };

    writeFileSync(
      join(root, ".git", "config"),
      '[remote "origin"]\n\turl = https://other.example/repo.git\n',
      "utf8",
    );

    const resolver = new ProjectRepositoryResolver();
    expect(resolver.resolve(snapshot, "main")).toEqual({ status: "identity-unresolved" });
    expect(resolver.identity(snapshot, "main")).toBeUndefined();
    expect(resolver.migrationFinding(project, snapshot)).toMatchObject({
      code: "project.instance-config-invalid",
      severity: "warning",
      message: expect.stringContaining("activate again"),
    });
    expect(
      resolver.migrationFinding(project, {
        ...snapshot,
        repositoryIdentities: [],
      }),
    ).toBeUndefined();
  });
});

function repositoryFixture(gitConfig: string): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-repository-resolution-"));
  roots.push(root);
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), gitConfig, "utf8");
  return root;
}

function configuration(
  repositories: readonly { readonly id: string; readonly remote: string }[],
  references: readonly string[],
): StoredPortableProjectConfiguration {
  return {
    apiVersion: "jarvis.dev/project/v1",
    kind: "Project",
    metadata: { id: "repository-resolution", name: "Repository Resolution" },
    repositories: repositories.map((repository) => ({
      ...repository,
      root: "." as const,
      defaultBranch: "main",
    })),
    slots: {},
    commands: {},
    git: {
      branchPattern: "agent/{slug}",
      commitStrategy: "conventional",
      pushRemote: "origin",
      allowForcePush: false,
    },
    workspace: {
      strategy: "git-worktree",
      maxConcurrentExecutions: 1,
      retainOnFailureDays: 1,
    },
    modules: [
      {
        instanceId: "github",
        moduleId: "jarvis.module.github",
        enabled: true,
        configuration: { repositories: [...references] },
      },
    ],
  };
}
