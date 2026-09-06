/**
 * Served, versioned human meaning for every documented capability id (ticket 48).
 * This is the machine-readable source; docs/contracts/CAPABILITY_CATALOG_V1.md
 * documents it rather than being read directly by clients. Reproduces that
 * document's tables verbatim — no capability meaning is invented here.
 */
export interface CapabilityCatalogEntry {
  readonly id: string;
  readonly meaning: string;
  readonly owner: string | null;
}

export interface CapabilityCatalogV1 {
  readonly apiVersion: "jarvis.dev/capability-catalog/v1";
  readonly kind: "CapabilityCatalog";
  readonly capabilities: readonly CapabilityCatalogEntry[];
}

const ENTRIES: readonly CapabilityCatalogEntry[] = [
  // Engine capabilities
  {
    id: "repository.read",
    meaning: "Read files and metadata in the bound repository/workspace",
    owner: "Workspace/Project Runtime",
  },
  {
    id: "repository.write",
    meaning: "Modify files inside the leased workspace",
    owner: "Workspace",
  },
  {
    id: "git.branch",
    meaning: "Create and inspect a working branch/worktree",
    owner: "Workspace/Git adapter",
  },
  { id: "git.commit", meaning: "Create a commit owned by the execution", owner: "Git adapter" },
  {
    id: "git.push",
    meaning: "Push the working branch to the configured remote",
    owner: "Git adapter",
  },
  {
    id: "shell.execute",
    meaning: "Run validated Project Commands in a workspace",
    owner: "Process adapter",
  },
  {
    id: "artifact.read",
    meaning: "Read a project-scoped Artifact reference",
    owner: "Artifact Store",
  },
  { id: "artifact.write", meaning: "Write a project-scoped Artifact", owner: "Artifact Store" },
  // Agent and context capabilities
  { id: "agent.execute", meaning: "Start a session on the bound Agent Runtime", owner: null },
  {
    id: "mcp.invoke",
    meaning: "Invoke allowlisted tools/resources on one bound MCP descriptor",
    owner: null,
  },
  {
    id: "work-items.read",
    meaning: "Read canonical Work Item details/comments through a bound source",
    owner: null,
  },
  // SCM capabilities
  {
    id: "scm.change-request.manage",
    meaning: "Provider can execute canonical Change Request requests it consumes",
    owner: null,
  },
  {
    id: "scm.change-request.review",
    meaning: "Provider can publish canonical review requests",
    owner: null,
  },
  {
    id: "scm.change-request.merge",
    meaning: "Provider can execute merge requests; not granted to MVP decision modules",
    owner: null,
  },
  {
    id: "github.api",
    meaning: "Concrete GitHub adapter access, used only inside the GitHub context",
    owner: null,
  },
];

export function capabilityCatalog(): CapabilityCatalogV1 {
  return {
    apiVersion: "jarvis.dev/capability-catalog/v1",
    kind: "CapabilityCatalog",
    capabilities: ENTRIES,
  };
}
