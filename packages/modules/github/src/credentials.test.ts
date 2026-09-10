import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubCliCredentialResolver } from "./credentials.js";

describe("GitHubCliCredentialResolver", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fakeGh(script: string, executable = "gh"): string {
    const root = mkdtempSync(join("/tmp", "jarvis-gh-"));
    roots.push(root);
    const path = join(root, executable);
    writeFileSync(path, `#!/bin/sh\n${script}\n`, "utf8");
    chmodSync(path, 0o755);
    return path;
  }

  function resolver(path: string, options: Record<string, unknown> = {}) {
    return new GitHubCliCredentialResolver({
      cwd: process.cwd(),
      knownExecutablePaths: [path],
      allowShellProbe: false,
      ...options,
    });
  }

  it("resolves the requested gh account and returns the credential only to the caller", async () => {
    const sentinel = "ghs_test_sentinel";
    const executable = fakeGh(
      `case "$*" in *"--user Gasppacho"*) printf '%s\\n' '${sentinel}';; *) exit 42;; esac`,
    );

    await expect(resolver(executable).resolve("gh://Gasppacho")).resolves.toEqual({
      status: "available",
      credential: sentinel,
    });
  });

  it("does not fall back when gh or the named account is unavailable", async () => {
    const missing = join(mkdtempSync(join("/tmp", "jarvis-gh-missing-")), "gh");
    roots.push(missing.slice(0, missing.lastIndexOf("/")));
    await expect(resolver(missing).resolve("gh://Gasppacho")).resolves.toEqual({
      status: "unavailable",
    });

    const relative = new GitHubCliCredentialResolver({
      cwd: process.cwd(),
      knownExecutablePaths: ["gh"],
      allowShellProbe: false,
    });
    await expect(relative.resolve("gh://Gasppacho")).resolves.toEqual({ status: "unavailable" });

    const executable = fakeGh("exit 1");
    await expect(resolver(executable).resolve("gh://unknown")).resolves.toEqual({
      status: "unauthenticated",
    });
  });

  it("rejects a non-executable candidate and bounds slow or oversized output", async () => {
    const nonExecutable = fakeGh("printf ignored");
    chmodSync(nonExecutable, 0o644);
    await expect(resolver(nonExecutable).resolve("gh://Gasppacho")).resolves.toEqual({
      status: "unavailable",
    });

    const slow = fakeGh("sleep 5");
    const startedAt = Date.now();
    await expect(resolver(slow, { timeoutMs: 20 }).resolve("gh://Gasppacho")).resolves.toEqual({
      status: "unavailable",
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    const oversized = fakeGh("printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'");
    await expect(
      resolver(oversized, { outputLimitBytes: 8 }).resolve("gh://Gasppacho"),
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("discards failing command output instead of returning or exposing it", async () => {
    const sentinel = "ghs_failure_sentinel";
    const executable = fakeGh(`printf '%s\\n' '${sentinel}' >&2; exit 1`);
    const result = await resolver(executable).resolve("gh://Gasppacho");

    expect(result).toEqual({ status: "unauthenticated" });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });
});
