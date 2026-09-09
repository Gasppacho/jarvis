import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeRealGitRepositoryFixture } from "./repository-fixture.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("real Git repository fixture", () => {
  it("pushes a branch to its bare remote and reads the ref back", () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    expect(fixture.remoteName).toBe("origin");
    expect(fixture.remoteRoot).toMatch(/jarvis-bare-git-/);
    const branch = "agent/86-local-bare-remote";

    execFileSync("git", ["switch", "--create", branch], { cwd: fixture.root, stdio: "ignore" });
    writeFileSync(join(fixture.root, "fixture-change.txt"), "pushed\n", "utf8");
    execFileSync("git", ["add", "fixture-change.txt"], { cwd: fixture.root, stdio: "ignore" });
    execFileSync("git", ["commit", "--quiet", "--no-gpg-sign", "-m", "Fixture change"], {
      cwd: fixture.root,
      stdio: "ignore",
    });
    const commitSha = git(fixture.root, ["rev-parse", "HEAD"]);

    expect(git(fixture.root, ["remote", "get-url", fixture.remoteName])).toBe(fixture.remoteRoot);
    execFileSync("git", ["push", fixture.remoteName, `HEAD:refs/heads/${branch}`], {
      cwd: fixture.root,
      stdio: "ignore",
    });

    expect(gitDir(fixture.remoteRoot, ["rev-parse", `refs/heads/${branch}`])).toBe(commitSha);
  });
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitDir(gitDir: string, args: readonly string[]): string {
  return execFileSync("git", ["--git-dir", gitDir, ...args], { encoding: "utf8" }).trim();
}
