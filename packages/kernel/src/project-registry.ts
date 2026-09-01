/**
 * Public ports for the Kernel's Project Registry.
 *
 * DTO shapes are supplied by adapters so the Kernel does not own Project
 * Runtime aggregates or Local API contracts.
 */

export interface ImportProjectRequest {
  readonly repositoryPath: unknown;
  readonly portableConfig: unknown;
}

export interface ReplaceProjectConfigurationRequest {
  readonly projectId: unknown;
  readonly portableConfig: unknown;
  readonly writeToRepository: unknown;
}

export interface ReplaceProjectBindingsRequest {
  readonly projectId: unknown;
  readonly bindings: unknown;
}

export interface UpdateRepositoryBindingRequest {
  readonly projectId: unknown;
  readonly repositoryId: unknown;
  readonly path: unknown;
  readonly bookmarkRef: unknown;
}

export type ProjectResourceKind = "connection" | "runtime" | "mcp" | "module-instance" | "engine";

/** A resource explicitly in one Project's authority boundary. */
export interface ProjectResourceCandidate {
  readonly ref: string;
  readonly kind: ProjectResourceKind;
  readonly displayName: string;
  readonly capabilities: readonly string[];
}

/** Global registries expose only resources already granted to this Project. */
export interface ProjectResourceGrantPort {
  grantedToProject(projectId: string): readonly ProjectResourceCandidate[];
}

/** Read-only repository inspection remains available while persistence is degraded. */
export interface RepositoryDiscoveryPort<Discovery> {
  discoverRepository(root: unknown): Discovery;
}

/** Registry operations that require durable Project persistence. */
export interface ProjectRegistry<Summary, Detail, Bindings> {
  importProject(request: ImportProjectRequest): Detail;
  listProjects(): Summary[];
  getProject(id: unknown): Detail;
  updateRepositoryBinding(request: UpdateRepositoryBindingRequest): Detail;
  replaceProjectConfiguration(request: ReplaceProjectConfigurationRequest): Detail;
  getProjectBindings(projectId: unknown): Bindings;
  listProjectResourceCandidates(projectId: unknown): readonly ProjectResourceCandidate[];
  replaceProjectBindings(request: ReplaceProjectBindingsRequest): Bindings;
}
