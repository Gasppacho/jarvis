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
  /** The engine's stderr so far, in order. Grows while the engine runs. */
  stderr(): string;
  /** Resolves once `needle` appears on the engine's stderr. */
  waitForStderr(needle: string, timeoutMs?: number): Promise<void>;
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
  /**
   * Opens `GET /v1/stream` and parses each SSE `data:` frame as JSON, in
   * arrival order. No helper for this existed before ticket #60: `callRaw`
   * buffers the whole response body until the connection ends, which never
   * happens for a stream.
   */
  openStream(path?: string): SseConnection;
}

/** One open Server-Sent Events connection opened through `Harness.openStream`. */
export interface SseConnection {
  /** Parsed `data:` payloads, in arrival order. Grows while the connection is open. */
  readonly messages: readonly unknown[];
  /** The response status once headers arrive; `undefined` before that. */
  status(): number | undefined;
  /** The response headers once they arrive; `undefined` before that. A
   * hijacked SSE reply writes its own head, so this is how a test checks the
   * head carries what every other operation's does. */
  headers(): Readonly<Record<string, string | string[] | undefined>> | undefined;
  /** Every byte received so far, before `data:` parsing — the only way to
   * observe framing that carries no event, such as the opening comment. */
  rawText(): string;
  /** Resolves once `messages.length >= count`; rejects if that never happens in time. */
  waitForCount(count: number, timeoutMs?: number): Promise<readonly unknown[]>;
  /** Resolves once the HTTP response ends or the socket closes, from either end. */
  waitForClose(timeoutMs?: number): Promise<void>;
  /** True once the connection has ended, from either end. */
  closed(): boolean;
  /** Abruptly destroys the client socket, simulating a dropped connection. */
  close(): void;
}

export interface StartEngineOptions {
  /** Extra environment for the child, e.g. to point at a poisoned data root. */
  readonly env?: Readonly<Record<string, string>>;
  /** Alternate self-contained engine bundle used by bootstrap-fixture tests. */
  readonly enginePath?: string;
  /** Use a data root the test already created, instead of a fresh mkdtemp one. */
  readonly dataRoot?: string;
}

class ReadyTimeout extends Error {}

export async function startEngine(options: StartEngineOptions = {}): Promise<Harness> {
  // Only a root the harness allocated may be removed on dispose: a caller that
  // supplies one may keep other fixtures beside it. `env` is spread into the
  // child last, so a root set there wins and must count as caller-supplied too.
  const supplied = options.env?.["JARVIS_DATA_ROOT"] ?? options.dataRoot;
  const suppliedRoot = supplied === undefined || supplied === "" ? undefined : supplied;
  const ownsDataRoot = suppliedRoot === undefined;
  const dataRoot = suppliedRoot ?? (await mkdtemp(join(tmpdir(), "jarvis-harness-")));
  const token = randomBytes(32).toString("base64url");

  const child = spawn(process.execPath, [options.enginePath ?? enginePath], {
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
    stderr: () => stderrChunks.join(""),
    waitForStderr: (needle: string, timeoutMs = 5_000) =>
      new Promise<void>((resolve, reject) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
          if (stderrChunks.join("").includes(needle)) {
            clearInterval(timer);
            resolve();
            return;
          }
          if (Date.now() - startedAt > timeoutMs) {
            clearInterval(timer);
            reject(
              new Error(
                `engine stderr did not contain "${needle}" within ${timeoutMs}ms.\n${stderrChunks.join("")}`,
              ),
            );
          }
        }, 25);
      }),
    call: (path, init = {}) => request(path, init, true),
    callRaw: (path, headers) => rawRequest(handshake.port, path, headers),
    callUnauthenticated: (path, init = {}) => request(path, init, false),
    openStream: (path = "/v1/stream") => openSseConnection(handshake.port, path, token),
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

/** ticket #60: `rawRequest` above buffers the whole body until the response
 * ends, which a Server-Sent Events response never does on its own — so this
 * parses `data:` frames incrementally off the raw socket instead. */
function openSseConnection(port: number, path: string, token: string): SseConnection {
  const messages: unknown[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  const closeWaiters: (() => void)[] = [];
  let status: number | undefined;
  let headers: Readonly<Record<string, string | string[] | undefined>> | undefined;
  let closed = false;
  let buffer = "";
  let raw = "";

  const settleClose = (): void => {
    if (closed) return;
    closed = true;
    for (const resolve of closeWaiters.splice(0)) resolve();
  };

  const req = httpRequest(
    {
      host: "127.0.0.1",
      port,
      path,
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    },
    (res) => {
      status = res.statusCode;
      headers = res.headers;
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        raw += chunk;
        buffer += chunk;
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
          if (dataLine !== undefined) {
            messages.push(JSON.parse(dataLine.slice("data:".length).trim()));
            for (const waiter of waiters.splice(0)) {
              if (messages.length >= waiter.count) waiter.resolve();
              else waiters.push(waiter);
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      });
      res.on("end", settleClose);
      res.on("close", settleClose);
    },
  );
  req.on("error", settleClose);
  req.end();

  return {
    messages,
    status: () => status,
    headers: () => headers,
    rawText: () => raw,
    closed: () => closed,
    waitForCount: (count, timeoutMs = 5_000) =>
      new Promise<readonly unknown[]>((resolve, reject) => {
        if (messages.length >= count) {
          resolve(messages);
          return;
        }
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === onReady);
          if (index >= 0) waiters.splice(index, 1);
          reject(
            new Error(
              `SSE stream ${path} did not reach ${count} message(s) within ${timeoutMs}ms ` +
                `(saw ${messages.length}).`,
            ),
          );
        }, timeoutMs);
        timer.unref();
        function onReady(): void {
          clearTimeout(timer);
          resolve(messages);
        }
        waiters.push({ count, resolve: onReady });
      }),
    waitForClose: (timeoutMs = 5_000) =>
      new Promise<void>((resolve, reject) => {
        if (closed) {
          resolve();
          return;
        }
        const timer = setTimeout(
          () => reject(new Error(`SSE stream ${path} did not close within ${timeoutMs}ms.`)),
          timeoutMs,
        );
        timer.unref();
        closeWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
    close: () => req.destroy(),
  };
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
