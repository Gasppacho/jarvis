import type { FastifyInstance } from "fastify";
import type { DatabaseState } from "../db/open.js";
import { EngineError } from "../errors.js";
import type {
  ProjectRegistry,
  RepositoryDiscoveryPort,
} from "../../../../packages/kernel/src/project-registry.js";
import type {
  ProjectBindings,
  ProjectCompositionChoices,
  ProjectDetail,
  ProjectResourceCandidateRegistry,
  ProjectSummary,
  ProjectValidationReport,
  RepositoryDiscovery,
} from "./types.js";

export type LocalProjectRegistry = ProjectRegistry<
  ProjectSummary,
  ProjectDetail,
  ProjectBindings,
  ProjectValidationReport
> &
  ProjectResourceCandidateRegistry & {
    previewCompositionChoices(
      id: unknown,
      proposedConfiguration: unknown,
    ): ProjectCompositionChoices;
  };
export type LocalRepositoryDiscovery = RepositoryDiscoveryPort<RepositoryDiscovery>;

/**
 * The Project Registry's HTTP surface: discovery plus import/list/detail.
 * Discovery inspects the filesystem only, so it keeps working while the engine
 * runs degraded; the project routes need the database and answer
 * 503 `engine.database-unavailable` while it does not.
 */

export interface ProjectRouteDependencies {
  readonly databaseState: () => DatabaseState;
  readonly repositoryDiscovery: LocalRepositoryDiscovery;
  /** `undefined` while the engine runs without a database (degraded). */
  readonly projects: LocalProjectRegistry | undefined;
}

export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDependencies): void {
  app.post("/v1/discovery/repository", async (request, reply) => {
    const body = request.body as { path?: unknown } | undefined;
    return reply.code(200).send(deps.repositoryDiscovery.discoverRepository(body?.path));
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

  app.post("/v1/projects/:projectId/validate", async (request, reply) => {
    const service = requireDatabaseReady(deps);
    const params = request.params as { projectId?: unknown } | undefined;
    const report = service.validateProject(params?.projectId);
    const issues = report.findings.map(({ code, severity, message }) => ({
      code,
      severity,
      message,
    }));
    return reply.code(200).send({ valid: report.valid, issues });
  });

  app.post("/v1/projects/:projectId/validation-report", async (request, reply) => {
    const service = requireDatabaseReady(deps);
    const params = request.params as { projectId?: unknown } | undefined;
    return reply.code(200).send(service.validateProject(params?.projectId));
  });

  app.post("/v1/projects/:projectId/composition-choices", async (request, reply) => {
    const service = requireDatabaseReady(deps);
    const params = request.params as { projectId?: unknown } | undefined;
    const body = request.body as { portableConfig?: unknown } | undefined;
    return reply
      .code(200)
      .send(service.previewCompositionChoices(params?.projectId, body?.portableConfig));
  });

  app.delete("/v1/projects/:projectId", async (request, reply) => {
    const service = requireDatabaseReady(deps);
    const params = request.params as { projectId?: unknown } | undefined;
    service.deleteProject(params?.projectId);
    return reply.code(204).send();
  });

  app.put("/v1/projects/:projectId/configuration", async (request, reply) => {
    const service = requireDatabaseReady(deps);
    const params = request.params as { projectId?: unknown } | undefined;
    const body = request.body as
      { portableConfig?: unknown; writeToRepository?: unknown } | undefined;
    return reply.code(200).send(
      service.replaceProjectConfiguration({
        projectId: params?.projectId,
        portableConfig: body?.portableConfig,
        writeToRepository: body?.writeToRepository,
      }),
    );
  });

  app.get("/v1/projects/:projectId/bindings", async (request, reply) => {
    const service = requireDatabaseReady(deps);
    const params = request.params as { projectId?: unknown } | undefined;
    return reply.code(200).send(service.getProjectBindings(params?.projectId));
  });

  app.get("/v1/projects/:projectId/binding-candidates", async (request, reply) => {
    const service = requireDatabaseReady(deps);
    const params = request.params as { projectId?: unknown } | undefined;
    return reply.code(200).send(service.getProjectResourceChoices(params?.projectId));
  });

  app.post("/v1/projects/:projectId/binding-candidates", async (request, reply) => {
    const service = requireDatabaseReady(deps);
    const params = request.params as { projectId?: unknown } | undefined;
    const body = request.body as { portableConfig?: unknown } | undefined;
    return reply
      .code(200)
      .send(service.previewProjectResourceChoices(params?.projectId, body?.portableConfig));
  });

  app.put("/v1/projects/:projectId/bindings", async (request, reply) => {
    const service = requireDatabaseReady(deps);
    const params = request.params as { projectId?: unknown } | undefined;
    return reply.code(200).send(
      service.replaceProjectBindings({
        projectId: params?.projectId,
        bindings: request.body,
      }),
    );
  });

  app.put("/v1/projects/:projectId/repositories/:repositoryId/binding", async (request, reply) => {
    const service = requireDatabaseReady(deps);
    const params = request.params as { projectId?: unknown; repositoryId?: unknown } | undefined;
    const body = request.body as { path?: unknown; bookmarkRef?: unknown } | undefined;
    return reply.code(200).send(
      service.updateRepositoryBinding({
        projectId: params?.projectId,
        repositoryId: params?.repositoryId,
        path: body?.path,
        bookmarkRef: body?.bookmarkRef,
      }),
    );
  });
}

/** The live probe, so a database handle that fails mid-session degrades too. */
function requireDatabaseReady(deps: ProjectRouteDependencies): LocalProjectRegistry {
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
