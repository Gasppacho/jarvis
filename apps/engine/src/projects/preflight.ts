import type {
  GitHubApi,
  ProjectRepositoryIdentity,
} from "../../../../packages/module-sdk/src/index.js";
import { observeGitHubWorkItemState } from "../../../../packages/modules/github/src/work-item-readiness.js";
import { assessDevelopmentEligibility } from "../../../../packages/modules/development/src/index.js";
import { readCurrentIssues } from "../events/github-polling.js";
import type { StoredPortableProjectConfiguration, ProjectValidationReport } from "./types.js";
import type { components } from "../api/generated/local-api.js";

export type ProjectPreflight = Omit<
  components["schemas"]["ProjectPreflightV1"],
  "validation" | "runtime"
> & {
  readonly validation: ProjectValidationReport;
  readonly runtime: import("../../../../packages/project-runtime/src/project-types.js").ProjectAgentRuntimeChoices;
};
export type PreflightCheck = components["schemas"]["PreflightCheck"];

type PreflightTrigger = NonNullable<components["schemas"]["ProjectPreflightV1"]["trigger"]>;

export function developmentTrigger(
  configuration: StoredPortableProjectConfiguration,
): PreflightTrigger | undefined {
  const instances = configuration.modules.filter(
    (module) => module.enabled && module.moduleId === "jarvis.module.development",
  );
  if (instances.length !== 1) return undefined;
  const instance = instances[0]!;
  const rawLabel = instance.configuration?.["readyLabel"];
  const label = rawLabel === undefined ? "ready-to-dev" : rawLabel;
  const rawScope = instance.configuration?.["scope"];
  const scope: PreflightTrigger["scope"] | undefined =
    rawScope === undefined ||
    (typeof rawScope === "object" &&
      rawScope !== null &&
      !Array.isArray(rawScope) &&
      (rawScope as Record<string, unknown>)["kind"] === "all")
      ? { kind: "all" as const }
      : typeof rawScope === "object" &&
          rawScope !== null &&
          !Array.isArray(rawScope) &&
          (rawScope as Record<string, unknown>)["kind"] === "issue" &&
          typeof (rawScope as Record<string, unknown>)["workItemRef"] === "string"
        ? {
            kind: "issue" as const,
            workItemRef: (rawScope as Record<string, string>)["workItemRef"]!,
          }
        : undefined;
  return typeof label === "string" && label.trim() !== "" && scope !== undefined
    ? {
        moduleInstanceId: instance.instanceId,
        moduleId: "jarvis.module.development",
        readyLabel: label.trim(),
        scope,
      }
    : undefined;
}

/** Recognizes the guide's explanation, not readiness, access or successful commands. */
export function isGitHubDevelopmentFlow(
  configuration: StoredPortableProjectConfiguration,
  validation: ProjectValidationReport,
): boolean {
  if (configuration.compositionMode === "fixed-modules") {
    const enabled = configuration.modules.filter((module) => module.enabled);
    const github = enabled.find((module) => module.moduleId === "jarvis.module.github");
    const development = enabled.find((module) => module.moduleId === "jarvis.module.development");
    const route = (type: string, producer: string, consumer: string) =>
      validation.requestRoutes.some(
        (item) =>
          item.contract.type === type &&
          item.contract.version === 1 &&
          item.producer.instanceId === producer &&
          item.consumer.instanceId === consumer,
      );
    return (
      enabled.length === 2 &&
      github !== undefined &&
      development !== undefined &&
      configuration.workspace.maxConcurrentExecutions === 1 &&
      route(
        "development.implementation.requested",
        development.instanceId,
        development.instanceId,
      ) &&
      route("scm.change-request.creation-requested", development.instanceId, github.instanceId) &&
      validation.requestAttempts !== undefined &&
      !validation.requestAttempts.some(
        (item) => item.contract.type === "scm.change-request.merge-requested",
      )
    );
  }
  return false;
}

export function check(
  id: string,
  title: string,
  passed: boolean,
  impact: string,
  repairStep: PreflightCheck["repairStep"],
): PreflightCheck {
  return { id, title, status: passed ? "passed" : "failed", impact, repairStep };
}

export async function preflightGitHub(input: {
  configuration: StoredPortableProjectConfiguration;
  now: () => number;
  wasAdmitted: (repositoryId: string, workItemRef: string) => boolean;
  repositories: readonly ProjectRepositoryIdentity[];
  apiFor: (slot: string) => GitHubApi | undefined;
}): Promise<Pick<ProjectPreflight, "checks" | "candidateEligibility" | "rule" | "trigger">> {
  const checks: PreflightCheck[] = [];
  const items: ProjectPreflight["candidateEligibility"]["items"] = [];
  if (input.configuration.compositionMode !== "fixed-modules") {
    return {
      checks: [
        check(
          "legacy-configuration",
          "Configuration historique",
          false,
          "Automation Rules est retiré de l’exécution. Cette configuration reste consultable et exportable ; lancez la migration guidée avant toute activation.",
          "Workflow",
        ),
      ],
      candidateEligibility: { status: "unavailable", items },
    };
  }
  const trigger = developmentTrigger(input.configuration);
  const development = input.configuration.modules.find(
    (module) => module.enabled && module.moduleId === "jarvis.module.development",
  );
  const tag = trigger?.readyLabel ?? "";
  const ref = trigger?.scope.kind === "issue" ? trigger.scope.workItemRef : undefined;
  if (development)
    checks.push(
      check(
        "development",
        `Label : ${tag}`,
        tag !== "",
        "Development possède le prédicat de readiness et sa cible. Une issue à la fois.",
        "Workflow",
      ),
    );
  if (development)
    checks.push(
      check(
        "concurrency",
        "Une issue à la fois",
        input.configuration.workspace.maxConcurrentExecutions === 1,
        "Réglez la concurrence du projet à 1.",
        "Workflow",
      ),
    );
  const github = input.configuration.modules.filter(
    (m) => m.enabled && m.moduleId === "jarvis.module.github",
  );
  if (github.length === 0 && development === undefined) {
    return { checks, candidateEligibility: { status: "empty", items } };
  }
  if (github.length !== 1) {
    checks.push(
      check(
        "github",
        "Source GitHub",
        false,
        "Sélectionnez une instance GitHub pour ce workflow.",
        "Workflow",
      ),
    );
    return {
      checks,
      ...(trigger === undefined ? {} : { trigger }),
      candidateEligibility: { status: "unavailable", items },
    };
  }
  const source = github[0]!;
  const sourceApi = input.apiFor("sourceControl");
  const deadline = input.now() + 10_000;
  const api: GitHubApi | undefined = sourceApi && {
    async get(path) {
      if (input.now() >= deadline) throw new Error("Preflight read budget exceeded");
      return sourceApi.get(path);
    },
    async request() {
      throw new Error("Preflight permits GET only");
    },
  };
  if (!api) {
    checks.push(
      check(
        "account",
        "Compte GitHub",
        false,
        "Autorisez un compte GitHub pour ce projet afin de lire les issues et leurs dépendances.",
        "Connections",
      ),
    );
    return {
      checks,
      ...(trigger === undefined ? {} : { trigger }),
      candidateEligibility: { status: "unavailable", items },
    };
  }
  const references = source.configuration?.["repositories"];
  const repositories = input.repositories.filter(
    (r) => Array.isArray(references) && references.includes(r.repositoryId),
  );
  checks.push(
    check(
      "repositories",
      "Dépôt lié",
      repositories.length > 0,
      "Choisissez un remote GitHub accessible dans Repository.",
      "Repository",
    ),
  );
  for (const repository of repositories) {
    const slug = `${repository.owner}/${repository.name}`;
    try {
      const response = await api.get(`/repos/${slug}`);
      const body = response.body as { permissions?: { pull?: boolean; push?: boolean } } | null;
      const accessible =
        response.status === 200 &&
        body?.permissions?.pull === true &&
        (development === undefined || body.permissions.push === true);
      checks.push(
        check(
          `repository:${slug}`,
          `Accès à ${slug}`,
          accessible,
          development
            ? "Le compte lié doit pouvoir lire les issues et pousser une branche dans ce dépôt."
            : "Le compte lié doit pouvoir lire les issues de ce dépôt.",
          "Connections",
        ),
      );
      if (!accessible) continue;
      if (!development) {
        await readCurrentIssues(api, slug);
        checks.push(
          check(
            `issues:${slug}`,
            "Lecture des issues",
            true,
            "GitHub peut observer les issues ; aucun développement n’est configuré.",
            "Connections",
          ),
        );
        continue;
      }
      const label = await api.get(`/repos/${slug}/labels/${encodeURIComponent(tag)}`);
      const labelBody = label.body as { name?: unknown } | null;
      checks.push(
        check(
          `label:${slug}`,
          `Label : ${tag}`,
          label.status === 200 && labelBody?.name === tag,
          `Vérifiez le label ${tag} dans GitHub ou corrigez le label de Development. Jarvis ne crée aucun label.`,
          "Workflow",
        ),
      );
      const candidates = await readCurrentIssues(api, slug);
      for (const candidate of candidates) {
        const workItemRef = `github://${slug}/issues/${candidate.number}`;
        if (typeof ref === "string" && ref !== workItemRef) continue;
        const observation = await observeGitHubWorkItemState({
          api,
          owner: repository.owner,
          repository: repository.name,
          number: candidate.number,
        });
        const alreadyAdmitted = input.wasAdmitted(repository.repositoryId, workItemRef);
        const decision = assessDevelopmentEligibility({
          repositoryId: repository.repositoryId,
          authorizedRepositoryId:
            development?.bindings?.["repository"] === repository.repositoryId
              ? repository.repositoryId
              : undefined,
          workItemRef,
          observation,
          readyLabel: tag,
          scope: trigger?.scope ?? { kind: "all" },
          alreadyStarted: alreadyAdmitted,
        });
        const unavailable = observation.verification === "unavailable";
        const blockerRefs = decision.blockerRefs;
        const reasonCode = decision.reason;
        items.push({
          workItemRef,
          title: candidate.title,
          status: unavailable
            ? "unavailable"
            : decision.eligible && !alreadyAdmitted
              ? "eligible"
              : "ineligible",
          openDependencyCount: blockerRefs.length,
          blockerRefs: [...blockerRefs],
          reason: unavailable
            ? "Impossible de vérifier l’issue ou ses dépendances. Réessayez avant de démarrer."
            : alreadyAdmitted
              ? "Cette issue a déjà été admise ; elle ne redémarrera pas automatiquement."
              : reasonCode === "dependencies-unavailable" ||
                  reasonCode === "dependency-state-unavailable"
                ? "Impossible de lire les dépendances natives. Development attendra."
                : blockerRefs.length > 0
                  ? "Dépendance ouverte : Development attendra."
                  : reasonCode === "work-item-closed"
                    ? "L’issue est fermée. Development ne démarrera pas ; choisissez une issue ouverte."
                    : reasonCode === "ready-label-missing"
                      ? "Le label de readiness a été retiré. Corrigez le label ou choisissez une autre issue."
                      : reasonCode === "work-item-is-pull-request"
                        ? "Cet objet est une Pull Request, pas une issue."
                        : reasonCode === "repository-unlinked"
                          ? "Le dépôt n’est pas autorisé par la configuration Development."
                          : "Aucune dépendance ouverte.",
          repositoryId: repository.repositoryId,
        });
      }
      checks.push(
        check(
          `dependencies:${slug}`,
          "Lecture des dépendances natives",
          items.every(
            (i) => i.repositoryId !== repository.repositoryId || i.status !== "unavailable",
          ),
          candidates.length === 0
            ? "Accès aux issues confirmé ; aucune issue actuelle pour contrôler blocked_by. Chaque candidate sera revérifiée avant admission."
            : "Les dépendances inconnues interdisent le départ. Corrigez les permissions puis relancez le préflight.",
          "Connections",
        ),
      );
    } catch {
      checks.push(
        check(
          `github:${slug}`,
          "Lecture GitHub",
          false,
          "Impossible de vérifier les issues et dépendances. Vérifiez le compte et les permissions puis réessayez.",
          "Connections",
        ),
      );
    }
  }
  return {
    checks,
    ...(trigger === undefined ? {} : { trigger }),
    candidateEligibility: {
      status: checks.some((c) => c.status === "failed")
        ? "unavailable"
        : items.length === 0
          ? "empty"
          : "available",
      items,
    },
  };
}
