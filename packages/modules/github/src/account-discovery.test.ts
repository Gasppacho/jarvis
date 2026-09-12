import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubCliAccountDiscovery } from "./account-discovery.js";

describe("GitHubCliAccountDiscovery", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fakeGh(script: string): string {
    const root = mkdtempSync(join("/tmp", "jarvis-gh-discovery-"));
    roots.push(root);
    const executable = join(root, "gh");
    writeFileSync(executable, `#!/bin/sh\n${script}\n`, "utf8");
    chmodSync(executable, 0o755);
    return executable;
  }

  function discovery(executable: string, options: Record<string, unknown> = {}) {
    return new GitHubCliAccountDiscovery({
      cwd: process.cwd(),
      knownExecutablePaths: [executable],
      allowShellProbe: false,
      ...options,
    });
  }

  it("distinguishes no local account from an unavailable gh command", async () => {
    const noAccounts = fakeGh(`printf '%s\\n' '{"hosts":{"github.com":[]}}'; exit 1`);
    await expect(discovery(noAccounts).discover()).resolves.toEqual({
      status: "available",
      accounts: [],
    });

    const invalid = fakeGh("printf 'not json'; exit 1");
    await expect(discovery(invalid).discover()).resolves.toEqual({ status: "unavailable" });
  });

  it("never returns failed gh output or accepts oversized output", async () => {
    const sentinel = "ghs_discovery_failure_sentinel";
    const failed = fakeGh(`printf '%s\\n' '${sentinel}' >&2; exit 1`);
    const result = await discovery(failed).discover();
    expect(result).toEqual({ status: "unavailable" });
    expect(JSON.stringify(result)).not.toContain(sentinel);

    const oversized = fakeGh("printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'");
    await expect(discovery(oversized, { outputLimitBytes: 8 }).discover()).resolves.toEqual({
      status: "unavailable",
    });
  });
});
