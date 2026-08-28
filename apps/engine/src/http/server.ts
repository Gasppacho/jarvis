import { randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { components } from "../api/generated/local-api.js";
import type { EngineConfig } from "../config.js";
import type { DatabaseState } from "../db/open.js";
import { EngineError, toErrorEnvelope } from "../errors.js";
import { API_VERSION, ENGINE_VERSION } from "../version.js";

type HealthResponse = components["schemas"]["HealthResponse"];

export interface ServerDependencies {
  readonly config: EngineConfig;
  readonly databaseState: () => DatabaseState;
  readonly isShuttingDown: () => boolean;
  /** Invoked after the 202 has been flushed to the caller. */
  readonly onShutdownRequested: () => void;
}

const CORRELATION_HEADER = "x-jarvis-correlation-id";

export function buildServer(deps: ServerDependencies): FastifyInstance {
  const app = Fastify({
    // stdout carries the ready handshake and nothing else, so logs go to stderr.
    logger: { level: process.env["JARVIS_LOG_LEVEL"] ?? "info", stream: process.stderr },
    // The shell is the only client and it is generated from the OpenAPI contract.
    bodyLimit: 1_048_576,
  });

  app.decorateRequest("correlationId", "");

  // `shutdownEngine` declares no requestBody, but a generated client may still
  // set `Content-Type: application/json` on a POST. Fastify's default parser
  // rejects the resulting empty body with 400, which would leave the engine
  // running after the shell asked it to quit (SYSTEM.md shutdown protocol).
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    if (typeof body !== "string" || body.trim() === "") {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch {
      done(
        new EngineError("api.invalid-request", 400, "Request body is not valid JSON."),
        undefined,
      );
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    const correlationId = readCorrelationId(request.headers[CORRELATION_HEADER]);
    request.correlationId = correlationId;
    reply.header(CORRELATION_HEADER, correlationId);

    assertLoopbackHost(request.headers.host);
    assertAuthorized(request.headers.authorization, deps.config.apiToken);
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    const engineError = error instanceof EngineError ? error : toEngineError(error);
    if (engineError.statusCode >= 500) {
      // The detail stays in the operator's log rather than the API response.
      app.log.error({ err: error, correlationId: request.correlationId }, "unhandled engine error");
    }
    void reply
      .code(engineError.statusCode)
      .send(toErrorEnvelope(engineError, request.correlationId));
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .send(
        toErrorEnvelope(
          new EngineError("api.invalid-request", 404, "No such operation."),
          request.correlationId,
        ),
      );
  });

  app.get("/v1/health", async (): Promise<HealthResponse> => {
    const database = deps.databaseState();
    return {
      status: deps.isShuttingDown() ? "shutting-down" : database === "ready" ? "ready" : "degraded",
      engineVersion: ENGINE_VERSION,
      apiVersion: API_VERSION,
      database,
    };
  });

  app.post("/v1/system/shutdown", async (_request, reply) => {
    // SYSTEM.md: acknowledge first, drain afterwards.
    void reply.code(202).send();
    await reply;
    deps.onShutdownRequested();
  });

  return app;
}

function toEngineError(error: unknown): EngineError {
  const { statusCode, message } = (error ?? {}) as { statusCode?: number; message?: string };
  const status = typeof statusCode === "number" ? statusCode : 500;

  // A client mistake is safe to describe: Fastify's own validation text is the
  // most useful thing the shell can show.
  if (status < 500) {
    return new EngineError("api.invalid-request", status, message ?? "Invalid request.");
  }

  // An internal failure is neither the caller's fault nor safe to echo: driver
  // messages carry absolute paths. ERROR_CODES_V1.md keeps the two apart so the
  // shell does not treat a transient outage as a permanent client error.
  return new EngineError(
    "system.internal-error",
    status,
    "The engine failed to handle the request.",
  );
}

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

function readCorrelationId(header: string | string[] | undefined): string {
  // Caller-supplied, and it ends up in a response header and an error envelope.
  // Anything outside this alphabet is replaced rather than echoed back.
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined && CORRELATION_ID_PATTERN.test(value) ? value : randomUUID();
}

function assertLoopbackHost(host: string | undefined): void {
  if (host === undefined || !isLoopbackHost(host)) {
    throw new EngineError(
      "api.host-not-allowed",
      403,
      "The engine only answers requests addressed to the loopback interface.",
    );
  }
}

function isLoopbackHost(host: string): boolean {
  // Strip the port; IPv6 literals arrive bracketed as `[::1]:43127`.
  const hostname = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : (host.split(":")[0] ?? "");
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function assertAuthorized(header: string | undefined, expectedToken: string): void {
  const unauthorized = new EngineError(
    "api.unauthorized",
    401,
    "Missing or invalid session bearer token.",
  );
  if (header === undefined || !header.startsWith("Bearer ")) throw unauthorized;

  const presented = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  // Compare in constant time, and only on equal lengths: timingSafeEqual throws otherwise.
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    throw unauthorized;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
  }
}
