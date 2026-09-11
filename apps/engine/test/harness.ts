import { spawn } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
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

export interface FakeGitHubRequest {
  readonly method: string;
  readonly path: string;
  readonly credential: string | undefined;
}

export interface FakeGitHubPullRequest {
  readonly number: number;
  readonly htmlUrl: string;
  readonly base: string;
  readonly head: string;
  readonly draft: boolean;
}

export interface FakeGitHubIssueEvent {
  readonly id: number;
  readonly created_at: string;
  readonly event: string;
  readonly label?: { readonly name: string };
  readonly issue: { readonly number: number; readonly title: string };
  readonly actor: { readonly login: string };
  readonly [key: string]: unknown;
}

export interface FakeGitHubLabeledIssueEventInput {
  readonly owner: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly issueTitle: string;
  readonly label: string;
  readonly actor: string;
  readonly createdAt: string;
}

export interface FakeGitHubIssueEventSeed {
  readonly owner: string;
  readonly repository: string;
  readonly event: FakeGitHubIssueEvent;
}

export interface FakeGitHubRouteResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface FakeGitHubApi {
  readonly baseUrl: string;
  readonly requests: readonly FakeGitHubRequest[];
  readonly pullRequests: readonly FakeGitHubPullRequest[];
  appendLabeledIssueEvent(input: FakeGitHubLabeledIssueEventInput): FakeGitHubIssueEvent;
  seedIssueEvent(seed: FakeGitHubIssueEventSeed): FakeGitHubIssueEvent;
  /** Temporarily overrides one method/path and returns its restoration function. */
  scriptRoute(method: string, path: string, response: FakeGitHubRouteResponse): () => void;
  close(): Promise<void>;
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

/** Test-only HTTP fake for the GitHub API used by Application Harness tests. */
export async function startFakeGitHubApi(): Promise<FakeGitHubApi> {
  const requests: FakeGitHubRequest[] = [];
  const pullRequests: FakeGitHubPullRequest[] = [];
  const issueEvents: StoredFakeGitHubIssueEvent[] = [];
  const routes = new Map<string, FakeGitHubRouteResponse>();
  let nextPullRequestNumber = 1;
  let nextIssueEventId = 1;

  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    const path = request.url ?? "/";
    requests.push({ method, path, credential: presentedCredential(request.headers.authorization) });
    void handleFakeGitHubRequest(
      request,
      response,
      method,
      path,
      routes,
      pullRequests,
      issueEvents,
      () => nextPullRequestNumber++,
    ).catch(() => {
      if (!response.headersSent) writeJson(response, 500, { message: "Fake GitHub failure" });
    });
  });

  await listenServer(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Fake GitHub server did not expose a TCP address.");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  let closePromise: Promise<void> | undefined;
  const appendLabeledIssueEvent = (
    input: FakeGitHubLabeledIssueEventInput,
  ): FakeGitHubIssueEvent => {
    const event: FakeGitHubIssueEvent = {
      id: nextIssueEventId++,
      created_at: input.createdAt,
      event: "labeled",
      label: { name: input.label },
      issue: { number: input.issueNumber, title: input.issueTitle },
      actor: { login: input.actor },
    };
    issueEvents.push({ owner: input.owner, repository: input.repository, event });
    return event;
  };
  const seedIssueEvent = ({ owner, repository, event }: FakeGitHubIssueEventSeed) => {
    issueEvents.push({ owner, repository, event });
    nextIssueEventId = Math.max(nextIssueEventId, event.id + 1);
    return event;
  };

  return {
    baseUrl,
    requests,
    pullRequests,
    appendLabeledIssueEvent,
    seedIssueEvent,
    scriptRoute: (method, path, response) => {
      const key = routeKey(method, path);
      const previous = routes.get(key);
      routes.set(key, response);
      return () => {
        if (routes.get(key) !== response) return;
        if (previous === undefined) routes.delete(key);
        else routes.set(key, previous);
      };
    },
    close: () => (closePromise ??= closeServer(server)),
  };
}

async function handleFakeGitHubRequest(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  method: string,
  path: string,
  routes: Map<string, FakeGitHubRouteResponse>,
  pullRequests: FakeGitHubPullRequest[],
  issueEvents: StoredFakeGitHubIssueEvent[],
  nextPullRequestNumber: () => number,
): Promise<void> {
  const scripted = routes.get(routeKey(method, path));
  if (scripted !== undefined) {
    writeJson(response, scripted.status, scripted.body);
    return;
  }

  const url = new URL(path, `http://${request.headers.host ?? "127.0.0.1"}`);
  if (method === "GET" && url.pathname.endsWith("/pulls")) {
    const requestedHead = url.searchParams.get("head");
    const matches = pullRequests.filter(
      ({ head }) =>
        requestedHead === null || requestedHead === head || requestedHead.endsWith(`:${head}`),
    );
    writeJson(response, 200, matches.map(githubPullRequest));
    return;
  }

  if (method === "POST" && url.pathname.endsWith("/pulls")) {
    const input = await readJson(request);
    if (!isPullRequestInput(input)) {
      writeJson(response, 400, { message: "base and head are required" });
      return;
    }
    const number = nextPullRequestNumber();
    const record: FakeGitHubPullRequest = {
      number,
      htmlUrl: `${url.origin}${url.pathname.slice(0, -"/pulls".length)}/pull/${number}`,
      base: input.base,
      head: input.head,
      draft: input.draft ?? false,
    };
    pullRequests.push(record);
    writeJson(response, 201, githubPullRequest(record));
    return;
  }

  const issueEventsPath = /^\/repos\/([^/]+)\/([^/]+)\/issues\/events$/;
  const issueEventsMatch = issueEventsPath.exec(url.pathname);
  if (method === "GET" && issueEventsMatch !== null) {
    const owner = issueEventsMatch[1];
    const repository = issueEventsMatch[2];
    if (owner === undefined || repository === undefined) {
      writeJson(response, 404, { message: "Not Found" });
      return;
    }
    const page = positiveQueryInteger(url.searchParams.get("page"), 1);
    const perPage = positiveQueryInteger(url.searchParams.get("per_page"), 30);
    const start = (page - 1) * perPage;
    const matches = issueEvents
      .filter((record) => record.owner === owner && record.repository === repository)
      .sort(compareFakeGitHubIssueEvents);
    writeJson(
      response,
      200,
      matches.slice(start, start + perPage).map(({ event }) => event),
    );
    return;
  }

  if (method === "GET" && url.pathname === "/user") {
    writeJson(response, 200, { login: "FakeGitHub" });
    return;
  }

  writeJson(response, 404, { message: "Not Found" });
}

interface StoredFakeGitHubIssueEvent {
  readonly owner: string;
  readonly repository: string;
  readonly event: FakeGitHubIssueEvent;
}

function positiveQueryInteger(value: string | null, fallback: number): number {
  const parsed = value === null ? Number.NaN : Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function compareFakeGitHubIssueEvents(
  left: StoredFakeGitHubIssueEvent,
  right: StoredFakeGitHubIssueEvent,
): number {
  const byCreatedAt = Date.parse(right.event.created_at) - Date.parse(left.event.created_at);
  return Number.isNaN(byCreatedAt) || byCreatedAt === 0
    ? right.event.id - left.event.id
    : byCreatedAt;
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function presentedCredential(authorization: string | string[] | undefined): string | undefined {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : value;
}

function isPullRequestInput(
  value: unknown,
): value is { readonly base: string; readonly head: string; readonly draft?: boolean } {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input["base"] === "string" &&
    typeof input["head"] === "string" &&
    (input["draft"] === undefined || typeof input["draft"] === "boolean")
  );
}

function githubPullRequest(record: FakeGitHubPullRequest): Record<string, unknown> {
  return {
    number: record.number,
    html_url: record.htmlUrl,
    base: { ref: record.base },
    head: { ref: record.head },
    draft: record.draft,
  };
}

function readJson(request: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      try {
        resolve(body === "" ? {} : (JSON.parse(body) as unknown));
      } catch (error: unknown) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function writeJson(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function listenServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => (error === undefined ? resolve() : reject(error)));
  });
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
