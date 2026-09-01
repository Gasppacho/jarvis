import type { components } from "../api/generated/local-api.js";
import type {
  BindingStatus,
  ProjectBindings,
  PortableProjectConfiguration,
  StoredPortableProjectConfiguration,
  SuggestedProjectConfig,
} from "../../../../packages/project-runtime/src/project-types.js";

/** The Local API contract is the source of truth for exposed lifecycle values. */
export type ProjectStatus = components["schemas"]["ProjectSummary"]["status"];

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly moduleCount: number;
  readonly activeExecutions: number;
}

export interface ProjectDetail extends ProjectSummary {
  readonly portableConfig: StoredPortableProjectConfiguration;
  readonly bindingStatus: BindingStatus;
}

export type RepositoryDiscovery = Omit<
  components["schemas"]["RepositoryDiscovery"],
  "suggested"
> & {
  readonly suggested: SuggestedProjectConfig;
};

export type {
  BindingStatus,
  ProjectBindings,
  PortableProjectConfiguration,
  StoredPortableProjectConfiguration,
  SuggestedProjectConfig,
} from "../../../../packages/project-runtime/src/project-types.js";
