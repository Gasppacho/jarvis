import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import {
  runBoundedProcess,
  type BoundedProcessResult,
  type ProcessFailureCode,
} from "./bounded-process-runner.js";

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

    return runBoundedProcess({
      executable,
      args,
      cwd: this.cwd,
      env: gitEnvironment(),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs,
      outputLimitBytes,
    }).then(toGitResult);
  }
}

const GIT_FAILURE_CODES: Record<ProcessFailureCode, GitFailureCode> = {
  "process.invalid-working-directory": "git.invalid-working-directory",
  "process.invalid-arguments": "git.invalid-arguments",
  "process.spawn-failed": "git.spawn-failed",
  "process.non-zero-exit": "git.non-zero-exit",
  "process.timed-out": "git.timed-out",
  "process.cancelled": "git.cancelled",
};

const GIT_FAILURE_MESSAGES: Record<ProcessFailureCode, string> = {
  "process.invalid-working-directory": "Git working directory is invalid.",
  "process.invalid-arguments": "Git arguments are invalid.",
  "process.spawn-failed": "Git process could not be started.",
  "process.non-zero-exit": "Git command failed.",
  "process.timed-out": "Git command timed out.",
  "process.cancelled": "Git command was cancelled.",
};

function toGitResult(result: BoundedProcessResult): GitCommandResult {
  if (result.ok) return result;
  return failure(
    GIT_FAILURE_CODES[result.code],
    GIT_FAILURE_MESSAGES[result.code],
    result.exitCode,
    result.stdout,
    result.stderr,
    result.outputTruncated,
  );
}
