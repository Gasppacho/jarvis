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
  | "identity-unresolved"
  | "ambiguous-identity";

export type RepositoryResolution =
  | {
      readonly status: "resolved";
      readonly repository: ProjectRepositoryIdentity;
      readonly legacy: boolean;
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
        return resolution.status === "resolved" && !resolution.legacy
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
      const remote =
        repository.remote === undefined
          ? undefined
          : remotes.find((candidate) => candidate.name === repository.remote);
      if (remote === undefined) {
        return { id: repository.id, result: { status: "remote-missing" } };
      }
      if (remote.urls.length !== 1 || remote.urls[0] === undefined) {
        return { id: repository.id, result: { status: "remote-ambiguous" } };
      }
      const parsed = parseRepositoryRemote(remote.urls[0]);
      if (parsed.provider !== "github") {
        return { id: repository.id, result: { status: "unsupported-provider" } };
      }
      if (parsed.owner === undefined || parsed.repository === undefined) {
        return { id: repository.id, result: { status: "identity-unresolved" } };
      }
      return {
        id: repository.id,
        result: {
          status: "resolved",
          repository: {
            repositoryId: repository.id,
            provider: parsed.provider,
            owner: parsed.owner,
            name: parsed.repository,
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
  if (direct !== undefined) return withLegacy(direct.result, false);

  const legacy = parseLegacyRepositoryReference(configuredReference);
  if (legacy === undefined) return { status: "unknown-id" };
  const matches = matchingDeclaredRepositories(declared, legacy.owner, legacy.repository);
  if (matches.length !== 1) {
    return matches.length === 0 ? { status: "unknown-id" } : { status: "ambiguous-identity" };
  }
  const match = matches[0];
  if (match === undefined) return { status: "unknown-id" };
  return withLegacy(match.result, true);
}

function matchingDeclaredRepositories(
  declared: readonly DeclaredRepositoryResolution[],
  owner: string,
  repository: string,
): readonly DeclaredRepositoryResolution[] {
  return declared.filter(
    (candidate) =>
      candidate.result.status === "resolved" &&
      sameIdentity(candidate.result.repository, owner, repository),
  );
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
      : { status: "resolved", repository: identity, legacy: false };
  }

  const legacy = parseLegacyRepositoryReference(configuredReference);
  if (legacy === undefined) return { status: "unknown-id" };
  const matches = (snapshot.repositoryIdentities ?? []).filter((repository) =>
    sameIdentity(repository, legacy.owner, legacy.repository),
  );
  if (matches.length !== 1) {
    return matches.length === 0 ? { status: "unknown-id" } : { status: "ambiguous-identity" };
  }
  const match = matches[0];
  return match === undefined
    ? { status: "unknown-id" }
    : { status: "resolved", repository: match, legacy: true };
}

function withLegacy(
  result: DeclaredRepositoryResolution["result"],
  legacy: boolean,
): RepositoryResolution {
  return result.status === "resolved"
    ? { status: "resolved", repository: result.repository, legacy }
    : result;
}

function parseLegacyRepositoryReference(
  reference: string,
): { readonly owner: string; readonly repository: string } | undefined {
  const parts = reference
    .trim()
    .replace(/\.git$/i, "")
    .split("/");
  const [owner, repository] = parts;
  return parts.length === 2 &&
    owner !== undefined &&
    repository !== undefined &&
    owner !== "" &&
    repository !== ""
    ? { owner, repository }
    : undefined;
}

function sameIdentity(
  identity: Pick<ProjectRepositoryIdentity, "owner" | "name">,
  owner: string,
  repository: string,
): boolean {
  return (
    identity.owner.toLowerCase() === owner.toLowerCase() &&
    identity.name.toLowerCase() === repository.toLowerCase()
  );
}

function repositoryFinding(
  instanceId: string,
  configuredReference: string,
  resolution: RepositoryResolution,
): ProjectValidationFinding {
  const reference = displayReference(configuredReference);
  if (resolution.status === "resolved") {
    return {
      code: "project.instance-config-invalid",
      severity: "warning",
      message: `GitHub Module Instance "${instanceId}" uses historical repository reference ${reference}. Impact: compatibility resolution targets portable repository ID "${resolution.repository.repositoryId}". Action: replace it with that portable repository ID and save the Draft; the committed .jarvis/project.yaml changes only when you explicitly write it.`,
      target: {
        kind: "module-instance",
        instanceId,
        field: "/configuration/repositories/legacy",
      },
      repositoryReferenceReplacement: {
        field: "/configuration/repositories",
        from: configuredReference,
        to: resolution.repository.repositoryId,
      },
    };
  }

  const action =
    resolution.status === "unknown-id"
      ? "Use a repository ID declared by the Project and save the Draft, then validate again."
      : resolution.status === "remote-missing"
        ? "Configure the declared remote for the bound repository, then validate again."
        : resolution.status === "remote-ambiguous"
          ? "Configure the selected Git remote with exactly one URL, then validate again."
          : resolution.status === "unsupported-provider"
            ? "Select a supported GitHub remote or use a Module for the configured provider, then validate again."
            : resolution.status === "identity-unresolved"
              ? "Set the selected remote to a GitHub owner/name remote, then validate again."
              : "Replace this historical reference with the unique declared portable repository ID, then validate again.";
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
