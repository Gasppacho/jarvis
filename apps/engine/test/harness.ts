import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ENGINE_BUNDLE = join(REPO_ROOT, "dist/engine/engine.bundle.mjs");
const BUNDLED_NODE = join(REPO_ROOT, "dist/engine/node");

export interface ReadyMessage {
  type: string;
  port: number;
  apiVersion: string;
  sessionId: string;
}

export interface RawResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface EngineHandle {
  readonly baseUrl: string;
  readonly token: string;
  readonly dataRoot: string;
  readonly ready: ReadyMessage;
  readonly stdoutLines: readonly string[];
  readonly stderr: string;
  /** Authenticated JSON call, the way the macOS shell talks to the engine. */
  call(path: string, init?: RequestInit): Promise<Response>;
  /** Escape hatch for tests that must forge headers `fetch` refuses to set. */
  raw(
    path: string,
    headers: Record<string, string>,
    method?: string,
  ): Promise<RawResponse>;
  /** Simulates the supervising shell dying: the engine sees stdin EOF. */
  closeStdin(): void;
  /** Resolves with the engine's exit code once the process is gone. */
  waitForExit(): Promise<number | null>;
  stop(): Promise<void>;
}

export interface StartEngineOptions {
  /** Reuse a data root to prove durability across restarts. */
  dataRoot?: string;
  token?: string;
  sessionId?: string;
}

/**
 * Starts the real engine bundle the macOS app ships, over real loopback HTTP
 * with a real SQLite file. No HTTP mock, no SQLite mock: this is the primary
 * seam described in docs/architecture/TESTING.md.
 */
export async function startEngine(
  options: StartEngineOptions = {},
): Promise<EngineHandle> {
  const ownsDataRoot = options.dataRoot === undefined;
  const dataRoot =
    options.dataRoot ?? (await mkdtemp(join(tmpdir(), "jarvis-harness-")));
  const token = options.token ?? randomBytes(32).toString("base64url");
  const sessionId = options.sessionId ?? randomUUID();

  const child: ChildProcessWithoutNullStreams = spawn(
    BUNDLED_NODE,
    [ENGINE_BUNDLE],
    {
      stdio: ["pipe", "pipe", "pipe"],
      // A clean environment proves the engine depends on nothing ambient.
      env: {
        PATH: process.env.PATH ?? "",
        JARVIS_TOKEN: token,
        JARVIS_SESSION_ID: sessionId,
        JARVIS_DATA_ROOT: dataRoot,
      },
    },
  );

  const stdoutLines: string[] = [];
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exit = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });

  const readyLine = await new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      stdoutLines.push(line);
      if (stdoutLines.length === 1) resolve(line);
    });
    exit.then((code) => {
      reject(
        new Error(
          `engine exited with ${code} before announcing ready\n${stderr}`,
        ),
      );
    }, reject);
  });

  const ready = JSON.parse(readyLine) as ReadyMessage;
  const baseUrl = `http://127.0.0.1:${ready.port}`;

  const handle: EngineHandle = {
    baseUrl,
    token,
    dataRoot,
    ready,
    get stdoutLines() {
      return stdoutLines;
    },
    get stderr() {
      return stderr;
    },
    call(path, init = {}) {
      const headers = new Headers(init.headers);
      if (!headers.has("authorization"))
        headers.set("authorization", `Bearer ${token}`);
      return fetch(new URL(path, baseUrl), { ...init, headers });
    },
    raw(path, headers, method = "GET") {
      return new Promise<RawResponse>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: ready.port,
            path,
            method,
            headers,
            setHost: false,
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              body += chunk;
            });
            res.on("end", () =>
              resolve({
                statusCode: res.statusCode ?? 0,
                headers: res.headers,
                body,
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
    },
    closeStdin() {
      child.stdin.end();
    },
    waitForExit: () => exit,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exit;
      }
      if (ownsDataRoot) await rm(dataRoot, { recursive: true, force: true });
    },
  };

  return handle;
}
