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
export interface ProjectRegistry<Summary, Detail> {
  importProject(request: ImportProjectRequest): Detail;
  listProjects(): Summary[];
  getProject(id: unknown): Detail;
  updateRepositoryBinding(request: UpdateRepositoryBindingRequest): Detail;
}
