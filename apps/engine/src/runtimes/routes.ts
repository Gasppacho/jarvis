import type { FastifyInstance } from "fastify";
import type { components } from "../api/generated/local-api.js";
import type { DatabaseState } from "../db/open.js";
import { EngineError } from "../errors.js";
import type { RuntimeDescriptor } from "../../../../packages/agent-runtime/src/index.js";

type ResourceDescriptor = components["schemas"]["ResourceDescriptor"];

export interface LocalRuntimeRegistry {
  list(): readonly RuntimeDescriptor[];
  discover(): Promise<readonly RuntimeDescriptor[]>;
}

export interface RuntimeRouteDependencies {
  readonly databaseState: () => DatabaseState;
  readonly runtimes: LocalRuntimeRegistry | undefined;
}

export function registerRuntimeRoutes(app: FastifyInstance, deps: RuntimeRouteDependencies): void {
  app.get("/v1/runtimes", async (_request, reply) => {
    const registry = requireRuntimeRegistry(deps);
    return reply.code(200).send({ items: registry.list().map(toResourceDescriptor) });
  });

  app.post("/v1/runtimes/discover", async (_request, reply) => {
    const registry = requireRuntimeRegistry(deps);
    return reply.code(200).send({ items: (await registry.discover()).map(toResourceDescriptor) });
  });
}

function requireRuntimeRegistry(deps: RuntimeRouteDependencies): LocalRuntimeRegistry {
  if (deps.databaseState() !== "ready" || deps.runtimes === undefined) {
    throw new EngineError(
      "engine.database-unavailable",
      503,
      "The local database is unavailable; runtime operations are suspended until it recovers.",
    );
  }
  return deps.runtimes;
}

function toResourceDescriptor(descriptor: RuntimeDescriptor): ResourceDescriptor {
  return {
    id: descriptor.id,
    kind: "runtime",
    displayName: descriptor.displayName,
    status: descriptor.status,
    capabilities: [...descriptor.capabilities],
  };
}
