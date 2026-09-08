import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
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
export function makeRepositoryFixture(options: RepositoryFixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-repo-"));
  mkdirSync(join(root, ".git"), { recursive: true });

  const remote = options.remoteUrl ?? "git@github.com:QServices/token-warehouse.git";
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
    writeFileSync(join(root, "package.json"), JSON.stringify(options.packageJson, null, 2), "utf8");
  }
  if (options.lockfile !== undefined) {
    writeFileSync(join(root, options.lockfile), "", "utf8");
  }
  if (options.projectYaml !== undefined) {
    mkdirSync(join(root, ".jarvis"), { recursive: true });
    writeFileSync(join(root, ".jarvis", "project.yaml"), options.projectYaml, "utf8");
  }
  return root;
}

/** A repository shaped like the reference workflow's example project. */
export function makeNodeRepositoryFixture(options: RepositoryFixtureOptions = {}): string {
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

export interface RealGitRepositoryFixture {
  readonly root: string;
  readonly branch: string;
  readonly commitSha: string;
}

export interface RealGitRepositoryFixtureOptions {
  readonly branch?: string;
}

/** A real repository for tests that exercise Git, not repository discovery. */
export function makeRealGitRepositoryFixture(
  options: RealGitRepositoryFixtureOptions = {},
): RealGitRepositoryFixture {
  const root = mkdtempSync(join(tmpdir(), "jarvis-real-git-"));
  const branch = options.branch ?? "main";
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) {
    rmSync(root, { recursive: true, force: true });
    throw new Error("fixture branch is invalid");
  }

  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] ?? "",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Jarvis Fixture",
    GIT_AUTHOR_EMAIL: "jarvis-fixture@example.invalid",
    GIT_COMMITTER_NAME: "Jarvis Fixture",
    GIT_COMMITTER_EMAIL: "jarvis-fixture@example.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };

  try {
    execFileSync("git", ["init", "--quiet", `--initial-branch=${branch}`], {
      cwd: root,
      env,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Jarvis Fixture"], {
      cwd: root,
      env,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.email", "jarvis-fixture@example.invalid"], {
      cwd: root,
      env,
      stdio: "ignore",
    });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify(
        { name: "jarvis-reference-repository", private: true, scripts: { test: "node --test" } },
        null,
      )}\n`,
      "utf8",
    );
    writeFileSync(
      join(root, "src", "server.ts"),
      'export const health = (): { status: "ok" } => ({ status: "ok" });\n',
      "utf8",
    );
    writeFileSync(
      join(root, "test", "server.test.ts"),
      'import { strict as assert } from "node:assert";\nassert.deepEqual({ status: "ok" }, { status: "ok" });\n',
      "utf8",
    );
    execFileSync("git", ["add", "--all"], { cwd: root, env, stdio: "ignore" });
    execFileSync("git", ["commit", "--quiet", "--no-gpg-sign", "-m", "Initial fixture"], {
      cwd: root,
      env,
      stdio: "ignore",
    });
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { root, branch, commitSha };
  } catch (error: unknown) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
