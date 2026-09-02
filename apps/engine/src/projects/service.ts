import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ModuleHost } from "../../../../packages/kernel/src/module-host.js";
import {
  projectResourceCandidates,
  type ProjectCompositionValidationPort,
} from "../../../../packages/project-runtime/src/composition-validator.js";
import { previewProjectCompositionChoices } from "../../../../packages/project-runtime/src/composition-choices.js";
import type {
  ImportProjectRequest,
  ProjectRegistry,
  ReplaceProjectBindingsRequest,
  ReplaceProjectConfigurationRequest,
  RepositoryDiscoveryPort,
  UpdateRepositoryBindingRequest,
} from "../../../../packages/kernel/src/project-registry.js";
import { EngineError } from "../errors.js";
import {
  discoverRepository,
  RepositoryPathError,
  requireRepositoryDirectory,
  slugify,
} from "./discovery.js";
import {
  requirePortableProjectConfiguration,
  requireProjectBindings,
  validatePortableConfig,
} from "./contracts.js";
import type { ProjectConfigurationWriter } from "./repository-config-writer.js";
import type { RepositoryAccessibilityPort } from "./repository-accessibility.js";
import type { ProjectRow, ProjectStore } from "./store.js";
import type {
  BindingStatus,
  ProjectCompositionChoices,
  PortableProjectConfiguration,
  ProjectBindings,
  ProjectResourceCandidate,
  ProjectResourceGrantPort,
  ProjectValidationReport,
  ProjectDetail,
  ProjectSummary,
  StoredPortableProjectConfiguration,
  RepositoryDiscovery,
} from "./types.js";

const PROJECT_YAML = join(".jarvis", "project.yaml");
const MAX_PROJECT_YAML_BYTES = 512 * 1024;
const INITIAL_STATUS = "draft" as const;

export class RepositoryDiscoveryService implements RepositoryDiscoveryPort<RepositoryDiscovery> {
  discoverRepository(root: unknown): RepositoryDiscovery {
    try {
      return discoverRepository(root);
    } catch (error) {
      throw repositoryPathError(error);
    }
  }
}

export class ProjectService implements ProjectRegistry<
  ProjectSummary,
  ProjectDetail,
  ProjectBindings,
  ProjectValidationReport
> {
  constructor(
    private readonly store: ProjectStore,
    private readonly modules: ModuleHost,
    private readonly repositoryWriter: ProjectConfigurationWriter,
    private readonly resourceGrants: ProjectResourceGrantPort,
    private readonly compositionValidator: ProjectCompositionValidationPort,
    private readonly repositoryAccessibility: RepositoryAccessibilityPort,
  ) {}

  importProject(request: ImportProjectRequest): ProjectDetail {
    let repositoryPath: string;
    try {
      repositoryPath = requireRepositoryDirectory(request.repositoryPath);
    } catch (error) {
      throw repositoryPathError(error);
    }
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
    const resolved = resolvePortableConfig(repositoryPath, request.portableConfig, discovery);
    const portableConfig = resolved.configuration;
    if (!resolved.isDiscoveredDraft) {
      requirePortableProjectConfiguration(portableConfig, this.modules);
    }
    const id = allocateProjectId(portableConfig, this.store);
    const name = portableConfig.metadata.name || id;
    return toDetail(
      this.store.createProject({
        id,
        name,
        status: INITIAL_STATUS,
        portableConfig,
        repositoryPath,
      }),
      this.repositoryAccessibility,
    );
  }

  listProjects(): ProjectSummary[] {
    return this.store.list().map(toSummary);
  }

  getProject(id: unknown): ProjectDetail {
    return toDetail(this.requireProject(id), this.repositoryAccessibility);
  }

  validateProject(id: unknown): ProjectValidationReport {
    const project = this.requireProject(id);
    return this.compositionValidator.validate({
      projectId: project.id,
      configuration: project.portableConfig,
      slotBindings: project.slotBindings,
      repositoryBinding: {
        saved: project.bookmarkRef !== null,
        accessible: this.repositoryAccessibility.isAccessibleDirectory(project.repositoryPath),
      },
      grantedResources: this.resourceGrants.grantedToProject(project.id),
    });
  }

  previewCompositionChoices(
    id: unknown,
    proposedConfiguration: unknown,
  ): ProjectCompositionChoices {
    const project = this.requireProject(id);
    const configuration =
      proposedConfiguration === undefined
        ? project.portableConfig
        : requirePortableProjectConfiguration(proposedConfiguration, this.modules);
    const validation = this.compositionValidator.validate({
      projectId: project.id,
      configuration,
      slotBindings: project.slotBindings,
      repositoryBinding: {
        saved: project.bookmarkRef !== null,
        accessible: this.repositoryAccessibility.isAccessibleDirectory(project.repositoryPath),
      },
      grantedResources: this.resourceGrants.grantedToProject(project.id),
    });
    return previewProjectCompositionChoices(this.modules, {
      projectId: project.id,
      configuration,
      slotBindings: project.slotBindings,
      validationFindings: validation.findings,
    });
  }

  deleteProject(id: unknown): void {
    const projectId = typeof id === "string" ? id : "";
    this.store.transaction(() => {
      const project = this.store.findById(projectId);
      if (project === undefined) throw notFound(projectId || "(empty)");
      if (project.status === "active") {
        throw new EngineError(
          "project.active",
          409,
          `Project "${projectId}" is active and cannot be deleted. Pause it before deleting it.`,
        );
      }
      if (!this.store.deleteById(projectId)) throw notFound(projectId || "(empty)");
    });
  }

  replaceProjectConfiguration(request: ReplaceProjectConfigurationRequest): ProjectDetail {
    const current = this.requireProject(request.projectId);
    if (typeof request.writeToRepository !== "boolean") {
      throw new EngineError("api.invalid-request", 400, "writeToRepository must be a boolean.");
    }
    const configuration = requirePortableProjectConfiguration(request.portableConfig, this.modules);
    for (const slot of Object.keys(current.slotBindings)) {
      if (!(slot in configuration.slots)) {
        throw new EngineError(
          "project.config-invalid",
          400,
          `/slots/${slot} cannot be removed while a Local Binding still references it.`,
        );
      }
    }
    validateSlotBindings(
      configuration.slots,
      current.slotBindings,
      eligibleCandidates(current.id, configuration, this.modules, this.resourceGrants),
      "project.config-invalid",
    );

    // Filesystem + SQLite cannot share a transaction. The repository write happens
    // first, then is compensated if SQLite refuses the replacement.
    const compensation = request.writeToRepository
      ? this.repositoryWriter.write(current.repositoryPath, configuration)
      : undefined;
    try {
      const updated = this.store.transaction(() =>
        this.store.replaceConfiguration(current.id, configuration, configuration.metadata.name),
      );
      if (updated === undefined) throw notFound(current.id);
      return toDetail(updated, this.repositoryAccessibility);
    } catch (error) {
      try {
        compensation?.restore();
      } catch {
        throw new EngineError(
          "project.repository-compensation-failed",
          500,
          "SQLite rejected the configuration and the previous repository file could not be restored. Reload the Project and inspect .jarvis/project.yaml before retrying.",
        );
      }
      throw error;
    }
  }

  getProjectBindings(projectId: unknown): ProjectBindings {
    return toBindings(this.requireProject(projectId));
  }

  listProjectResourceCandidates(projectId: unknown): readonly ProjectResourceCandidate[] {
    const current = this.requireProject(projectId);
    return eligibleCandidates(
      current.id,
      current.portableConfig,
      this.modules,
      this.resourceGrants,
    );
  }

  replaceProjectBindings(request: ReplaceProjectBindingsRequest): ProjectBindings {
    const current = this.requireProject(request.projectId);
    const bindings = requireProjectBindings(request.bindings);
    if (bindings.projectId !== current.id) {
      throw new EngineError(
        "project.bindings-invalid",
        400,
        "/projectId must match the Project selected by the URL.",
      );
    }
    validateBindingReferences(
      current,
      bindings,
      eligibleCandidates(current.id, current.portableConfig, this.modules, this.resourceGrants),
    );
    const repositoryId = current.portableConfig.repositories[0]?.id ?? "main";
    const supplied = bindings.repositories[repositoryId];
    if (supplied === undefined || Object.keys(bindings.repositories).length !== 1) {
      throw new EngineError(
        "project.bindings-invalid",
        400,
        `/repositories must contain only the declared repository ${repositoryId}.`,
      );
    }

    // Generic Local Bindings replacement cannot establish or replace the shell-owned
    // Repository Grant. Only the dedicated repository binding operation may do that.
    if (
      supplied.bookmarkRef !== null &&
      (supplied.bookmarkRef !== current.bookmarkRef || supplied.path !== current.repositoryPath)
    ) {
      throw new EngineError(
        "project.bindings-invalid",
        400,
        "/repositories/main must preserve the shell-established Repository Grant.",
      );
    }

    const updated = this.store.transaction(() =>
      this.store.replaceBindings(
        current.id,
        current.repositoryPath,
        current.bookmarkRef,
        bindings.slots,
      ),
    );
    if (updated === undefined) throw notFound(current.id);
    return toBindings(updated);
  }

  updateRepositoryBinding(request: UpdateRepositoryBindingRequest): ProjectDetail {
    const { projectId, repositoryId, path, bookmarkRef } = request;
    const current = this.requireProject(projectId);
    const expectedRepositoryId = current.portableConfig.repositories[0]?.id ?? "main";
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
    if (updated === undefined) throw notFound(current.id);
    return toDetail(updated, this.repositoryAccessibility);
  }

  private requireProject(id: unknown): ProjectRow {
    const projectId = typeof id === "string" ? id : "";
    const row = this.store.findById(projectId);
    if (row === undefined) throw notFound(projectId || "(empty)");
    return row;
  }
}

function validateBindingReferences(
  current: ProjectRow,
  bindings: ProjectBindings,
  candidates: readonly ProjectResourceCandidate[],
): void {
  const declaredSlots =
    "slots" in current.portableConfig ? current.portableConfig.slots : undefined;
  validateSlotBindings(declaredSlots, bindings.slots, candidates, "project.bindings-invalid");
}

function validateSlotBindings(
  declaredSlots: PortableProjectConfiguration["slots"] | undefined,
  bindings: ProjectBindings["slots"],
  candidates: readonly ProjectResourceCandidate[],
  code: "project.config-invalid" | "project.bindings-invalid",
): void {
  for (const [slot, binding] of Object.entries(bindings)) {
    const requirement = declaredSlots?.[slot];
    if (requirement === undefined) {
      throw new EngineError(
        code,
        400,
        `/slots/${slot} is not declared by the Portable Configuration.`,
      );
    }
    const eligible = candidates.some(
      (candidate) =>
        candidate.ref === binding.ref &&
        candidate.kind === binding.kind &&
        candidate.capabilities.includes(requirement.requires),
    );
    if (!eligible) {
      throw new EngineError(
        code,
        400,
        `/slots/${slot} must reference an explicitly granted resource with capability ${requirement.requires}.`,
      );
    }
  }
}

function eligibleCandidates(
  projectId: string,
  configuration: StoredPortableProjectConfiguration,
  modules: ModuleHost,
  grants: ProjectResourceGrantPort,
): readonly ProjectResourceCandidate[] {
  return projectResourceCandidates(configuration, modules, grants.grantedToProject(projectId));
}

function resolvePortableConfig(
  repositoryPath: string,
  supplied: unknown,
  discovery: ReturnType<typeof discoverRepository>,
): { configuration: StoredPortableProjectConfiguration; isDiscoveredDraft: boolean } {
  const committed = readCommittedConfig(repositoryPath);
  if (committed !== undefined) {
    return { configuration: committed, isDiscoveredDraft: false };
  }
  if (supplied !== undefined) {
    validatePortableConfig(supplied);
    return {
      configuration: supplied as PortableProjectConfiguration,
      isDiscoveredDraft: false,
    };
  }
  return { configuration: discovery.suggested, isDiscoveredDraft: true };
}

function readCommittedConfig(
  repositoryPath: string,
): StoredPortableProjectConfiguration | undefined {
  const file = join(repositoryPath, PROJECT_YAML);
  let stats;
  try {
    stats = statSync(file);
  } catch {
    return undefined;
  }
  if (!stats.isFile())
    throw configInvalid(".jarvis/project.yaml exists but is not a regular file.");
  if (stats.size > MAX_PROJECT_YAML_BYTES) {
    throw configInvalid(
      `.jarvis/project.yaml is ${stats.size} bytes; the engine reads at most ${MAX_PROJECT_YAML_BYTES}. Trim it and import again.`,
    );
  }
  let document: unknown;
  try {
    document = parseYaml(readFileSync(file, "utf8"));
  } catch {
    throw configInvalid(".jarvis/project.yaml could not be read as valid YAML.");
  }
  validatePortableConfig(document);
  return document as StoredPortableProjectConfiguration;
}

function configInvalid(reason: string): EngineError {
  return new EngineError("project.config-invalid", 400, `Rejected ${reason}`);
}

function allocateProjectId(
  config: StoredPortableProjectConfiguration,
  store: ProjectStore,
): string {
  const base = slugify(config.metadata.id || "project");
  if (!store.existsById(base)) return base;
  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!store.existsById(candidate)) return candidate;
  }
  throw new EngineError("system.internal-error", 500, "No free project id could be allocated.");
}

function repositoryPathError(error: unknown): EngineError {
  if (error instanceof RepositoryPathError) {
    return new EngineError("repository.path-invalid", 400, error.message);
  }
  if (error instanceof EngineError) return error;
  return new EngineError("system.internal-error", 500, "The repository could not be inspected.");
}

function notFound(id: string): EngineError {
  return new EngineError(
    "project.not-found",
    404,
    `No project with id "${id}" in this installation.`,
  );
}

function toSummary(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    moduleCount: "modules" in row.portableConfig ? (row.portableConfig.modules?.length ?? 0) : 0,
    activeExecutions: 0,
  };
}

function toDetail(
  row: ProjectRow,
  repositoryAccessibility: RepositoryAccessibilityPort,
): ProjectDetail {
  const repositoryId = row.portableConfig.repositories[0]?.id ?? "main";
  const bindingStatus: BindingStatus = {
    [repositoryId]: {
      path: row.repositoryPath,
      accessible: repositoryAccessibility.isAccessibleDirectory(row.repositoryPath),
      bookmarkRef: row.bookmarkRef,
    },
  };
  return { ...toSummary(row), portableConfig: row.portableConfig, bindingStatus };
}

function toBindings(row: ProjectRow): ProjectBindings {
  const repositoryId = row.portableConfig.repositories[0]?.id ?? "main";
  return {
    apiVersion: "jarvis.dev/project-bindings/v1",
    kind: "ProjectBindings",
    projectId: row.id,
    repositories: {
      [repositoryId]: { path: row.repositoryPath, bookmarkRef: row.bookmarkRef },
    },
    slots: row.slotBindings,
  };
}
