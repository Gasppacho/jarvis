import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SystemIdGenerator, type IdGenerator } from "../../../packages/kernel/src/id-generator.js";

export const ENGINE_CLAIM_FILENAME = ".jarvis-engine.lock";
export const ENGINE_ALREADY_RUNNING_CODE = "system.engine-already-running" as const;

interface EngineClaimRecord {
  readonly version: 1;
  readonly pid: number;
  readonly sessionId: string;
  readonly claimId: string;
}

export class EngineAlreadyRunningError extends Error {
  public readonly code = ENGINE_ALREADY_RUNNING_CODE;

  public constructor(dataRoot: string, detail = "An Engine already owns this data root.") {
    super(`${detail} (${dataRoot})`);
    this.name = "EngineAlreadyRunningError";
  }
}

export interface EngineClaim {
  release(): void;
}

/**
 * Claims one canonical data root before SQLite or HTTP startup. Hard-linking a
 * fully-written temporary file makes the visible claim atomic even if a
 * process dies between creating its temporary file and publishing the claim.
 */
export function acquireEngineClaim(
  dataRoot: string,
  sessionId: string,
  ids: Pick<IdGenerator, "next"> = new SystemIdGenerator(),
): EngineClaim {
  const claimPath = join(dataRoot, ENGINE_CLAIM_FILENAME);
  const record: EngineClaimRecord = {
    version: 1,
    pid: process.pid,
    sessionId,
    claimId: ids.next(),
  };
  const contents = `${JSON.stringify(record)}\n`;

  while (true) {
    const temporaryPath = join(
      dataRoot,
      `${ENGINE_CLAIM_FILENAME}.${process.pid}.${ids.next()}.tmp`,
    );
    try {
      writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
      try {
        linkSync(temporaryPath, claimPath);
        return claimFor(claimPath, contents);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    } finally {
      unlinkIfPresent(temporaryPath);
    }

    const owner = readClaim(claimPath, dataRoot);
    if (owner === undefined) continue;
    if (isProcessAlive(owner.pid)) {
      throw new EngineAlreadyRunningError(dataRoot);
    }
    unlinkIfPresent(claimPath);
  }
}

function claimFor(claimPath: string, contents: string): EngineClaim {
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try {
        if (readFileSync(claimPath, "utf8") === contents) unlinkSync(claimPath);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") return;
      }
    },
  };
}

function readClaim(claimPath: string, dataRoot: string): EngineClaimRecord | undefined {
  let contents: string;
  try {
    contents = readFileSync(claimPath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new EngineAlreadyRunningError(
      dataRoot,
      "The existing Engine claim could not be read safely.",
    );
  }

  try {
    const value: unknown = JSON.parse(contents);
    if (!isClaimRecord(value)) throw new Error("invalid claim");
    return value;
  } catch {
    throw new EngineAlreadyRunningError(
      dataRoot,
      "The existing Engine claim could not be verified safely.",
    );
  }
}

function isClaimRecord(value: unknown): value is EngineClaimRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<EngineClaimRecord>;
  return (
    record.version === 1 &&
    typeof record.pid === "number" &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.sessionId === "string" &&
    typeof record.claimId === "string"
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}
