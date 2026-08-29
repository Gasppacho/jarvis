import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const enginePath = join(repoRoot, "dist", "engine", "engine.bundle.mjs");

const READY_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 10_000;

export interface ReadyHandshake {
  readonly type: string;
  readonly port: number;
  readonly apiVersion: string;
  readonly sessionId: string;
}

/**
 * TESTING.md primary seam: the real engine binary, a real temporary SQLite file
 * and a throwaway JARVIS_DATA_ROOT, driven through the same HTTP API the macOS
 * shell uses. No HTTP mock, no SQLite mock.
 */
export interface Harness {
  readonly baseUrl: string;
  readonly token: string;
  readonly dataRoot: string;
  readonly handshake: ReadyHandshake;
  /** stdout lines the engine emitted, in order. */
  readonly stdoutLines: readonly string[];
  /** Authenticated request. */
  call(path: string, init?: RequestInit): Promise<Response>;
  /** Request without the bearer token. */
  callUnauthenticated(path: string, init?: RequestInit): Promise<Response>;
  /**
   * Raw HTTP request. `fetch` silently drops forbidden headers such as `Host`,
   * so tests that exercise them cannot go through it.
   */
  callRaw(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }>;
  /** Resolves with the engine's exit code once the process ends. */
  waitForExit(): Promise<number>;
  /** Kills the engine if still running and removes the data root. */
  dispose(): Promise<void>;
}

export interface StartEngineOptions {
  /** Extra environment for the child, e.g. to point at a poisoned data root. */
  readonly env?: Readonly<Record<string, string>>;
  /** Use a data root the test already created, instead of a fresh mkdtemp one. */
  readonly dataRoot?: string;
}

class ReadyTimeout extends Error {}

export async function startEngine(options: StartEngineOptions = {}): Promise<Harness> {
  // Only a root the harness allocated may be removed on dispose: a caller that
  // supplies one may keep other fixtures beside it. `env` is spread into the
  // child last, so a root set there wins and must count as caller-supplied too.
  const supplied = options.dataRoot ?? options.env?.["JARVIS_DATA_ROOT"];
  const suppliedRoot = supplied === undefined || supplied === "" ? undefined : supplied;
  const ownsDataRoot = suppliedRoot === undefined;
  const dataRoot = suppliedRoot ?? (await mkdtemp(join(tmpdir(), "jarvis-harness-")));
  const token = randomBytes(32).toString("base64url");

  const child = spawn(process.execPath, [enginePath], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      JARVIS_DATA_ROOT: dataRoot,
      JARVIS_API_TOKEN: token,
      ...options.env,
    },
  });

  const stdoutLines: string[] = [];
  const stderrChunks: string[] = [];
  let stdoutBuffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      stdoutLines.push(stdoutBuffer.slice(0, newline));
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      newline = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => void stderrChunks.push(chunk));

  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code: number | null, signal: string | null) =>
      resolve(code ?? (signal === null ? 1 : 128)),
    );
  });

  const handshake = await Promise.race([
    waitForHandshake(stdoutLines, exited, stderrChunks),
    rejectAfter(READY_TIMEOUT_MS, stderrChunks),
  ]).catch(async (error: unknown) => {
    child.kill("SIGKILL");
    if (ownsDataRoot) await rm(dataRoot, { recursive: true, force: true });
    throw error;
  });

  const baseUrl = `http://127.0.0.1:${handshake.port}`;

  const request = (path: string, init: RequestInit, authenticate: boolean): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (authenticate) headers.set("authorization", `Bearer ${token}`);
    return fetch(`${baseUrl}${path}`, { ...init, headers });
  };

  return {
    baseUrl,
    token,
    dataRoot,
    handshake,
    stdoutLines,
    call: (path, init = {}) => request(path, init, true),
    callRaw: (path, headers) => rawRequest(handshake.port, path, headers),
    callUnauthenticated: (path, init = {}) => request(path, init, false),
    waitForExit: () =>
      Promise.race([
        exited,
        new Promise<number>((_, reject) =>
          setTimeout(
            () => reject(new Error(`engine did not exit within ${EXIT_TIMEOUT_MS}ms`)),
            EXIT_TIMEOUT_MS,
          ).unref(),
        ),
      ]),
    dispose: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      if (ownsDataRoot) await rm(dataRoot, { recursive: true, force: true });
    },
  };
}

async function waitForHandshake(
  lines: string[],
  exited: Promise<number>,
  stderrChunks: string[],
): Promise<ReadyHandshake> {
  let died = false;
  void exited.then(() => {
    died = true;
  });

  for (;;) {
    const line = lines[0];
    if (line !== undefined) {
      const parsed: unknown = JSON.parse(line);
      if (!isReadyHandshake(parsed)) {
        throw new Error(`first stdout line is not a ready handshake: ${line}`);
      }
      return parsed;
    }
    if (died) {
      throw new Error(`engine exited before the ready handshake.\n${stderrChunks.join("")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function rejectAfter(ms: number, stderrChunks: string[]): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(
      () =>
        reject(new ReadyTimeout(`no ready handshake within ${ms}ms.\n${stderrChunks.join("")}`)),
      ms,
    ).unref(),
  );
}

function isReadyHandshake(value: unknown): value is ReadyHandshake {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate["type"] === "ready" &&
    typeof candidate["port"] === "number" &&
    typeof candidate["apiVersion"] === "string" &&
    typeof candidate["sessionId"] === "string"
  );
}

function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => void (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}
