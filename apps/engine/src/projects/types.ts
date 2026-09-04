import type { components } from "../api/generated/local-api.js";
import type {
  BindingStatus,
  ProjectBindings,
  ProjectCompositionChoices,
  ProjectCompositionReview,
  ProjectRequestRoute,
  ProjectValidationFindingTarget,
  ProjectValidationReport,
  PortableProjectConfiguration,
  StoredPortableProjectConfiguration,
  SuggestedProjectConfig,
} from "../../../../packages/project-runtime/src/project-types.js";
import type { ProjectCompositionGraph } from "../../../../packages/project-runtime/src/composition-graph.js";

/** The Local API contract is the source of truth for exposed lifecycle values. */
export type ProjectStatus = components["schemas"]["ProjectSummary"]["status"];

type Assert<T extends true> = T;
type MutuallyAssignable<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

type ApiValidationReport = components["schemas"]["ProjectValidationReportV1"];
export type LegacyProjectValidationIssue =
  components["schemas"]["ValidationReport"]["issues"][number];
type DomainContractEdge = Extract<ProjectValidationFindingTarget, { kind: "contract-edge" }>;
type ApiContractEdge = Extract<
  ApiValidationReport["findings"][number]["target"],
  { producer: { contract: unknown }; consumer: { contract: unknown } }
>;

/** Compile-time guards against generated Local API and Project Runtime report drift. */
export type ProjectRequestRouteContractParity = Assert<
  MutuallyAssignable<ProjectRequestRoute, ApiValidationReport["requestRoutes"][number]>
>;
export type ProjectContractEdgeContractParity = Assert<
  MutuallyAssignable<
    Pick<DomainContractEdge, "producer" | "consumer">,
    Pick<ApiContractEdge, "producer" | "consumer">
  >
>;
export type ProjectValidationFindingTargetContractParity = Assert<
  MutuallyAssignable<
    Mutable<ProjectValidationFindingTarget>,
    ApiValidationReport["findings"][number]["target"]
  >
>;
export type LocalApiProjectValidationReportContractParity = Assert<
  MutuallyAssignable<Mutable<ProjectValidationReport>, ApiValidationReport>
>;

type ApiCompositionGraph = components["schemas"]["ProjectCompositionGraphV1"];

/** The graph must stay isomorphic with the generated read model the client consumes. */
export type LocalApiProjectCompositionGraphContractParity = Assert<
  MutuallyAssignable<Mutable<ProjectCompositionGraph>, ApiCompositionGraph>
>;

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
  ProjectCompositionChoices,
  ProjectCompositionReview,
  PortableProjectConfiguration,
  ProjectResourceCandidate,
  ProjectResourceCandidateRegistry,
  ProjectResourceChoices,
  ProjectResourceGrantPort,
  ProjectValidationFinding,
  ProjectValidationReport,
  StoredPortableProjectConfiguration,
  SuggestedProjectConfig,
} from "../../../../packages/project-runtime/src/project-types.js";
export type { ProjectCompositionGraph } from "../../../../packages/project-runtime/src/composition-graph.js";
