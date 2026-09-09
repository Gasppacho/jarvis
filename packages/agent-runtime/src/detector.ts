import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";

export interface RuntimeDetectorOptions {
  readonly knownExecutablePaths: readonly string[];
  readonly allowShellProbe?: boolean;
  readonly shellPath?: string;
  readonly shellEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly outputLimitBytes?: number;
}

const COMMAND_NAME = /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/;
const SHELL_PROBE = 'command -v -- "$1"';
const SHELL_ARG0 = "jarvis-runtime-detector";
const DEFAULT_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 4_096;
const MAX_OUTPUT_LIMIT_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 100;

export class RuntimeDetector {
  private readonly knownExecutablePaths: readonly string[];
  private readonly allowShellProbe: boolean;
  private readonly shellPath: string;
  private readonly shellEnvironment: Readonly<Record<string, string | undefined>> | undefined;
  private readonly timeoutMs: number;
  private readonly outputLimitBytes: number;

  public constructor(options: RuntimeDetectorOptions) {
    this.knownExecutablePaths = [...options.knownExecutablePaths];
    this.allowShellProbe = options.allowShellProbe ?? true;
    this.shellPath = options.shellPath ?? defaultShellPath();
    this.shellEnvironment = options.shellEnvironment;
    this.timeoutMs = bounded(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    this.outputLimitBytes = bounded(
      options.outputLimitBytes,
      DEFAULT_OUTPUT_LIMIT_BYTES,
      MAX_OUTPUT_LIMIT_BYTES,
    );
  }

  public async detect(commandName: string): Promise<string | null> {
    validateCommandName(commandName);

    for (const candidate of this.knownExecutablePaths) {
      if (await isExecutableFile(candidate)) return candidate;
    }

    if (!this.allowShellProbe || !(await isExecutableFile(this.shellPath))) return null;
    return this.probeShell(commandName);
  }

  private probeShell(commandName: string): Promise<string | null> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(this.shellPath, ["-ilc", SHELL_PROBE, SHELL_ARG0, commandName], {
          ...(this.shellEnvironment === undefined ? {} : { env: { ...this.shellEnvironment } }),
          detached: process.platform !== "win32",
          shell: false,
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
      } catch {
        resolve(null);
        return;
      }

      const chunks: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let terminationStarted = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
      const timeoutTimer = setTimeout(() => terminate(), this.timeoutMs);
      timeoutTimer.unref();

      const finish = (result: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
        resolve(terminationStarted ? null : result);
      };

      const terminate = (): void => {
        if (settled || terminationStarted) return;
        terminationStarted = true;
        signalChild(child, "SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (!settled) signalChild(child, "SIGKILL");
        }, TERMINATION_GRACE_MS);
        forceKillTimer.unref();
      };

      child.stdout?.on("data", (chunk: Buffer | string) => {
        if (settled || terminationStarted) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (outputBytes + bytes.byteLength > this.outputLimitBytes) {
          terminate();
          return;
        }
        chunks.push(bytes);
        outputBytes += bytes.byteLength;
      });
      child.once("error", () => finish(null));
      child.once("close", (exitCode) => {
        if (exitCode !== 0 || terminationStarted) {
          finish(null);
          return;
        }

        const output = Buffer.concat(chunks).toString("utf8");
        const candidate = parseExecutablePath(output);
        if (candidate === null) {
          finish(null);
          return;
        }
        void isExecutableFile(candidate).then((valid) => finish(valid ? candidate : null));
      });
    });
  }
}

async function isExecutableFile(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  try {
    const file = await stat(path);
    if (!file.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function validateCommandName(commandName: string): void {
  if (!COMMAND_NAME.test(commandName)) {
    throw new TypeError("Runtime command name must be a single safe executable name.");
  }
}

function parseExecutablePath(output: string): string | null {
  let path = output;
  if (path.endsWith("\n")) path = path.slice(0, -1);
  if (path.endsWith("\r")) path = path.slice(0, -1);
  if (path === "" || path.includes("\n") || path.includes("\r") || !isAbsolute(path)) return null;
  return path;
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The probe may have exited between the two signals.
    }
  }
}

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function defaultShellPath(): string {
  if (process.platform === "win32") return process.env["ComSpec"] ?? "";
  return process.env["SHELL"] ?? "/bin/sh";
}
