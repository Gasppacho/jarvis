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
  ProjectCompositionGraph,
  ProjectCompositionReview,
  ProjectDetail,
  ProjectResourceCandidateRegistry,
  ProjectSummary,
  ProjectValidationReport,
  RepositoryDiscovery,
  EventSummary,
  ExecutionSummary,
  DeadLetterSummary,
  ListEventsQuery,
  ListExecutionsQuery,
} from "./types.js";
import type { ProjectSubscriptions } from "../../../../packages/project-runtime/src/project-subscriptions.js";

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
    compositionReview(id: unknown, proposedConfiguration: unknown): ProjectCompositionReview;
    compositionGraph(id: unknown, proposedConfiguration: unknown): ProjectCompositionGraph;
    listProjectSubscriptions(id: unknown): ProjectSubscriptions;
    listProjectEvents(id: unknown, query: ListEventsQuery): { readonly items: EventSummary[] };
    listProjectExecutions(
      id: unknown,
      query: ListExecutionsQuery,
    ): { readonly items: ExecutionSummary[] };
    listProjectDeadLetters(id: unknown): { readonly items: DeadLetterSummary[] };
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

  app.post("/v1/projects/:projectId/activate", async (request, reply) => {
    const service = requireDatabaseReady(deps);
    const params = request.params as { projectId?: unknown } | undefined;
    const body = request.body as { compositionFingerprint?: unknown } | undefined;
    return reply.code(200).send(
      service.activateProject({
        projectId: params?.projectId,
        compositionFingerprint: body?.compositionFingerprint,
      }),
    );
  });

  app.get("/v1/projects/:projectId/subscriptions", async (request, reply) => {
    const service = requireDatabaseReady(deps);
    const params = request.params as { projectId?: unknown } | undefined;
    return reply.code(200).send(service.listProjectSubscriptions(params?.projectId));
  });

  app.get("/v1/projects/:projectId/events", async (request, reply) => {
    const service = requireDatabaseReady(deps);
    const params = request.params as { projectId?: unknown } | undefined;
    const query = request.query as { correlationId?: unknown; limit?: unknown } | undefined;
    return reply
      .code(200)
      .send(service.listProjectEvents(params?.projectId, parseListEventsQuery(query)));
  });

  app.get("/v1/projects/:projectId/executions", async (request, reply) => {
    const service = requireDatabaseReady(deps);
    const params = request.params as { projectId?: unknown } | undefined;
    const query = request.query as { limit?: unknown } | undefined;
    return reply
      .code(200)
      .send(service.listProjectExecutions(params?.projectId, parseListExecutionsQuery(query)));
  });

  app.get("/v1/projects/:projectId/dead-letters", async (request, reply) => {
    const service = requireDatabaseReady(deps);
    const params = request.params as { projectId?: unknown } | undefined;
    return reply.code(200).send(service.listProjectDeadLetters(params?.projectId));
  });

  app.post("/v1/projects/:projectId/composition-choices", async (request, reply) => {
    const service = requireDatabaseReady(deps);
    const params = request.params as { projectId?: unknown } | undefined;
    const body = request.body as { portableConfig?: unknown } | undefined;
    return reply
      .code(200)
      .send(service.previewCompositionChoices(params?.projectId, body?.portableConfig));
  });

  app.post("/v1/projects/:projectId/composition-review", async (request, reply) => {
    const service = requireDatabaseReady(deps);
    const params = request.params as { projectId?: unknown } | undefined;
    const body = request.body as { portableConfig?: unknown } | undefined;
    return reply.code(200).send(service.compositionReview(params?.projectId, body?.portableConfig));
  });

  app.post("/v1/projects/:projectId/composition-graph", async (request, reply) => {
    const service = requireDatabaseReady(deps);
    const params = request.params as { projectId?: unknown } | undefined;
    const body = request.body as { portableConfig?: unknown } | undefined;
    return reply.code(200).send(service.compositionGraph(params?.projectId, body?.portableConfig));
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

const DEFAULT_LIST_LIMIT = 100;
const MIN_LIST_LIMIT = 1;
const MAX_LIST_LIMIT = 500;

/** Fastify parses the querystring as strings; the contract's `limit` is an
 * integer 1..500 defaulting to 100 for both `/events` and `/executions`
 * (issue #59 code review, finding 1 — the same contract, shared here rather
 * than copied). An out-of-range or non-integer value is a client error, not a
 * silent clamp. */
function parseLimit(rawLimit: unknown): number {
  if (rawLimit === undefined) return DEFAULT_LIST_LIMIT;
  const raw = typeof rawLimit === "string" ? rawLimit : String(rawLimit);
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < MIN_LIST_LIMIT || limit > MAX_LIST_LIMIT) {
    throw new EngineError(
      "api.invalid-request",
      400,
      `limit must be an integer between ${MIN_LIST_LIMIT} and ${MAX_LIST_LIMIT}.`,
    );
  }
  return limit;
}

/** Fastify parses a repeated `?correlationId=a&correlationId=b` as an array,
 * not a string. Silently ignoring that (as a bare `typeof === "string"` check
 * does) drops the filter and hands the client the Project's whole journal
 * with no 400 and no signal (issue #59 code review, finding 4) — so anything
 * other than a single string value is rejected outright. An absent param
 * stays absent (no filter); an empty string is treated the same as absent,
 * unchanged from before this fix. */
function parseCorrelationId(rawCorrelationId: unknown): string | undefined {
  if (rawCorrelationId === undefined) return undefined;
  if (typeof rawCorrelationId !== "string") {
    throw new EngineError(
      "api.invalid-request",
      400,
      "correlationId must be a single string value.",
    );
  }
  return rawCorrelationId === "" ? undefined : rawCorrelationId;
}

function parseListEventsQuery(
  query: { correlationId?: unknown; limit?: unknown } | undefined,
): ListEventsQuery {
  const correlationId = parseCorrelationId(query?.correlationId);
  const limit = parseLimit(query?.limit);
  return { limit, ...(correlationId === undefined ? {} : { correlationId }) };
}

function parseListExecutionsQuery(query: { limit?: unknown } | undefined): ListExecutionsQuery {
  return { limit: parseLimit(query?.limit) };
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
