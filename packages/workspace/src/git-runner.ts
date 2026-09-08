import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export type GitFailureCode =
  | "git.executable-not-found"
  | "git.invalid-working-directory"
  | "git.invalid-arguments"
  | "git.spawn-failed"
  | "git.non-zero-exit"
  | "git.timed-out"
  | "git.cancelled";

export interface GitCommandSuccess {
  readonly ok: true;
  readonly exitCode: 0;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
}

export interface GitCommandFailure {
  readonly ok: false;
  readonly code: GitFailureCode;
  readonly message: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
}

export type GitCommandResult = GitCommandSuccess | GitCommandFailure;

export interface GitRunnerOptions {
  readonly cwd: string;
  /** Optional absolute executable path for deterministic adapter tests. */
  readonly executablePath?: string;
  readonly timeoutMs?: number;
  readonly outputLimitBytes?: number;
}

export interface GitRunOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly outputLimitBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
const MAX_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 250;
const TRUNCATION_MARKER = "\n[output truncated]\n";

class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private truncated = false;

  constructor(private readonly limitBytes: number) {}

  append(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = this.limitBytes - this.size;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    if (bytes.byteLength <= remaining) {
      this.chunks.push(bytes);
      this.size += bytes.byteLength;
      return;
    }
    this.chunks.push(bytes.subarray(0, remaining));
    this.size = this.limitBytes;
    this.truncated = true;
  }

  text(): string {
    const output = Buffer.concat(this.chunks).toString("utf8");
    return this.truncated ? `${output}${TRUNCATION_MARKER}` : output;
  }

  get wasTruncated(): boolean {
    return this.truncated;
  }
}

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function resolveGitExecutable(requestedPath?: string): string | undefined {
  const executable = process.platform === "win32" ? "git.exe" : "git";
  if (requestedPath !== undefined) {
    if (!isAbsolute(requestedPath)) return undefined;
    try {
      accessSync(requestedPath, constants.X_OK);
      return statSync(requestedPath).isFile() ? requestedPath : undefined;
    } catch {
      return undefined;
    }
  }
  const systemCandidates =
    process.platform === "win32"
      ? []
      : ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"];
  const pathCandidates = (process.env["PATH"] ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .map((entry) => join(entry, executable));

  for (const candidate of [...systemCandidates, ...pathCandidates]) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next absolute candidate without exposing filesystem details.
    }
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactOutput(value: string, cwd: string): string {
  let redacted = value;
  for (const [path, replacement] of [
    [cwd, "<workspace>"],
    [homedir(), "<home>"],
  ] as const) {
    if (path.length > 1)
      redacted = redacted.replace(new RegExp(escapeRegExp(path), "g"), replacement);
  }
  return redacted
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(
      /((?:token|secret|password|passwd|authorization|api[_-]?key)=)[^&\s]+/gi,
      "$1<redacted>",
    )
    .replace(/(?:\/Users|\/home)\/[^\s'"`()<>]+/g, "<user-path>")
    .replace(/(?:\/private)?\/var\/(?:folders|tmp)\/[^\s'"`()<>]+/g, "<temp-path>");
}

function failure(
  code: GitFailureCode,
  message: string,
  exitCode: number | null,
  stdout = "",
  stderr = "",
  outputTruncated = false,
): GitCommandFailure {
  return { ok: false, code, message, exitCode, stdout, stderr, outputTruncated };
}

function stopProcess(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      child.kill();
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may have exited between the checks.
    }
  }
}

export class GitRunner {
  private readonly cwd: string;
  private readonly executablePath: string | undefined;
  private readonly timeoutMs: number;
  private readonly outputLimitBytes: number;

  constructor(options: GitRunnerOptions) {
    this.cwd = options.cwd;
    this.executablePath = options.executablePath;
    this.timeoutMs = bounded(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    this.outputLimitBytes = bounded(
      options.outputLimitBytes,
      DEFAULT_OUTPUT_LIMIT_BYTES,
      MAX_OUTPUT_LIMIT_BYTES,
    );
  }

  run(args: readonly string[], options: GitRunOptions = {}): Promise<GitCommandResult> {
    if (!isAbsolute(this.cwd)) {
      return Promise.resolve(
        failure("git.invalid-working-directory", "Git working directory is invalid.", null),
      );
    }
    try {
      if (!statSync(this.cwd).isDirectory()) {
        return Promise.resolve(
          failure("git.invalid-working-directory", "Git working directory is invalid.", null),
        );
      }
    } catch {
      return Promise.resolve(
        failure("git.invalid-working-directory", "Git working directory is invalid.", null),
      );
    }
    if (args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
      return Promise.resolve(failure("git.invalid-arguments", "Git arguments are invalid.", null));
    }
    if (options.signal?.aborted) {
      return Promise.resolve(failure("git.cancelled", "Git command was cancelled.", null));
    }

    const executable = resolveGitExecutable(this.executablePath);
    if (executable === undefined) {
      return Promise.resolve(
        failure("git.executable-not-found", "Git executable is not available.", null),
      );
    }

    const timeoutMs = bounded(options.timeoutMs, this.timeoutMs, MAX_TIMEOUT_MS);
    const outputLimitBytes = bounded(
      options.outputLimitBytes,
      this.outputLimitBytes,
      MAX_OUTPUT_LIMIT_BYTES,
    );

    return new Promise<GitCommandResult>((resolve) => {
      const stdout = new BoundedOutput(outputLimitBytes);
      const stderr = new BoundedOutput(outputLimitBytes);
      let settled = false;
      let spawnFailed = false;
      let termination: "timed-out" | "cancelled" | undefined;
      let terminationTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let child: ReturnType<typeof spawn>;

      const finish = (result: GitCommandResult): void => {
        if (settled) return;
        settled = true;
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        if (terminationTimer !== undefined) clearTimeout(terminationTimer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };

      const terminate = (): void => {
        stopProcess(child);
        terminationTimer = setTimeout(() => {
          if (settled) return;
          try {
            if (child.pid !== undefined && process.platform !== "win32") {
              process.kill(-child.pid, "SIGKILL");
            } else {
              child.kill("SIGKILL");
            }
          } catch {
            // The process already exited.
          }
        }, TERMINATION_GRACE_MS);
        terminationTimer.unref();
      };

      const onAbort = (): void => {
        if (settled) return;
        termination = "cancelled";
        terminate();
      };

      try {
        child = spawn(executable, [...args], {
          cwd: this.cwd,
          detached: process.platform !== "win32",
          env: gitEnvironment(),
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        finish(failure("git.spawn-failed", "Git process could not be started.", null));
        return;
      }

      child.stdout?.on("data", (chunk: Buffer | string) => stdout.append(chunk));
      child.stderr?.on("data", (chunk: Buffer | string) => stderr.append(chunk));
      child.once("error", () => {
        spawnFailed = true;
      });
      child.once("close", (exitCode) => {
        const rawStdout = stdout.text();
        const rawStderr = stderr.text();
        const sanitizedStdout = redactOutput(rawStdout, this.cwd);
        const sanitizedStderr = redactOutput(rawStderr, this.cwd);
        const outputTruncated = stdout.wasTruncated || stderr.wasTruncated;

        if (termination === "timed-out") {
          finish(
            failure(
              "git.timed-out",
              "Git command timed out.",
              exitCode,
              sanitizedStdout,
              sanitizedStderr,
              outputTruncated,
            ),
          );
          return;
        }
        if (termination === "cancelled") {
          finish(
            failure(
              "git.cancelled",
              "Git command was cancelled.",
              exitCode,
              sanitizedStdout,
              sanitizedStderr,
              outputTruncated,
            ),
          );
          return;
        }
        if (spawnFailed || exitCode === null) {
          finish(
            failure(
              "git.spawn-failed",
              "Git process could not be started.",
              exitCode,
              sanitizedStdout,
              sanitizedStderr,
              outputTruncated,
            ),
          );
          return;
        }
        if (exitCode !== 0) {
          finish(
            failure(
              "git.non-zero-exit",
              "Git command failed.",
              exitCode,
              sanitizedStdout,
              sanitizedStderr,
              outputTruncated,
            ),
          );
          return;
        }
        finish({
          ok: true,
          exitCode: 0,
          stdout: sanitizedStdout,
          stderr: sanitizedStderr,
          outputTruncated,
        });
      });

      options.signal?.addEventListener("abort", onAbort, { once: true });
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        termination = "timed-out";
        terminate();
      }, timeoutMs);
      timeoutTimer.unref();

      if (options.signal?.aborted) onAbort();
    });
  }
}
