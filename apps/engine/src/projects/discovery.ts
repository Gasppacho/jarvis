import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { SuggestedProjectConfig } from "./types.js";
import type { RepositoryDiscovery } from "./types.js";

/**
 * Read-only repository inspection (docs/architecture/PROJECTS.md "Detection"):
 * plain file reads of `.git/config`, `.git/HEAD`, lockfiles and `package.json`.
 * Discovery never spawns git, never executes a project script and never writes
 * to the inspected folder.
 */

/** Raised when the caller-supplied repository path cannot be inspected. */
export class RepositoryPathError extends Error {}

/**
 * Canonicalise a caller-supplied repository path. Throws on anything that is
 * not an existing absolute directory. The `realpath` is what makes a working
 * tree reached through a symlink resolve to the path the store already knows.
 */
export function requireRepositoryDirectory(value: unknown): string {
  if (typeof value !== "string") {
    throw new RepositoryPathError("A repository path is required.");
  }
  const path = value.trim();
  if (path === "") {
    throw new RepositoryPathError("A repository path is required.");
  }
  if (!isAbsolute(path)) {
    throw new RepositoryPathError(
      `The repository path must be absolute; the Local API only inspects folders on this machine (got "${path}").`,
    );
  }
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new RepositoryPathError(`The repository at "${path}" does not exist.`);
  }
  if (!stats.isDirectory()) {
    throw new RepositoryPathError(`The repository path "${path}" is not a directory.`);
  }
  return realpathSync(path);
}

/**
 * A directory name into an identifier the project-config schema accepts
 * (`^[a-z0-9][a-z0-9._-]*$`).
 */
export function slugify(name: string): string {
  const dashed = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const trimmed = dashed.replace(/^[^a-z0-9]+/, "").replace(/[-._]+$/, "");
  return trimmed;
}

export function discoverRepository(root: unknown): RepositoryDiscovery {
  const canonical = requireRepositoryDirectory(root);
  const git = readGitDirectory(canonical);
  const remote = git === undefined ? undefined : readRemote(git.commonDir);
  const defaultBranch = git === undefined ? undefined : readHead(git.gitDir);

  const manifest = readPackageManifest(canonical);
  const packageManager = detectPackageManager(canonical, manifest !== undefined);

  return {
    isGitRepository: git !== undefined,
    remoteUrl: remote?.url ?? null,
    provider: remote === undefined ? null : providerFor(remote.url),
    defaultBranch: defaultBranch ?? null,
    packageManager,
    scripts: manifest?.scripts ?? {},
    suggested: buildSuggested(
      canonical,
      remote?.name,
      defaultBranch ?? null,
      packageManager,
      manifest,
    ),
  };
}

// --------------------------------------------------------------------------
// .git
// --------------------------------------------------------------------------

interface GitLocations {
  /** Where `HEAD` and the worktree live: `.git`, or the directory a `gitdir:` file points at. */
  readonly gitDir: string;
  /** Where shared files such as `config` live: the common directory of the repository. */
  readonly commonDir: string;
}

/**
 * A plain repository has a `.git` directory; a linked worktree or a submodule
 * has a `.git` *file* containing `gitdir: <path>`. The shared `config` lives in
 * the common directory, which the worktree/submodule directory names through
 * its own `commondir` file.
 */
function readGitDirectory(root: string): GitLocations | undefined {
  let entry;
  try {
    entry = statSync(join(root, ".git"));
  } catch {
    return undefined;
  }
  if (entry.isDirectory()) {
    const gitDir = join(root, ".git");
    return { gitDir, commonDir: gitDir };
  }
  if (!entry.isFile()) return undefined;

  let gitDir: string;
  try {
    const content = readFileSync(join(root, ".git"), "utf8");
    const match = content.match(/^gitdir:\s*(.+?)\s*$/m);
    if (match === null || match[1] === undefined) return undefined;
    gitDir = resolve(root, match[1]);
  } catch {
    return undefined;
  }
  return { gitDir, commonDir: readCommonDir(gitDir) };
}

/** Plain repositories have no `commondir` file; their git dir *is* the common dir. */
function readCommonDir(gitDir: string): string {
  try {
    const relative = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    return relative === "" ? gitDir : resolve(gitDir, relative);
  } catch {
    return gitDir;
  }
}

interface Remote {
  readonly name: string;
  readonly url: string;
}

/** Remotes are parsed from the common directory's `config`, origin preferred. */
function readRemote(commonDir: string): Remote | undefined {
  let text: string;
  try {
    text = readFileSync(join(commonDir, "config"), "utf8");
  } catch {
    return undefined;
  }

  const remotes: Record<string, string> = {};
  let section = "";
  for (const line of text.split("\n")) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch !== null && sectionMatch[1] !== undefined) {
      section = sectionMatch[1].trim();
      continue;
    }
    const keyMatch = line.match(/^\s*([A-Za-z0-9]+)\s*=\s*(.+?)\s*$/);
    if (keyMatch === null || keyMatch[1] !== "url" || keyMatch[2] === undefined) continue;
    if (!section.startsWith("remote ")) continue;
    const name = section.slice("remote ".length).trim().replace(/^"|"$/g, "").trim();
    if (name !== "") remotes[name] = keyMatch[2];
  }

  if (remotes["origin"] !== undefined) return { name: "origin", url: remotes["origin"] };
  const entries = Object.entries(remotes);
  const [only] = entries;
  // With several remotes and no origin the default cannot be guessed.
  return entries.length === 1 && only !== undefined ? { name: only[0], url: only[1] } : undefined;
}

function providerFor(remoteUrl: string): string | null {
  let host: string | undefined;
  try {
    host = new URL(remoteUrl).hostname;
  } catch {
    // scp-like syntax: `git@github.com:owner/repo.git`
    const match = remoteUrl.match(/^git@([^:/]+):/);
    host = match?.[1];
  }
  if (host === undefined) return null;
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (host === "gitlab.com" || host.endsWith(".gitlab.com")) return "gitlab";
  if (host === "bitbucket.org") return "bitbucket";
  return null;
}

/** `ref: refs/heads/<branch>` names the branch; a raw object id is detached. */
function readHead(gitDir: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  } catch {
    return null;
  }
  const match = text.match(/^ref:\s*refs\/heads\/(.+)$/);
  return match?.[1] ?? null;
}

// --------------------------------------------------------------------------
// Manifests
// --------------------------------------------------------------------------

interface PackageManifest {
  /** `undefined` when the manifest has no usable `name` field. */
  readonly name?: string | undefined;
  readonly scripts: Record<string, string>;
}

/** Non-executable read of `package.json`; malformed or absent manifests yield no scripts. */
function readPackageManifest(root: string): PackageManifest | undefined {
  let text: string;
  try {
    text = readFileSync(join(root, "package.json"), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const object = parsed as { name?: unknown; scripts?: unknown };
  const scripts: Record<string, string> = {};
  if (typeof object.scripts === "object" && object.scripts !== null) {
    for (const [name, command] of Object.entries(object.scripts as Record<string, unknown>)) {
      if (typeof command === "string" && command !== "") scripts[name] = command;
    }
  }
  return {
    name: typeof object.name === "string" && object.name !== "" ? object.name : undefined,
    scripts,
  };
}

const LOCKFILES: Record<string, string> = {
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "package-lock.json": "npm",
  "bun.lockb": "bun",
  "bun.lock": "bun",
};

function detectPackageManager(root: string, hasManifest: boolean): string | null {
  for (const [file, manager] of Object.entries(LOCKFILES)) {
    try {
      if (statSync(join(root, file)).isFile()) return manager;
    } catch {
      /* absent */
    }
  }
  // A manifest without any lockfile is still a Node project: npm is the default.
  return hasManifest ? "npm" : null;
}

// --------------------------------------------------------------------------
// Suggested draft
// --------------------------------------------------------------------------

function buildSuggested(
  canonical: string,
  remoteName: string | undefined,
  defaultBranch: string | null,
  packageManager: string | null,
  manifest: PackageManifest | undefined,
): SuggestedProjectConfig {
  const directoryName = basename(canonical) || "project";
  const name = manifest?.name ?? directoryName;
  const id = slugify(name) || "project";

  const commands: Record<string, string> = {};
  // A frozen install is the only one the engine can recommend before the project
  // has ever been built on this machine; it needs a lockfile to be meaningful.
  if (packageManager !== null) {
    const hasLockfile = Object.keys(LOCKFILES).some((file) => {
      try {
        return statSync(join(canonical, file)).isFile();
      } catch {
        return false;
      }
    });
    if (hasLockfile) {
      commands["install"] = `${packageManager} install --frozen-lockfile`;
    }
  }
  // Standard commands are invoked by script *name* through the package manager,
  // never by quoting the declared command line: the wizard re-displays the
  // declared script, and the suggestion stays stable even for a complex one.
  for (const standard of ["lint", "typecheck", "test", "build"]) {
    if (manifest?.scripts[standard] !== undefined && packageManager !== null) {
      commands[standard] = `${packageManager} ${standard}`;
    }
  }

  return {
    apiVersion: "jarvis.dev/project/v1",
    kind: "Project",
    metadata: { id, name },
    repositories: [
      {
        id: "main",
        root: ".",
        // `main` is a guess, but the wizard (UX step 2) shows it for confirmation;
        // an unknown branch must not silently steer the development module.
        defaultBranch: defaultBranch ?? "main",
        remote: remoteName ?? "origin",
      },
    ],
    commands,
    git: {
      branchPattern: "agent/{workItemId}-{slug}",
      commitStrategy: "conventional",
      pushRemote: remoteName ?? "origin",
      allowForcePush: false,
    },
    workspace: {
      strategy: "git-worktree",
      maxConcurrentExecutions: 1,
      retainOnFailureDays: 7,
    },
  };
}
