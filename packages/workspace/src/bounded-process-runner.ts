import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { statSync } from "node:fs";

export type ProcessFailureCode =
  | "process.invalid-working-directory"
  | "process.invalid-arguments"
  | "process.spawn-failed"
  | "process.non-zero-exit"
  | "process.timed-out"
  | "process.cancelled";

export interface ProcessSuccess {
  readonly ok: true;
  readonly exitCode: 0;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
}

export interface ProcessFailure {
  readonly ok: false;
  readonly code: ProcessFailureCode;
  readonly message: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
}

export type BoundedProcessResult = ProcessSuccess | ProcessFailure;

export interface BoundedProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
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
  code: ProcessFailureCode,
  message: string,
  exitCode: number | null,
  stdout = "",
  stderr = "",
  outputTruncated = false,
): ProcessFailure {
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

export function runBoundedProcess(request: BoundedProcessRequest): Promise<BoundedProcessResult> {
  if (!isAbsolute(request.cwd)) {
    return Promise.resolve(
      failure("process.invalid-working-directory", "Process working directory is invalid.", null),
    );
  }
  try {
    if (!statSync(request.cwd).isDirectory()) {
      return Promise.resolve(
        failure("process.invalid-working-directory", "Process working directory is invalid.", null),
      );
    }
  } catch {
    return Promise.resolve(
      failure("process.invalid-working-directory", "Process working directory is invalid.", null),
    );
  }
  if (
    request.executable.length === 0 ||
    request.executable.includes("\0") ||
    request.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  ) {
    return Promise.resolve(
      failure("process.invalid-arguments", "Process arguments are invalid.", null),
    );
  }
  if (request.signal?.aborted) {
    return Promise.resolve(failure("process.cancelled", "Process command was cancelled.", null));
  }

  const timeoutMs = bounded(request.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const outputLimitBytes = bounded(
    request.outputLimitBytes,
    DEFAULT_OUTPUT_LIMIT_BYTES,
    MAX_OUTPUT_LIMIT_BYTES,
  );

  return new Promise<BoundedProcessResult>((resolve) => {
    const stdout = new BoundedOutput(outputLimitBytes);
    const stderr = new BoundedOutput(outputLimitBytes);
    let settled = false;
    let spawnFailed = false;
    let termination: "timed-out" | "cancelled" | undefined;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn>;

    const finish = (result: BoundedProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      request.signal?.removeEventListener("abort", onAbort);
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
      child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        detached: process.platform !== "win32",
        env: request.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      finish(failure("process.spawn-failed", "Process could not be started.", null));
      return;
    }

    child.stdout?.on("data", (chunk: Buffer | string) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.append(chunk));
    child.once("error", () => {
      spawnFailed = true;
    });
    child.once("close", (exitCode) => {
      const sanitizedStdout = redactOutput(stdout.text(), request.cwd);
      const sanitizedStderr = redactOutput(stderr.text(), request.cwd);
      const outputTruncated = stdout.wasTruncated || stderr.wasTruncated;

      if (termination === "timed-out") {
        finish(
          failure(
            "process.timed-out",
            "Process command timed out.",
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
            "process.cancelled",
            "Process command was cancelled.",
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
            "process.spawn-failed",
            "Process could not be started.",
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
            "process.non-zero-exit",
            "Process command failed.",
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

    request.signal?.addEventListener("abort", onAbort, { once: true });
    timeoutTimer = setTimeout(() => {
      if (settled) return;
      termination = "timed-out";
      terminate();
    }, timeoutMs);
    timeoutTimer.unref();

    if (request.signal?.aborted) onAbort();
  });
}
