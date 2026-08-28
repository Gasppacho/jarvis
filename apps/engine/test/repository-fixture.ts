import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RepositoryFixtureOptions {
  readonly remoteUrl?: string;
  readonly branch?: string;
  readonly packageJson?: Record<string, unknown>;
  readonly lockfile?: string;
  readonly projectYaml?: string;
}

/**
 * A real on-disk Git repository, written as plain files. Discovery is
 * documented as read-only inspection of `.git/config`, refs and manifests
 * (docs/architecture/PROJECTS.md), so no `git` process is needed to build it.
 */
export function makeRepositoryFixture(
  options: RepositoryFixtureOptions = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-repo-"));
  mkdirSync(join(root, ".git"), { recursive: true });

  const remote =
    options.remoteUrl ?? "git@github.com:QServices/token-warehouse.git";
  writeFileSync(
    join(root, ".git", "config"),
    [
      "[core]",
      "\trepositoryformatversion = 0",
      '[remote "origin"]',
      `\turl = ${remote}`,
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
      '[branch "main"]',
      "\tremote = origin",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, ".git", "HEAD"),
    `ref: refs/heads/${options.branch ?? "main"}\n`,
    "utf8",
  );

  if (options.packageJson !== undefined) {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify(options.packageJson, null, 2),
      "utf8",
    );
  }
  if (options.lockfile !== undefined) {
    writeFileSync(join(root, options.lockfile), "", "utf8");
  }
  if (options.projectYaml !== undefined) {
    mkdirSync(join(root, ".jarvis"), { recursive: true });
    writeFileSync(
      join(root, ".jarvis", "project.yaml"),
      options.projectYaml,
      "utf8",
    );
  }
  return root;
}

/** A repository shaped like the reference workflow's example project. */
export function makeNodeRepositoryFixture(
  options: RepositoryFixtureOptions = {},
): string {
  return makeRepositoryFixture({
    packageJson: {
      name: "token-warehouse",
      scripts: {
        lint: "eslint .",
        typecheck: "tsc --noEmit",
        test: "vitest run",
        build: "tsup",
      },
    },
    lockfile: "pnpm-lock.yaml",
    ...options,
  });
}
