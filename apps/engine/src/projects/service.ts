import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";
import type { components } from "../api/generated/local-api.ts";
import { readContract } from "../contracts.ts";
import { JarvisError } from "../errors.ts";
import {
  discoverRepository,
  requireRepositoryDirectory,
  slugify,
} from "./discovery.ts";
import type { ProjectRecord, ProjectStore } from "./store.ts";

const addFormats = addFormatsModule.default;

export type ProjectSummary = components["schemas"]["ProjectSummary"];
export type ProjectDetail = components["schemas"]["ProjectDetail"];
export type ProjectStatus = ProjectSummary["status"];

/** The state an imported project starts in: its configuration is incomplete. */
const INITIAL_STATUS: ProjectStatus = "draft";

const MAX_PROJECT_YAML_BYTES = 512 * 1024;

export interface ImportProjectInput {
  readonly repositoryPath: unknown;
  readonly portableConfig?: unknown;
}

export interface ProjectServiceOptions {
  readonly now?: () => Date;
}

export class ProjectService {
  private readonly validateProjectConfig: ValidateFunction;
  private readonly now: () => Date;
  private readonly store: ProjectStore;

  constructor(store: ProjectStore, options: ProjectServiceOptions = {}) {
    this.store = store;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    this.validateProjectConfig = ajv.compile(
      readContract("schemas/project-config.v1.schema.json"),
    );
    this.now = options.now ?? (() => new Date());
  }

  discover(path: unknown): components["schemas"]["RepositoryDiscovery"] {
    return discoverRepository(requireRepositoryDirectory(path));
  }

  import(input: ImportProjectInput): ProjectDetail {
    const root = requireRepositoryDirectory(input.repositoryPath);

    const alreadyImported = this.store.findByRepositoryPath(root);
    if (alreadyImported !== null) {
      throw JarvisError.conflict(
        "project.already-imported",
        `This repository is already the Jarvis project "${alreadyImported}".`,
      );
    }

    const portableConfig = this.resolvePortableConfig(
      root,
      input.portableConfig,
    );
    const timestamp = this.now().toISOString();

    const record: ProjectRecord = {
      id: this.allocateId(portableConfig, root),
      name: readName(portableConfig) ?? basename(root),
      status: INITIAL_STATUS,
      portableConfig,
      repositories: [{ repositoryId: "main", path: root, bookmarkRef: null }],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.store.insert(record);
    return toDetail(record);
  }

  list(): ProjectSummary[] {
    return this.store.list().map(toSummary);
  }

  get(id: string): ProjectDetail {
    const record = this.store.find(id);
    if (record === null) {
      throw JarvisError.notFound(
        "project.not-found",
        `No Jarvis project named "${id}".`,
      );
    }
    return toDetail(record);
  }

  /**
   * A caller-supplied configuration and a committed `.jarvis/project.yaml` are
   * both contractual, so both are validated. A configuration inferred from
   * discovery is a draft by definition and stays unvalidated until the wizard
   * completes it.
   */
  private resolvePortableConfig(
    root: string,
    supplied: unknown,
  ): Record<string, unknown> {
    if (supplied !== undefined) {
      return this.requireValidConfig(supplied, "the supplied configuration");
    }

    const committed = join(root, ".jarvis", "project.yaml");
    if (existsSync(committed)) {
      // A committed configuration is the user's stated intent. Never discard
      // one silently in favour of an inferred draft.
      const stats = statSync(committed);
      if (!stats.isFile()) {
        throw JarvisError.badRequest(
          "project.config-invalid",
          ".jarvis/project.yaml must be a file.",
        );
      }
      if (stats.size > MAX_PROJECT_YAML_BYTES) {
        throw JarvisError.badRequest(
          "project.config-invalid",
          `.jarvis/project.yaml exceeds ${MAX_PROJECT_YAML_BYTES} bytes.`,
        );
      }

      let parsed: unknown;
      try {
        parsed = parseYaml(readFileSync(committed, "utf8"));
      } catch {
        throw JarvisError.badRequest(
          "project.config-invalid",
          ".jarvis/project.yaml is not valid YAML.",
        );
      }
      return this.requireValidConfig(parsed, ".jarvis/project.yaml");
    }

    return discoverRepository(root).suggested as Record<string, unknown>;
  }

  private requireValidConfig(
    candidate: unknown,
    source: string,
  ): Record<string, unknown> {
    if (this.validateProjectConfig(candidate)) {
      return candidate as Record<string, unknown>;
    }
    // Schema paths locate the problem without echoing the offending value.
    const paths = (this.validateProjectConfig.errors ?? [])
      .map((error) =>
        `${error.instancePath || "/"} ${error.message ?? ""}`.trim(),
      )
      .slice(0, 5)
      .join("; ");
    throw JarvisError.badRequest(
      "project.config-invalid",
      `${source} does not match Project Config v1: ${paths}`,
    );
  }

  /** Honours the configured id, but never collides with an existing project. */
  private allocateId(
    portableConfig: Record<string, unknown>,
    root: string,
  ): string {
    const preferred = readId(portableConfig) ?? slugify(basename(root));
    if (!this.store.existsWithId(preferred)) return preferred;

    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const candidate = `${preferred}-${suffix}`;
      if (!this.store.existsWithId(candidate)) return candidate;
    }
    throw JarvisError.conflict(
      "project.id-unavailable",
      `Too many Jarvis projects are already named "${preferred}".`,
    );
  }
}

function metadataOf(
  portableConfig: Record<string, unknown>,
): Record<string, unknown> | null {
  const metadata = portableConfig.metadata;
  return typeof metadata === "object" && metadata !== null
    ? (metadata as Record<string, unknown>)
    : null;
}

function readId(portableConfig: Record<string, unknown>): string | null {
  const id = metadataOf(portableConfig)?.id;
  return typeof id === "string" && id !== "" ? id : null;
}

function readName(portableConfig: Record<string, unknown>): string | null {
  const name = metadataOf(portableConfig)?.name;
  return typeof name === "string" && name !== "" ? name : null;
}

function moduleCountOf(portableConfig: Record<string, unknown>): number {
  return Array.isArray(portableConfig.modules)
    ? portableConfig.modules.length
    : 0;
}

function toSummary(record: ProjectRecord): ProjectSummary {
  return {
    id: record.id,
    name: record.name,
    status: record.status as ProjectStatus,
    moduleCount: moduleCountOf(record.portableConfig),
    activeExecutions: 0,
  };
}

function toDetail(record: ProjectRecord): ProjectDetail {
  return {
    ...toSummary(record),
    portableConfig: record.portableConfig,
    // Local bindings, reported without secrets: the shell needs the path it
    // granted access to, and whether that path is still reachable.
    bindingStatus: {
      repositories: Object.fromEntries(
        record.repositories.map((repository) => [
          repository.repositoryId,
          { path: repository.path, accessible: existsSync(repository.path) },
        ]),
      ),
    },
  };
}
