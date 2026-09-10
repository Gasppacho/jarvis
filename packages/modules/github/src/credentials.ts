import { RuntimeDetector } from "../../../agent-runtime/src/detector.js";
import { runBoundedProcess } from "../../../workspace/src/bounded-process-runner.js";

export type GitHubCredentialResolution =
  | { readonly status: "available"; readonly credential: string }
  | { readonly status: "unauthenticated" }
  | { readonly status: "unavailable" };

export interface GitHubCredentialResolutionPort {
  resolve(secretRef: string): Promise<GitHubCredentialResolution>;
}

export interface GitHubCredentialResolverOptions {
  readonly cwd?: string;
  readonly hostname?: string;
  readonly detector?: Pick<RuntimeDetector, "detect">;
  readonly knownExecutablePaths?: readonly string[];
  readonly allowShellProbe?: boolean;
  readonly shellPath?: string;
  readonly timeoutMs?: number;
  readonly outputLimitBytes?: number;
}

/** Resolves one GitHub account through the user's authenticated gh CLI. */
export class GitHubCliCredentialResolver implements GitHubCredentialResolutionPort {
  private readonly detector: Pick<RuntimeDetector, "detect">;
  private readonly cwd: string;
  private readonly hostname: string;
  private readonly timeoutMs: number | undefined;
  private readonly outputLimitBytes: number | undefined;

  public constructor(options: GitHubCredentialResolverOptions = {}) {
    this.detector =
      options.detector ??
      new RuntimeDetector({
        knownExecutablePaths: options.knownExecutablePaths ?? defaultGhExecutablePaths(),
        ...(options.allowShellProbe === undefined
          ? {}
          : { allowShellProbe: options.allowShellProbe }),
        ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
      });
    this.cwd = options.cwd ?? process.cwd();
    this.hostname = options.hostname ?? "github.com";
    this.timeoutMs = options.timeoutMs;
    this.outputLimitBytes = options.outputLimitBytes;
  }

  public async resolve(secretRef: string): Promise<GitHubCredentialResolution> {
    const account = accountFromSecretRef(secretRef);
    if (account === null) return { status: "unauthenticated" };

    const executable = await this.detector.detect("gh");
    if (executable === null) return { status: "unavailable" };

    const result = await runBoundedProcess({
      executable,
      args: ["auth", "token", "--hostname", this.hostname, "--user", account],
      cwd: this.cwd,
      env: ghEnvironment(),
      ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
      ...(this.outputLimitBytes === undefined ? {} : { outputLimitBytes: this.outputLimitBytes }),
    });

    if (!result.ok) {
      return result.code === "process.non-zero-exit"
        ? { status: "unauthenticated" }
        : { status: "unavailable" };
    }
    if (result.outputTruncated) return { status: "unavailable" };

    const credential = result.stdout.trim();
    return credential !== "" && !/\s/.test(credential)
      ? { status: "available", credential }
      : { status: "unavailable" };
  }
}

function accountFromSecretRef(secretRef: string): string | null {
  const account = secretRef.startsWith("gh://")
    ? secretRef.slice("gh://".length)
    : secretRef.startsWith("gh:")
      ? secretRef.slice("gh:".length)
      : secretRef;
  return /^[A-Za-z0-9-]{1,39}$/.test(account) ? account : null;
}

function ghEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "",
    ...(process.env["GH_CONFIG_DIR"] === undefined
      ? {}
      : { GH_CONFIG_DIR: process.env["GH_CONFIG_DIR"] }),
  };
}

function defaultGhExecutablePaths(): readonly string[] {
  if (process.platform === "win32") return ["C:\\Program Files\\GitHub CLI\\gh.exe"];
  return ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh", "/bin/gh"];
}
