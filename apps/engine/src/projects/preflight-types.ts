import type { components } from "../api/generated/local-api.js";
import type { ProjectAgentRuntimeChoices } from "../../../../packages/project-runtime/src/project-types.js";
import type { ProjectValidationReport } from "./types.js";

export type ProjectPreflight = Omit<
  components["schemas"]["ProjectPreflightV1"],
  "validation" | "runtime"
> & {
  readonly validation: ProjectValidationReport;
  readonly runtime: ProjectAgentRuntimeChoices;
};

export type PreflightCheck = components["schemas"]["PreflightCheck"];
