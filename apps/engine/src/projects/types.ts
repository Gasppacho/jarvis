import type { components } from "../api/generated/local-api.js";
import type {
  BindingStatus,
  PortableProjectConfig,
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
  readonly portableConfig: PortableProjectConfig;
  readonly bindingStatus: BindingStatus;
}

/**
 * The contract types `suggested` as a free-form object; this is the shape the
 * repository-discovery adapter returns. The wire JSON is identical.
 */
export type RepositoryDiscovery = Omit<
  components["schemas"]["RepositoryDiscovery"],
  "suggested"
> & {
  readonly suggested: SuggestedProjectConfig;
};

export type {
  BindingStatus,
  PortableProjectConfig,
  SuggestedProjectConfig,
} from "../../../../packages/project-runtime/src/project-types.js";
