import type { FastifyInstance } from "fastify";
import type { components } from "../api/generated/local-api.js";
import type { DatabaseState } from "../db/open.js";
import { EngineError } from "../errors.js";
import type { ConnectionDescriptor, ConnectionRegistry } from "./registry.js";
import type { GitHubProviderCheckPort } from "../../../../packages/modules/github/src/provider-check.js";
import type {
  GitHubAccountDiscovery,
  GitHubAccountDiscoveryPort,
} from "../../../../packages/modules/github/src/account-discovery.js";

type ResourceDescriptor = components["schemas"]["ResourceDescriptor"];

const GITHUB_CAPABILITIES = ["github.api", "scm.change-request.manage", "work-items.read"] as const;
const GITHUB_ACCOUNT_REFERENCE = /^gh:\/\/[A-Za-z0-9-]{1,39}$/;

export interface ConnectionRouteDependencies {
  readonly databaseState: () => DatabaseState;
  readonly connections: ConnectionRegistry | undefined;
  readonly validator: GitHubProviderCheckPort | undefined;
  readonly discovery: GitHubAccountDiscoveryPort | undefined;
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

  app.post("/v1/connections/discover", async (_request, reply) => {
    const registry = requireConnectionRegistry(deps);
    if (deps.discovery === undefined) throw discoveryUnavailable();
    const result = await deps.discovery.discover();
    if (result.status === "unavailable") throw discoveryUnavailable();

    const descriptors = result.accounts.map((account) =>
      upsertDiscoveredConnection(registry, account),
    );
    const observedReferences = new Set(result.accounts.map((account) => account.secretRef));
    for (const descriptor of registry.list()) {
      if (descriptor.provider !== "github" || observedReferences.has(descriptor.secretRef))
        continue;
      registry.upsert({ ...descriptor, status: "unauthenticated", capabilities: [] });
    }
    return reply.code(200).send({ items: descriptors.map(toResourceDescriptor) });
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

function discoveryUnavailable(): EngineError {
  return new EngineError(
    "connection.discovery-unavailable",
    503,
    "GitHub account discovery is unavailable. Check that gh is installed, then retry.",
  );
}

function upsertDiscoveredConnection(
  registry: ConnectionRegistry,
  account: GitHubAccountDiscovery,
): ConnectionDescriptor {
  const descriptor: ConnectionDescriptor = {
    id: `connection/github-${account.accountLabel}`,
    provider: "github",
    accountLabel: account.accountLabel,
    status: account.status,
    capabilities: [...account.capabilities],
    secretRef: account.secretRef,
  };
  registry.upsert(descriptor);
  return descriptor;
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
  if (!GITHUB_ACCOUNT_REFERENCE.test(secretRef)) {
    throw new EngineError(
      "connection.secret-ref-invalid",
      400,
      "GitHub connection secretRef must be an opaque gh:// account reference.",
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

function toResourceDescriptor(descriptor: ConnectionDescriptor): ResourceDescriptor {
  return {
    id: descriptor.id,
    kind: descriptor.provider,
    displayName: descriptor.accountLabel,
    status: descriptor.status,
    capabilities: [...descriptor.capabilities],
  };
}
