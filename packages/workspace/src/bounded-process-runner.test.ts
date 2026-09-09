import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBoundedProcess, type BoundedProcessRequest } from "./bounded-process-runner.js";

describe("bounded process runner", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("runs a command with an explicit environment and redacts workspace, home and secrets", async () => {
    const cwd = mkdtempSync(join(process.env["TMPDIR"] ?? "/tmp", "jarvis-process-runner-"));
    roots.push(cwd);

    const result = await runNode(
      cwd,
      `
      process.stdout.write(${JSON.stringify(`${cwd} ${homedir()} token=secret-value `)});
      process.stdout.write(process.env.JARVIS_RUNNER_EXPLICIT ?? "missing");
      process.stdout.write(" path=" + (process.env.PATH ?? "missing"));
    `,
    );

    expect(result).toMatchObject({
      ok: true,
      stdout: "<workspace> <home> token=<redacted> explicit path=missing",
      outputTruncated: false,
    });
    expect(result.stdout).not.toContain(cwd);
    expect(result.stdout).not.toContain(homedir());
    expect(result.stdout).not.toContain("secret-value");
  });

  it("returns a typed non-zero result", async () => {
    const cwd = makeCwd(roots);
    const result = await runNode(
      cwd,
      'process.stdout.write("out"); process.stderr.write("err"); process.exit(7);',
    );

    expect(result).toMatchObject({
      ok: false,
      code: "process.non-zero-exit",
      exitCode: 7,
      stdout: "out",
      stderr: "err",
    });
  });

  it("times out and stops a still-running command", async () => {
    const cwd = makeCwd(roots);
    const result = await runNode(cwd, "setTimeout(() => {}, 5000);", { timeoutMs: 25 });

    expect(result).toMatchObject({ ok: false, code: "process.timed-out" });
  });

  it("bounds output and appends the truncation marker", async () => {
    const cwd = makeCwd(roots);
    const result = await runNode(cwd, 'process.stdout.write("x".repeat(128));', {
      outputLimitBytes: 16,
    });

    expect(result).toMatchObject({
      ok: true,
      outputTruncated: true,
      stdout: "xxxxxxxxxxxxxxxx\n[output truncated]\n",
    });
  });

  it("cancels a still-running command through AbortSignal", async () => {
    const controller = new AbortController();
    const cwd = mkdtempSync(join(process.env["TMPDIR"] ?? "/tmp", "jarvis-process-runner-"));
    roots.push(cwd);
    const pending = runNode(cwd, "setTimeout(() => {}, 5000);", {
      signal: controller.signal,
      timeoutMs: 5000,
    });
    setTimeout(() => controller.abort(), 25).unref();

    await expect(pending).resolves.toMatchObject({ ok: false, code: "process.cancelled" });
  });
});

function runNode(
  cwd: string,
  script: string,
  overrides: Pick<BoundedProcessRequest, "signal" | "timeoutMs" | "outputLimitBytes"> = {},
): Promise<Awaited<ReturnType<typeof runBoundedProcess>>> {
  return runBoundedProcess({
    executable: process.execPath,
    args: ["-e", script],
    cwd,
    env: { JARVIS_RUNNER_EXPLICIT: "explicit" },
    ...overrides,
  });
}

function makeCwd(roots: string[]): string {
  const cwd = mkdtempSync(join(process.env["TMPDIR"] ?? "/tmp", "jarvis-process-runner-"));
  roots.push(cwd);
  return cwd;
}
