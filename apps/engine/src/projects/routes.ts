import type { FastifyInstance } from "fastify";
import type { DatabaseState } from "../db/open.js";
import { EngineError } from "../errors.js";
import { discoverRepository, RepositoryPathError } from "./discovery.js";
import type { ProjectService } from "./service.js";

/**
 * The Project Registry's HTTP surface: discovery plus import/list/detail.
 * Discovery inspects the filesystem only, so it keeps working while the engine
 * runs degraded; the project routes need the database and answer
 * 503 `engine.database-unavailable` while it does not.
 */

export interface ProjectRouteDependencies {
  readonly databaseState: () => DatabaseState;
  /** `undefined` while the engine runs without a database (degraded). */
  readonly projects: ProjectService | undefined;
}

export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDependencies): void {
  app.post("/v1/discovery/repository", async (request, reply) => {
    const body = request.body as { path?: unknown } | undefined;
    try {
      return reply.code(200).send(discoverRepository(body?.path));
    } catch (error) {
      throw discoveryError(error);
    }
  });

  app.post("/v1/projects", async (request, reply) => {
    const service = requireDatabaseReady(deps);
    const body = request.body as { repositoryPath?: unknown; portableConfig?: unknown } | undefined;
    const detail = service.importProject({
      repositoryPath: body?.repositoryPath,
      portableConfig: body?.portableConfig,
    });
    return reply.code(201).send(detail);
  });

  app.get("/v1/projects", async (request, reply) => {
    const service = requireDatabaseReady(deps);
    return reply.code(200).send({ items: service.listProjects() });
  });

  app.get("/v1/projects/:projectId", async (request, reply) => {
    const service = requireDatabaseReady(deps);
    const params = request.params as { projectId?: unknown } | undefined;
    const detail = service.getProject(params?.projectId);
    return reply.code(200).send(detail);
  });
}

/** The live probe, so a database handle that fails mid-session degrades too. */
function requireDatabaseReady(deps: ProjectRouteDependencies): ProjectService {
  if (deps.databaseState() !== "ready") {
    throw new EngineError(
      "engine.database-unavailable",
      503,
      "The local database is unavailable; project operations are suspended until it recovers.",
    );
  }
  const service = deps.projects;
  if (service === undefined) {
    throw new EngineError(
      "engine.database-unavailable",
      503,
      "The local database is unavailable; project operations are suspended until it recovers.",
    );
  }
  return service;
}

function discoveryError(error: unknown): EngineError {
  if (error instanceof RepositoryPathError) {
    return new EngineError("repository.path-invalid", 400, error.message);
  }
  if (error instanceof EngineError) return error;
  return new EngineError("system.internal-error", 500, "The repository could not be inspected.");
}
