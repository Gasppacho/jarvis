import type { ProjectRepositoryIdentity } from "../../../../packages/module-sdk/src/index.js";
import type {
  ProjectValidationFinding,
  StoredPortableProjectConfiguration,
} from "../../../../packages/project-runtime/src/project-types.js";
import { parseRepositoryRemote, readRepositoryRemotes } from "./discovery.js";
import type { ResolvedProjectSnapshot } from "./store.js";

const GITHUB_MODULE_ID = "jarvis.module.github";

type UnresolvedRepositoryStatus =
  | "unknown-id"
  | "remote-missing"
  | "remote-ambiguous"
  | "unsupported-provider"
  | "identity-unresolved";

export type RepositoryResolution =
  | {
      readonly status: "resolved";
      readonly repository: ProjectRepositoryIdentity;
    }
  | { readonly status: UnresolvedRepositoryStatus };

export interface RepositoryResolutionValidation {
  readonly findings: readonly ProjectValidationFinding[];
  readonly repositoryIdentities: readonly ProjectRepositoryIdentity[];
}

interface DeclaredRepositoryResolution {
  readonly id: string;
  readonly result:
    | { readonly status: "resolved"; readonly repository: ProjectRepositoryIdentity }
    | { readonly status: Exclude<UnresolvedRepositoryStatus, "ambiguous-identity"> };
}

/** Resolves Project repository IDs to provider identities from the bound checkout. */
export class ProjectRepositoryResolver {
  public validate(
    configuration: StoredPortableProjectConfiguration,
    repositoryPath: string,
  ): RepositoryResolutionValidation {
    const declared = this.declaredRepositories(configuration, repositoryPath);
    const repositoryIdentities = declared.flatMap((repository) =>
      repository.result.status === "resolved" ? [repository.result.repository] : [],
    );
    const findings = configuration.modules.flatMap((instance) => {
      if (instance.moduleId !== GITHUB_MODULE_ID) return [];
      return uniqueRepositoryReferences(instance.configuration).flatMap((reference) => {
        const resolution = resolveDeclaredRepository(declared, reference);
        return resolution.status === "resolved"
          ? []
          : [repositoryFinding(instance.instanceId, reference, resolution)];
      });
    });
    return { findings, repositoryIdentities };
  }

  public migrationFinding(
    configuration: StoredPortableProjectConfiguration,
    snapshot: ResolvedProjectSnapshot | undefined,
  ): ProjectValidationFinding | undefined {
    if (
      snapshot?.repositoryIdentities !== undefined ||
      !configuration.modules.some(
        (instance) =>
          instance.moduleId === GITHUB_MODULE_ID &&
          uniqueRepositoryReferences(instance.configuration).length > 0,
      )
    ) {
      return undefined;
    }
    return {
      code: "project.instance-config-invalid",
      severity: "warning",
      message:
        "This active Project was activated before repository identities were persisted. Impact: provider-bound repository operations are paused until the snapshot is refreshed. Action: validate the current selected remotes, then activate again to persist their identities explicitly.",
      target: { kind: "project", field: "/repositories/migration" },
    };
  }

  public resolve(
    snapshot: ResolvedProjectSnapshot,
    configuredReference: string,
  ): RepositoryResolution {
    // Snapshots created before repository identities were persisted cannot be
    // safely migrated from a mutable checkout at use time. Revalidate and
    // reactivate them instead of allowing a changed remote to redirect calls.
    return snapshot.repositoryIdentities === undefined
      ? { status: "identity-unresolved" }
      : resolveStoredRepository(snapshot, configuredReference);
  }

  public identity(
    snapshot: ResolvedProjectSnapshot,
    repositoryId: string | undefined,
  ): ProjectRepositoryIdentity | undefined {
    if (repositoryId === undefined) return undefined;
    const stored = snapshot.repositoryIdentities?.find(
      (repository) => repository.repositoryId === repositoryId,
    );
    if (stored !== undefined) return stored;
    const resolution = this.resolve(snapshot, repositoryId);
    return resolution.status === "resolved" ? resolution.repository : undefined;
  }

  private declaredRepositories(
    configuration: StoredPortableProjectConfiguration,
    repositoryPath: string,
  ): readonly DeclaredRepositoryResolution[] {
    let remotes: ReturnType<typeof readRepositoryRemotes> = [];
    try {
      remotes = readRepositoryRemotes(repositoryPath);
    } catch {
      // The composition validator reports the inaccessible Local Binding. This
      // resolver turns the missing checkout data into a finding instead of
      // allowing activation or provider calls to guess an identity.
    }
    return configuration.repositories.map((repository) => {
      if (remotes.length === 0) {
        return { id: repository.id, result: { status: "remote-missing" } };
      }
      const candidates = remotes.flatMap((remote) => {
        if (remote.urls.length !== 1 || remote.urls[0] === undefined) return [];
        const identity = parseRepositoryRemote(remote.urls[0]);
        return identity.provider === "github" &&
          identity.owner !== undefined &&
          identity.repository !== undefined
          ? [{ remote, owner: identity.owner, name: identity.repository }]
          : [];
      });
      const candidate =
        candidates.find(({ remote }) => remote.name === "origin") ??
        (candidates.length === 1 ? candidates[0] : undefined);
      if (candidate === undefined && candidates.length > 1) {
        return { id: repository.id, result: { status: "remote-ambiguous" } };
      }
      if (candidate === undefined) {
        return {
          id: repository.id,
          result: {
            status: remotes.some((remote) => remote.urls.length !== 1)
              ? "remote-ambiguous"
              : "unsupported-provider",
          },
        };
      }
      return {
        id: repository.id,
        result: {
          status: "resolved",
          repository: {
            repositoryId: repository.id,
            provider: "github",
            owner: candidate.owner,
            name: candidate.name,
          },
        },
      };
    });
  }
}

export function configuredRepositoryReferences(
  configuration: Readonly<Record<string, unknown>> | undefined,
): readonly string[] {
  const repositories = configuration?.["repositories"];
  if (!Array.isArray(repositories)) return [];
  return repositories.filter(
    (repository): repository is string =>
      typeof repository === "string" && repository.trim() !== "",
  );
}

function uniqueRepositoryReferences(
  configuration: Readonly<Record<string, unknown>> | undefined,
): readonly string[] {
  return [...new Set(configuredRepositoryReferences(configuration))];
}

function resolveDeclaredRepository(
  declared: readonly DeclaredRepositoryResolution[],
  configuredReference: string,
): RepositoryResolution {
  const direct = declared.find((repository) => repository.id === configuredReference);
  return direct?.result.status === "resolved"
    ? { status: "resolved", repository: direct.result.repository }
    : (direct?.result ?? { status: "unknown-id" });
}

function resolveStoredRepository(
  snapshot: ResolvedProjectSnapshot,
  configuredReference: string,
): RepositoryResolution {
  const direct = snapshot.composition.repositories.find(
    (repository) => repository.id === configuredReference,
  );
  if (direct !== undefined) {
    const identity = snapshot.repositoryIdentities?.find(
      (repository) => repository.repositoryId === direct.id,
    );
    return identity === undefined
      ? { status: "identity-unresolved" }
      : { status: "resolved", repository: identity };
  }
  return { status: "unknown-id" };
}

function repositoryFinding(
  instanceId: string,
  configuredReference: string,
  resolution: RepositoryResolution,
): ProjectValidationFinding {
  const reference = displayReference(configuredReference);
  if (resolution.status === "resolved") throw new Error("resolved repository has no finding");

  const action =
    resolution.status === "unknown-id"
      ? "Use a repository ID declared by the Project and save the Draft, then validate again."
      : resolution.status === "remote-missing"
        ? "Configure a Git remote for the bound repository, then validate again."
        : resolution.status === "remote-ambiguous"
          ? "Keep one unambiguous GitHub remote identity, then validate again."
          : resolution.status === "unsupported-provider"
            ? "Select a supported GitHub remote or use a Module for the configured provider, then validate again."
            : resolution.status === "identity-unresolved"
              ? "Set the selected remote to a GitHub owner/name remote, then validate again."
              : "Use a repository ID declared by the Project and save the Draft, then validate again.";
  return {
    code: "project.instance-config-invalid",
    severity: "error",
    message: `GitHub Module Instance "${instanceId}" cannot resolve repository reference ${reference}. Impact: GitHub polling, Work Item reads, and Change Request creation are blocked until the repository is linked to this Project. Action: ${action}`,
    target: { kind: "module-instance", instanceId, field: "/configuration/repositories" },
  };
}

function displayReference(reference: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(reference)
    ? `"${reference}"`
    : "the configured repository reference";
}
