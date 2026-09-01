import type {
  ProjectResourceCandidate,
  ProjectResourceGrantPort,
} from "../../../../packages/project-runtime/src/project-types.js";

/** Until connection/runtime/MCP registries land, no global resource is granted implicitly. */
export class EmptyProjectResourceGrants implements ProjectResourceGrantPort {
  grantedToProject(_projectId: string): readonly ProjectResourceCandidate[] {
    return [];
  }
}
