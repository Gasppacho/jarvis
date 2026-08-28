import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { components } from "../api/generated/local-api.ts";
import { JarvisError } from "../errors.ts";

export type RepositoryDiscovery = components["schemas"]["RepositoryDiscovery"];

/** Manifests are configuration, not payloads: refuse anything absurdly large. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

const LOCKFILES: ReadonlyArray<readonly [string, string]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

const INSTALL_COMMANDS: Record<string, string> = {
  pnpm: "pnpm install --frozen-lockfile",
  yarn: "yarn install --immutable",
  npm: "npm ci",
  bun: "bun install --frozen-lockfile",
};

/** Validates a caller-supplied repository path without touching its contents. */
export function requireRepositoryDirectory(path: unknown): string {
  if (typeof path !== "string" || path.trim() === "") {
    throw JarvisError.badRequest(
      "repository.path-required",
      "A repository path is required.",
    );
  }
  if (!isAbsolute(path)) {
    throw JarvisError.badRequest(
      "repository.path-not-absolute",
      "The repository path must be absolute. Choose the folder again.",
    );
  }
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw JarvisError.badRequest(
      "repository.not-found",
      "That folder no longer exists. Choose the repository again.",
    );
  }
  if (!statSync(resolved).isDirectory()) {
    throw JarvisError.badRequest(
      "repository.not-a-directory",
      "A Jarvis project must point at a folder, not a file.",
    );
  }
  // Canonical form, so the same working tree reached through a symlink is
  // recognised as already imported rather than bound to a second project.
  return realpathSync(resolved);
}

function readTextIfSmall(path: string): string | null {
  if (!existsSync(path)) return null;
  const stats = statSync(path);
  if (!stats.isFile() || stats.size > MAX_MANIFEST_BYTES) return null;
  return readFileSync(path, "utf8");
}

interface GitLayout {
  /** Holds HEAD for this working tree. */
  readonly gitDir: string;
  /** Holds the shared `config`; differs from gitDir inside a linked worktree. */
  readonly commonDir: string;
}

/**
 * Resolves the Git layout of a working tree.
 *
 * `.git` is a directory in a normal clone, but a *file* containing
 * `gitdir: <path>` in a linked worktree or a submodule. Jarvis's own workspace
 * strategy is `git-worktree`, so that shape has to be understood rather than
 * reported as a repository with no remote and no branch.
 */
function readGitLayout(root: string): GitLayout | null {
  const dotGit = join(root, ".git");
  if (!existsSync(dotGit)) return null;

  if (statSync(dotGit).isDirectory()) {
    return { gitDir: dotGit, commonDir: dotGit };
  }

  const match = /^gitdir:\s*(.+)$/m.exec(readTextIfSmall(dotGit) ?? "");
  const target = match?.[1]?.trim();
  if (target === undefined || target === "") return null;

  const gitDir = resolve(root, target);
  if (!existsSync(gitDir)) return null;

  // A linked worktree keeps shared state, remotes included, in commondir.
  const pointer = readTextIfSmall(join(gitDir, "commondir"));
  const commonDir = pointer === null ? gitDir : resolve(gitDir, pointer.trim());

  return { gitDir, commonDir: existsSync(commonDir) ? commonDir : gitDir };
}

/** Reads the first remote URL, preferring `origin`. */
function readRemoteUrl(gitConfig: string | null): string | null {
  if (gitConfig === null) return null;
  const remotes = new Map<string, string>();
  let current: string | null = null;

  for (const rawLine of gitConfig.split("\n")) {
    const line = rawLine.trim();
    const header = /^\[remote "([^"]+)"\]$/.exec(line);
    if (header !== null) {
      current = header[1] ?? null;
      continue;
    }
    if (line.startsWith("[")) {
      current = null;
      continue;
    }
    const url = /^url\s*=\s*(.+)$/.exec(line);
    if (url !== null && current !== null && !remotes.has(current)) {
      remotes.set(current, (url[1] ?? "").trim());
    }
  }
  return remotes.get("origin") ?? remotes.values().next().value ?? null;
}

function providerOf(remoteUrl: string | null): string | null {
  if (remoteUrl === null) return null;
  if (remoteUrl.includes("github.com")) return "github";
  if (remoteUrl.includes("gitlab.com")) return "gitlab";
  return null;
}

/** `.git/HEAD` names the checked-out branch, which is the best local guess. */
function readHeadBranch(head: string | null): string | null {
  if (head === null) return null;
  const match = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim());
  return match?.[1]?.trim() ?? null;
}

function readScripts(packageJson: string | null): Record<string, string> {
  if (packageJson === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    return {};
  }
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return {};

  const result: Record<string, string> = {};
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command === "string") result[name] = command;
  }
  return result;
}

/** A project id the Project Config schema accepts. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 100);
  return /^[a-z0-9]/.test(slug) ? slug : `project-${slug}`.slice(0, 100);
}

function suggestCommands(
  packageManager: string | null,
  scripts: Record<string, string>,
): Record<string, string> {
  const commands: Record<string, string> = {};
  if (
    packageManager !== null &&
    INSTALL_COMMANDS[packageManager] !== undefined
  ) {
    commands.install = INSTALL_COMMANDS[packageManager];
  }
  for (const name of ["lint", "typecheck", "test", "build"]) {
    if (scripts[name] !== undefined && packageManager !== null) {
      commands[name] = `${packageManager} ${name}`;
    }
  }
  return commands;
}

/**
 * Read-only inspection of a repository.
 *
 * Per docs/architecture/PROJECTS.md this reads `.git/config`, refs and
 * manifests. It never runs a project script and never writes to the folder.
 */
export function discoverRepository(
  repositoryPath: string,
): RepositoryDiscovery {
  const root = requireRepositoryDirectory(repositoryPath);
  const git = readGitLayout(root);
  const isGitRepository = git !== null;

  const remoteUrl = readRemoteUrl(
    git === null ? null : readTextIfSmall(join(git.commonDir, "config")),
  );
  const defaultBranch =
    git === null
      ? null
      : readHeadBranch(readTextIfSmall(join(git.gitDir, "HEAD")));

  const packageJson = readTextIfSmall(join(root, "package.json"));
  const scripts = readScripts(packageJson);
  const packageManager =
    LOCKFILES.find(([file]) => existsSync(join(root, file)))?.[1] ??
    (packageJson !== null ? "npm" : null);

  const name = basename(root);

  return {
    isGitRepository,
    remoteUrl,
    provider: providerOf(remoteUrl),
    defaultBranch,
    packageManager,
    scripts,
    // A starting point for the wizard, deliberately missing `slots` and
    // `modules`: those are chosen in tickets 04 and 05.
    suggested: {
      apiVersion: "jarvis.dev/project/v1",
      kind: "Project",
      metadata: { id: slugify(name), name },
      repositories: [
        {
          id: "main",
          root: ".",
          defaultBranch: defaultBranch ?? "main",
          remote: "origin",
        },
      ],
      commands: suggestCommands(packageManager, scripts),
      git: {
        branchPattern: "agent/{workItemId}-{slug}",
        commitStrategy: "conventional",
        pushRemote: "origin",
        allowForcePush: false,
      },
      workspace: {
        strategy: "git-worktree",
        maxConcurrentExecutions: 2,
        retainOnFailureDays: 7,
      },
    },
  };
}
