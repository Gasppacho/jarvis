import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitRunner } from "../../../packages/workspace/src/git-runner.js";
import { makeRealGitRepositoryFixture } from "./repository-fixture.js";

describe("real Git workspace seam", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("lists the fixture worktree and returns a typed failure", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const runner = new GitRunner({ cwd: fixture.root });

    const worktrees = await runner.run(["worktree", "list", "--porcelain"]);

    expect(worktrees.ok).toBe(true);
    if (!worktrees.ok) throw new Error(worktrees.message);
    expect(worktrees.stdout.match(/^worktree /gm) ?? []).toHaveLength(1);
    expect(worktrees.stdout).toContain(`HEAD ${fixture.commitSha}`);
    expect(worktrees.stdout).toContain(`branch refs/heads/${fixture.branch}`);

    const failed = await runner.run(["rev-parse", "refs/heads/does-not-exist"]);

    expect(failed).toMatchObject({ ok: false, code: "git.non-zero-exit", exitCode: 128 });
    if (failed.ok) throw new Error("expected git failure");
    expect(failed.stderr).not.toHaveLength(0);
    expect(failed.stderr).not.toContain(fixture.root);
    expect(failed.message).not.toContain(fixture.root);
  });

  it("limits an ephemeral GitHub credential to its HTTPS repository", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const capture = join(fixture.root, "git-environment");
    const executable = join(fixture.root, "git-wrapper");
    writeFileSync(
      executable,
      `#!/bin/sh\nprintf '%s\\n' "$GIT_CONFIG_COUNT" "$GIT_CONFIG_KEY_0" "$GIT_CONFIG_VALUE_0" > '${capture}'\n`,
      "utf8",
    );
    chmodSync(executable, 0o755);
    const secret = "fixture-token-never-log";
    const result = await new GitRunner({ cwd: fixture.root, executablePath: executable }).run(
      ["push"],
      {
        credential: {
          username: "x-access-token",
          password: secret,
          remoteUrl: "https://github.com/Gasppacho/jarvis-test.git",
        },
      },
    );

    expect(result.ok).toBe(true);
    const environment = readFileSync(capture, "utf8");
    expect(environment).toContain("http.https://github.com/Gasppacho/jarvis-test.git.extraheader");
    expect(environment).toContain(
      `Authorization: Basic ${Buffer.from(`x-access-token:${secret}`).toString("base64")}`,
    );
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(
      await new GitRunner({ cwd: fixture.root, executablePath: executable }).run(["push"], {
        credential: {
          username: "x-access-token",
          password: secret,
          remoteUrl: "http://github.com/Gasppacho/jarvis-test.git",
        },
      }),
    ).toMatchObject({ ok: false, code: "git.invalid-arguments" });
  });

  it("bounds output and reports timeout and cancellation", async () => {
    const outputFixture = makeRealGitRepositoryFixture();
    roots.push(outputFixture.root, outputFixture.remoteRoot);
    const largeFile = join(outputFixture.root, "large.txt");
    writeFileSync(largeFile, "x".repeat(2_048), "utf8");
    const objectSha = execFileSync("git", ["hash-object", "-w", largeFile], {
      cwd: outputFixture.root,
      encoding: "utf8",
    }).trim();
    const output = await new GitRunner({ cwd: outputFixture.root, outputLimitBytes: 32 }).run([
      "cat-file",
      "blob",
      objectSha,
    ]);

    expect(output).toMatchObject({ ok: true, outputTruncated: true });
    if (!output.ok) throw new Error(output.message);
    expect(output.stdout).toContain("[output truncated]");
    expect(output.stdout).not.toContain(outputFixture.root);

    const timeoutFixture = makeRealGitRepositoryFixture();
    roots.push(timeoutFixture.root, timeoutFixture.remoteRoot);
    installSleepingCommitHook(timeoutFixture.root);
    const timedOut = await new GitRunner({ cwd: timeoutFixture.root }).run(
      ["commit", "--allow-empty", "--no-gpg-sign", "-m", "timeout"],
      { timeoutMs: 50 },
    );
    expect(timedOut).toMatchObject({ ok: false, code: "git.timed-out" });

    const cancellationFixture = makeRealGitRepositoryFixture();
    roots.push(cancellationFixture.root, cancellationFixture.remoteRoot);
    installSleepingCommitHook(cancellationFixture.root);
    const controller = new AbortController();
    const pending = new GitRunner({ cwd: cancellationFixture.root }).run(
      ["commit", "--allow-empty", "--no-gpg-sign", "-m", "cancel"],
      { signal: controller.signal, timeoutMs: 5_000 },
    );
    setTimeout(() => controller.abort(), 50).unref();
    await expect(pending).resolves.toMatchObject({ ok: false, code: "git.cancelled" });
  });
});

function installSleepingCommitHook(root: string): void {
  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nsleep 5\n", "utf8");
  chmodSync(hook, 0o755);
}
