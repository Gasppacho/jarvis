import { RuntimeDetector } from "../../../agent-runtime/src/detector.js";
import { runBoundedProcess } from "../../../workspace/src/bounded-process-runner.js";
import { defaultGhExecutablePaths, ghEnvironment } from "./credentials.js";

export interface GitHubAccountDiscovery {
  readonly accountLabel: string;
  readonly secretRef: string;
  readonly status: "available" | "unauthenticated";
  readonly capabilities: readonly string[];
}

export type GitHubAccountDiscoveryResult =
  | { readonly status: "available"; readonly accounts: readonly GitHubAccountDiscovery[] }
  | { readonly status: "unavailable" };

export interface GitHubAccountDiscoveryPort {
  discover(): Promise<GitHubAccountDiscoveryResult>;
}

export interface GitHubAccountDiscoveryOptions {
  readonly cwd?: string;
  readonly detector?: Pick<RuntimeDetector, "detect">;
  readonly knownExecutablePaths?: readonly string[];
  readonly allowShellProbe?: boolean;
  readonly shellPath?: string;
  readonly timeoutMs?: number;
  readonly outputLimitBytes?: number;
}

const GITHUB_CAPABILITIES = ["github.api", "scm.change-request.manage", "work-items.read"];

/** Lists locally authenticated gh accounts without asking gh to reveal any token. */
export class GitHubCliAccountDiscovery implements GitHubAccountDiscoveryPort {
  private readonly detector: Pick<RuntimeDetector, "detect">;
  private readonly cwd: string;
  private readonly timeoutMs: number | undefined;
  private readonly outputLimitBytes: number | undefined;

  public constructor(options: GitHubAccountDiscoveryOptions = {}) {
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
    this.timeoutMs = options.timeoutMs;
    this.outputLimitBytes = options.outputLimitBytes;
  }

  public async discover(): Promise<GitHubAccountDiscoveryResult> {
    const executable = await this.detector.detect("gh");
    if (executable === null) return { status: "unavailable" };

    const result = await runBoundedProcess({
      executable,
      args: ["auth", "status", "--json", "hosts"],
      cwd: this.cwd,
      env: ghEnvironment(),
      ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
      ...(this.outputLimitBytes === undefined ? {} : { outputLimitBytes: this.outputLimitBytes }),
    });
    if (result.outputTruncated) return { status: "unavailable" };

    const accounts = parseAccounts(result.stdout);
    return accounts === undefined ? { status: "unavailable" } : { status: "available", accounts };
  }
}

function parseAccounts(output: string): readonly GitHubAccountDiscovery[] | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!isRecord(payload) || !isRecord(payload["hosts"])) return undefined;
  const accounts = payload["hosts"]["github.com"];
  if (accounts === undefined) return [];
  if (!Array.isArray(accounts)) return undefined;

  const discovered = new Map<string, GitHubAccountDiscovery>();
  for (const account of accounts) {
    if (!isRecord(account) || typeof account["login"] !== "string") continue;
    const accountLabel = account["login"];
    if (!/^[A-Za-z0-9-]{1,39}$/.test(accountLabel)) continue;
    const status = account["state"] === "success" ? "available" : "unauthenticated";
    discovered.set(accountLabel, {
      accountLabel,
      secretRef: `gh://${accountLabel}`,
      status,
      capabilities: status === "available" ? GITHUB_CAPABILITIES : [],
    });
  }
  return [...discovered.values()].sort((left, right) =>
    left.accountLabel.localeCompare(right.accountLabel),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
