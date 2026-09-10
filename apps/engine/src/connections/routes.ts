import type { FastifyInstance } from "fastify";
import type { components } from "../api/generated/local-api.js";
import type { DatabaseState } from "../db/open.js";
import { EngineError } from "../errors.js";
import type { ConnectionDescriptor, ConnectionRegistry } from "./registry.js";
import type { GitHubProviderCheckPort } from "../../../../packages/modules/github/src/provider-check.js";

type ResourceDescriptor = components["schemas"]["ResourceDescriptor"];

const GITHUB_CAPABILITIES = ["github.api", "scm.change-request.manage", "work-items.read"] as const;

export interface ConnectionRouteDependencies {
  readonly databaseState: () => DatabaseState;
  readonly connections: ConnectionRegistry | undefined;
  readonly validator: GitHubProviderCheckPort | undefined;
}

export function registerConnectionRoutes(
  app: FastifyInstance,
  deps: ConnectionRouteDependencies,
): void {
  app.get("/v1/connections", async (_request, reply) => {
    const registry = requireConnectionRegistry(deps);
    return reply.code(200).send({ items: registry.list().map(toResourceDescriptor) });
  });

  app.post("/v1/connections", async (request, reply) => {
    const registry = requireConnectionRegistry(deps);
    const body = requireConnectionRegistration(request.body);
    const descriptor = registry.register({
      id: body.id,
      provider: body.kind,
      accountLabel: body.displayName,
      capabilities: [...GITHUB_CAPABILITIES],
      secretRef: body.secretRef,
    });
    return reply.code(201).send(toResourceDescriptor(descriptor));
  });

  app.post("/v1/connections/:connectionId/validate", async (request, reply) => {
    const registry = requireConnectionRegistry(deps);
    const connectionId = (request.params as { connectionId?: unknown } | undefined)?.connectionId;
    if (typeof connectionId !== "string" || connectionId === "") {
      throw connectionNotFound(String(connectionId ?? ""));
    }
    const descriptor = registry.find(connectionId);
    if (descriptor === undefined) throw connectionNotFound(connectionId);
    if (descriptor.provider !== "github") {
      throw new EngineError(
        "connection.provider-unsupported",
        400,
        `Connection provider ${descriptor.provider} is not supported by this engine.`,
      );
    }
    if (deps.validator === undefined) {
      throw new EngineError(
        "system.internal-error",
        500,
        "The GitHub connection validator is unavailable.",
      );
    }

    const result = await deps.validator.check(descriptor.secretRef);
    const refreshed: ConnectionDescriptor = {
      ...descriptor,
      status: result.status,
      capabilities: result.status === "available" ? [...result.capabilities] : [],
      ...(result.status === "available" ? { accountLabel: result.accountLabel } : {}),
    };
    registry.upsert(refreshed);
    return reply.code(200).send(toResourceDescriptor(refreshed));
  });
}

function connectionNotFound(connectionId: string): EngineError {
  return new EngineError(
    "connection.not-found",
    404,
    `Connection ${connectionId || "(empty)"} is not registered.`,
  );
}

function requireConnectionRegistry(deps: ConnectionRouteDependencies): ConnectionRegistry {
  if (deps.databaseState() !== "ready" || deps.connections === undefined) {
    throw new EngineError(
      "engine.database-unavailable",
      503,
      "The local database is unavailable; connection operations are suspended until it recovers.",
    );
  }
  return deps.connections;
}

function requireConnectionRegistration(value: unknown): {
  id: string;
  kind: "github";
  displayName: string;
  secretRef: string;
} {
  if (!isRecord(value)) {
    throw new EngineError("api.invalid-request", 400, "Connection registration must be an object.");
  }

  const allowed = new Set(["id", "kind", "displayName", "secretRef", "configuration"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new EngineError(
      "api.invalid-request",
      400,
      `Connection registration contains unknown property ${unknown}.`,
    );
  }

  const id = nonEmptyString(value["id"], "id");
  const kind = nonEmptyString(value["kind"], "kind");
  const displayName = nonEmptyString(value["displayName"], "displayName");
  const secretRef = nonEmptyString(value["secretRef"], "secretRef");
  if (value["configuration"] !== undefined && !isRecord(value["configuration"])) {
    throw new EngineError(
      "api.invalid-request",
      400,
      "Connection configuration must be an object.",
    );
  }

  if (kind !== "github") {
    throw new EngineError(
      "connection.provider-unsupported",
      400,
      `Connection provider ${kind} is not supported by this engine.`,
    );
  }
  if (looksLikeCredential(secretRef)) {
    throw new EngineError(
      "connection.secret-ref-invalid",
      400,
      "Connection secretRef must be an opaque credential reference, not a credential value.",
    );
  }

  return { id, kind, displayName, secretRef };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EngineError(
      "api.invalid-request",
      400,
      `Connection ${field} must be a non-empty string.`,
    );
  }
  return value;
}

function looksLikeCredential(value: string): boolean {
  return /^(?:gh[pousr]_|github_pat_)/.test(value);
}

function toResourceDescriptor(descriptor: ConnectionDescriptor): ResourceDescriptor {
  return {
    id: descriptor.id,
    kind: descriptor.provider,
    displayName: descriptor.accountLabel,
    status: descriptor.status,
    capabilities: [...descriptor.capabilities],
  };
}
