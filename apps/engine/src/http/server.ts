import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { JarvisError } from "../errors.ts";
import type { ProjectService } from "../projects/service.ts";
import type { components } from "../api/generated/local-api.ts";
import { errorResponse } from "./errors.ts";

export type HealthResponse = components["schemas"]["HealthResponse"];

/**
 * Any other Host header means the request was routed here from outside
 * loopback (DNS rebinding, a proxy), so it is refused before authentication.
 */
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface ServerDependencies {
  readonly token: string;
  readonly health: () => HealthResponse;
  /**
   * Absent when the database failed to open. The engine still serves a
   * degraded health document rather than dying (docs/product/MVP_SPEC.md
   * user story 3), so project routes answer 503 instead of 404.
   */
  readonly projects: ProjectService | null;
  /** Invoked once the 202 has actually been flushed to the shell. */
  readonly onShutdownRequested: () => void;
  readonly logLevel?: string;
}

function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (hostHeader === undefined) return undefined;
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    return end === -1 ? undefined : hostHeader.slice(0, end + 1);
  }
  return hostHeader.split(":")[0];
}

function tokenMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  // Length is not secret; the value is compared in constant time.
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerOf(authorization: string | undefined): string | undefined {
  if (authorization === undefined) return undefined;
  const [scheme, ...rest] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || rest.length !== 1) return undefined;
  return rest[0];
}

function requireProjects(deps: ServerDependencies): ProjectService {
  if (deps.projects === null) {
    throw JarvisError.unavailable(
      "engine.database-unavailable",
      "Jarvis cannot read its local database, so projects are unavailable. Check the health screen for details.",
    );
  }
  return deps.projects;
}

export function createServer(deps: ServerDependencies): FastifyInstance {
  const app = Fastify({
    // stdout carries exactly one line, the ready handshake. Logs go to stderr.
    // Per-request logging is emitted at `info`, so the default `warn` level is
    // already quiet; lowering JARVIS_LOG_LEVEL deliberately turns it back on.
    logger: { level: deps.logLevel ?? "warn", stream: process.stderr },
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !ALLOWED_HOSTS.has(hostnameOf(request.headers.host)?.toLowerCase() ?? "")
    ) {
      return reply
        .code(403)
        .send(
          errorResponse(
            "api.host-not-allowed",
            "The Jarvis engine only answers requests addressed to loopback.",
          ),
        );
    }

    const presented = bearerOf(request.headers.authorization);
    if (presented === undefined || !tokenMatches(deps.token, presented)) {
      return reply
        .code(401)
        .header("www-authenticate", "Bearer")
        .send(
          errorResponse(
            "api.unauthorized",
            "A valid Engine Session bearer token is required.",
          ),
        );
    }
    return undefined;
  });

  app.get("/v1/health", async () => deps.health());

  app.post("/v1/discovery/repository", async (request) => {
    const body = (request.body ?? {}) as { path?: unknown };
    return requireProjects(deps).discover(body.path);
  });

  app.post("/v1/projects", async (request, reply) => {
    const body = (request.body ?? {}) as {
      repositoryPath?: unknown;
      portableConfig?: unknown;
    };
    const detail = requireProjects(deps).import({
      repositoryPath: body.repositoryPath,
      ...(body.portableConfig === undefined
        ? {}
        : { portableConfig: body.portableConfig }),
    });
    return reply.code(201).send(detail);
  });

  app.get("/v1/projects", async () => ({
    items: requireProjects(deps).list(),
  }));

  app.get("/v1/projects/:projectId", async (request) => {
    const { projectId } = request.params as { projectId: string };
    return requireProjects(deps).get(projectId);
  });

  app.post("/v1/system/shutdown", (_request, reply) => {
    // "finish" means the 202 flushed; "close" also covers a client that
    // aborted the connection. Either way the shutdown must proceed exactly once.
    let started = false;
    const begin = (): void => {
      if (started) return;
      started = true;
      setImmediate(deps.onShutdownRequested);
    };
    reply.raw.once("finish", begin);
    reply.raw.once("close", begin);
    return reply.code(202).send();
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send(
        errorResponse(
          "api.not-found",
          `No Local API operation for ${request.method} ${request.url}.`,
        ),
      ),
  );

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    // A typed domain failure is expected traffic: it carries a stable code and
    // a message written to be shown to the user.
    if (error instanceof JarvisError) {
      return reply
        .code(error.statusCode)
        .send(errorResponse(error.code, error.message));
    }
    app.log.error({ err: error }, "unhandled Local API error");
    return reply
      .code(error.statusCode ?? 500)
      .send(
        errorResponse(
          "api.internal-error",
          "The engine failed to handle this request.",
        ),
      );
  });

  return app;
}
