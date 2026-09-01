import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { EngineError } from "../errors.js";
import {
  discoverRepository,
  RepositoryPathError,
  requireRepositoryDirectory,
  slugify,
} from "./discovery.js";
import { validatePortableConfig } from "./contracts.js";
import type { ProjectStore, ProjectRow } from "./store.js";
import type {
  BindingStatus,
  PortableProjectConfig,
  ProjectDetail,
  ProjectSummary,
} from "./types.js";

/**
 * Application boundary for the Project Registry: import, list and detail.
 * The absolute repository path is bound, never stored in the portable config;
 * the committed `.jarvis/project.yaml` is adopted, an oversized or invalid one
 * is rejected rather than silently replaced (docs/architecture/PROJECTS.md).
 */

const PROJECT_YAML = join(".jarvis", "project.yaml");
/** A committed config beyond this size is rejected: it will not be read at all. */
const MAX_PROJECT_YAML_BYTES = 512 * 1024;

export interface ImportProjectRequest {
  readonly repositoryPath: unknown;
  readonly portableConfig: unknown;
}

/** The MVP import flow ends in `draft` (IMPLEMENTATION_SEQUENCE.md, ticket 02). */
const INITIAL_STATUS = "draft" as const;

export class ProjectService {
  constructor(private readonly store: ProjectStore) {}

  importProject(request: ImportProjectRequest): ProjectDetail {
    let repositoryPath: string;
    try {
      repositoryPath = requireRepositoryDirectory(request.repositoryPath);
    } catch (error) {
      throw repositoryPathError(error);
    }

    // The unique index on the canonical path is the double-import guard: it also
    // catches the same working tree reached through a symlink.
    const existing = this.store.findByRepositoryPath(repositoryPath);
    if (existing !== undefined) {
      throw new EngineError(
        "project.already-imported",
        409,
        `This repository is already imported as the project "${existing.id}".`,
        { projectId: existing.id },
      );
    }

    const discovery = discoverRepository(repositoryPath);
    const portableConfig = resolvePortableConfig(repositoryPath, request.portableConfig, discovery);
    const id = allocateProjectId(portableConfig, this.store);
    const name =
      typeof portableConfig.metadata?.name === "string" && portableConfig.metadata.name !== ""
        ? portableConfig.metadata.name
        : id;

    const row = this.store.createProject({
      id,
      name,
      status: INITIAL_STATUS,
      portableConfig,
      repositoryPath,
    });
    return toDetail(row);
  }

  listProjects(): ProjectSummary[] {
    return this.store.list().map(toSummary);
  }

  getProject(id: unknown): ProjectDetail {
    return toDetail(this.requireProject(id));
  }

  updateRepositoryBinding(
    id: unknown,
    repositoryId: unknown,
    path: unknown,
    bookmarkRef: unknown,
  ): ProjectDetail {
    const current = this.requireProject(id);
    const expectedRepositoryId = current.portableConfig.repositories?.[0]?.id ?? "main";
    if (repositoryId !== expectedRepositoryId) {
      throw new EngineError(
        "api.invalid-request",
        400,
        `Project "${current.id}" has no repository binding "${String(repositoryId)}".`,
      );
    }
    if (typeof bookmarkRef !== "string" || bookmarkRef.trim() === "" || bookmarkRef.length > 300) {
      throw new EngineError(
        "api.invalid-request",
        400,
        "bookmarkRef must be a non-empty local reference of at most 300 characters.",
      );
    }

    let repositoryPath: string;
    try {
      repositoryPath = requireRepositoryDirectory(path);
    } catch (error) {
      throw repositoryPathError(error);
    }

    const updated = this.store.updateRepositoryBinding(current.id, repositoryPath, bookmarkRef);
    if (updated === undefined) {
      throw new EngineError(
        "project.not-found",
        404,
        `No project with id "${current.id}" in this installation.`,
      );
    }
    return toDetail(updated);
  }

  private requireProject(id: unknown): ProjectRow {
    const projectId = typeof id === "string" ? id : "";
    const row = this.store.findById(projectId);
    if (row === undefined) {
      throw new EngineError(
        "project.not-found",
        404,
        `No project with id "${projectId || "(empty)"}" in this installation.`,
      );
    }
    return row;
  }
}

/**
 * The committed file wins over a client-supplied config: it is the shared
 * source of truth inside the repository (PROJECTS.md import flow, step 3).
 * The inferred draft from discovery is the only config that stays unvalidated
 * — the full schema requires `slots` and `modules`, which the wizard fills in.
 */
function resolvePortableConfig(
  repositoryPath: string,
  supplied: unknown,
  discovery: ReturnType<typeof discoverRepository>,
): PortableProjectConfig {
  const committed = readCommittedConfig(repositoryPath);
  if (committed !== undefined) return committed;
  if (supplied !== undefined) {
    validatePortableConfig(supplied);
    return supplied as PortableProjectConfig;
  }
  return discovery.suggested;
}

function readCommittedConfig(repositoryPath: string): PortableProjectConfig | undefined {
  const file = join(repositoryPath, PROJECT_YAML);

  let stats;
  try {
    stats = statSync(file);
  } catch {
    return undefined;
  }
  if (!stats.isFile()) {
    throw configInvalid(".jarvis/project.yaml exists but is not a regular file.");
  }
  if (stats.size > MAX_PROJECT_YAML_BYTES) {
    throw configInvalid(
      `.jarvis/project.yaml is ${stats.size} bytes; the engine reads at most ${MAX_PROJECT_YAML_BYTES}. Trim it and import again.`,
    );
  }

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw configInvalid(".jarvis/project.yaml could not be read.");
  }

  let document: unknown;
  try {
    document = parseYaml(text);
  } catch {
    throw configInvalid(".jarvis/project.yaml is not valid YAML.");
  }
  validatePortableConfig(document);
  return document as PortableProjectConfig;
}

function configInvalid(reason: string): EngineError {
  return new EngineError("project.config-invalid", 400, `Rejected ${reason}`);
}

/**
 * Two checkouts of one repository carry the same `metadata.id`; the second is
 * suffixed rather than rejected — the working trees are different machines'
 * copies, so each binds its own path.
 */
function allocateProjectId(config: PortableProjectConfig, store: ProjectStore): string {
  const base = slugify(
    typeof config.metadata?.id === "string" && config.metadata.id !== ""
      ? config.metadata.id
      : "project",
  );
  if (!store.existsById(base)) return base;
  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!store.existsById(candidate)) return candidate;
  }
  throw new EngineError(
    "system.internal-error",
    500,
    "No free project id could be allocated for this repository.",
  );
}

function repositoryPathError(error: unknown): EngineError {
  if (error instanceof RepositoryPathError) {
    return new EngineError("repository.path-invalid", 400, error.message);
  }
  if (error instanceof EngineError) return error;
  return new EngineError("system.internal-error", 500, "The repository could not be inspected.");
}

function toSummary(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    moduleCount: row.portableConfig.modules?.length ?? 0,
    activeExecutions: 0,
  };
}

function toDetail(row: ProjectRow): ProjectDetail {
  const repositoryId = row.portableConfig.repositories?.[0]?.id ?? "main";
  const bindingStatus: BindingStatus = {
    [repositoryId]: {
      path: row.repositoryPath,
      // Live probe: a repository moved away since import must show as such.
      accessible: isAccessibleDirectory(row.repositoryPath),
      bookmarkRef: row.bookmarkRef,
    },
  };
  return {
    ...toSummary(row),
    portableConfig: row.portableConfig,
    bindingStatus,
  };
}

function isAccessibleDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
