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

/** Read-only repository inspection remains available while persistence is degraded. */
export interface RepositoryDiscoveryPort<Discovery> {
  discoverRepository(root: unknown): Discovery;
}

/** Registry operations that require durable Project persistence. */
export interface ProjectRegistry<Summary, Detail, Bindings, ValidationReport> {
  importProject(request: ImportProjectRequest): Detail;
  listProjects(): Summary[];
  getProject(id: unknown): Detail;
  validateProject(id: unknown): ValidationReport;
  deleteProject(id: unknown): void;
  updateRepositoryBinding(request: UpdateRepositoryBindingRequest): Detail;
  replaceProjectConfiguration(request: ReplaceProjectConfigurationRequest): Detail;
  getProjectBindings(projectId: unknown): Bindings;
  replaceProjectBindings(request: ReplaceProjectBindingsRequest): Bindings;
}
