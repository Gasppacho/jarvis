import type {
  GitHubApi,
  ProjectRepositoryIdentity,
} from "../../../../packages/module-sdk/src/index.js";
import { assessGitHubWorkItemReadiness } from "../../../../packages/modules/github/src/work-item-readiness.js";
import {
  readRules,
  matchesRuleEvent,
} from "../../../../packages/modules/automation-rules/src/index.js";
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

// The guided trial is safe only when there is one admission rule. An expert
// composition remains editable; preflight explains why it cannot narrow it safely.
export function workflowRule(configuration: StoredPortableProjectConfiguration) {
  const instances = configuration.modules.filter(
    (m) => m.enabled && m.moduleId === "jarvis.module.automation-rules",
  );
  const rules = instances.flatMap((instance) =>
    readRules(instance.configuration ?? {}).map((rule) => ({ instance, rule })),
  );
  if (rules.length !== 1) throw new Error("Select one readable Development admission rule.");
  const selected = rules[0]!;
  const tag = selected.rule.when.equals?.["payload.tag"];
  if (
    typeof tag !== "string" ||
    !tag.trim() ||
    tag === "blocked" ||
    selected.rule.when.eventType !== "scm.work-item.ready"
  )
    throw new Error("The readiness label or rule is unreadable.");
  if (
    ["workItemRef", "repositoryId", "tag", "baseBranch"].some((key) =>
      Object.hasOwn(selected.rule.emit.payload ?? {}, key),
    )
  )
    throw new Error("Static emission overrides cannot be safely narrowed.");
  return { ...selected, tag };
}

/** Recognizes the guide's explanation, not readiness, access or successful commands. */
export function isGitHubDevelopmentFlow(
  configuration: StoredPortableProjectConfiguration,
  validation: ProjectValidationReport,
): boolean {
  try {
    const { instance, rule, tag } = workflowRule(configuration);
    const enabled = configuration.modules.filter((module) => module.enabled);
    const github = enabled.find((module) => module.moduleId === "jarvis.module.github");
    const development = enabled.find((module) => module.moduleId === "jarvis.module.development");
    if (
      enabled.length !== 3 ||
      !github ||
      !development ||
      configuration.workspace.maxConcurrentExecutions !== 1 ||
      (github.configuration?.["readyLabel"] ?? "ready-for-agent") !== tag ||
      rule.emit.type !== "development.implementation.requested"
    )
      return false;
    const route = (type: string, producer: string, consumer: string) =>
      validation.requestRoutes.some(
        (item) =>
          item.contract.type === type &&
          item.contract.version === 1 &&
          item.producer.instanceId === producer &&
          item.consumer.instanceId === consumer,
      );
    return (
      route("development.implementation.requested", instance.instanceId, development.instanceId) &&
      route("scm.change-request.creation-requested", development.instanceId, github.instanceId) &&
      validation.requestAttempts !== undefined &&
      !validation.requestAttempts.some(
        (item) => item.contract.type === "scm.change-request.merge-requested",
      )
    );
  } catch {
    return false;
  }
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
}): Promise<Pick<ProjectPreflight, "checks" | "candidateEligibility" | "rule">> {
  const checks: PreflightCheck[] = [];
  const items: ProjectPreflight["candidateEligibility"]["items"] = [];
  let selected: ReturnType<typeof workflowRule>;
  try {
    selected = workflowRule(input.configuration);
  } catch {
    return {
      checks: [
        check(
          "rule",
          "Règle et label de readiness",
          false,
          "Dans Workflow, choisissez le fait scm.work-item.ready avec le label actuel, une règle Development unique et une identité dérivée de l’issue. Les déclencheurs historiques et émissions statiques restent conservés mais ne permettent pas cet essai guidé.",
          "Workflow",
        ),
      ],
      candidateEligibility: { status: "unavailable", items },
    };
  }
  const { rule, instance, tag } = selected;
  const ref = rule.when.equals?.["payload.workItemRef"];
  const ruleSummary: NonNullable<ProjectPreflight["rule"]> = {
    instanceId: instance.instanceId,
    ruleId: rule.id,
    label: tag,
    selectedWorkItemRef: typeof ref === "string" ? ref : null,
  };
  checks.push(
    check(
      "rule",
      `Label : ${tag}`,
      true,
      "La règle conserve ses prédicats et sa cible. Une issue à la fois.",
      "Workflow",
    ),
  );
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
    return { checks, rule: ruleSummary, candidateEligibility: { status: "unavailable", items } };
  }
  const source = github[0]!;
  const readyLabel = source.configuration?.["readyLabel"] ?? "ready-for-agent";
  if (rule.when.eventType === "scm.work-item.ready")
    checks.push(
      check(
        "source-label",
        "Label collecté",
        readyLabel === tag,
        `Le label collecté (${String(readyLabel)}) doit correspondre à la règle (${tag}).`,
        "Workflow",
      ),
    );
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
    return { checks, rule: ruleSummary, candidateEligibility: { status: "unavailable", items } };
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
        body.permissions.push === true;
      checks.push(
        check(
          `repository:${slug}`,
          `Accès à ${slug}`,
          accessible,
          "Le compte lié doit pouvoir lire les issues et pousser une branche dans ce dépôt.",
          "Connections",
        ),
      );
      if (!accessible) continue;
      const label = await api.get(`/repos/${slug}/labels/${encodeURIComponent(tag)}`);
      const labelBody = label.body as { name?: unknown } | null;
      checks.push(
        check(
          `label:${slug}`,
          `Label : ${tag}`,
          label.status === 200 && labelBody?.name === tag,
          `Vérifiez le label ${tag} dans GitHub ou corrigez la règle. Jarvis ne crée aucun label.`,
          "Workflow",
        ),
      );
      const candidates = await readCurrentIssues(api, slug);
      for (const candidate of candidates) {
        if (!candidate.labels.includes(tag)) continue;
        const workItemRef = `github://${slug}/issues/${candidate.number}`;
        if (typeof ref === "string" && ref !== workItemRef) continue;
        const assessment = await assessGitHubWorkItemReadiness({
          api,
          owner: repository.owner,
          repository: repository.name,
          number: candidate.number,
          tag,
        });
        const payload: Record<string, unknown> = {
          repositoryId: repository.repositoryId,
          workItemRef,
          issueProvider: "github",
          tag,
        };
        const matches = matchesRuleEvent(rule, {
          kind: "fact",
          type: rule.when.eventType,
          payload,
        });
        const alreadyAdmitted = input.wasAdmitted(repository.repositoryId, workItemRef);
        items.push({
          workItemRef,
          title: candidate.title,
          status:
            assessment.status === "impossible"
              ? "unavailable"
              : assessment.status === "ready" && matches && !alreadyAdmitted
                ? "eligible"
                : "ineligible",
          openDependencyCount: assessment.blockerRefs.length,
          blockerRefs: [...assessment.blockerRefs],
          reason: alreadyAdmitted
            ? "Cette issue a déjà été admise ; elle ne redémarrera pas automatiquement."
            : assessment.status === "impossible"
              ? "Impossible de lire les dépendances natives. Development attendra."
              : assessment.blockerRefs.length > 0
                ? "Dépendance ouverte : Development attendra."
                : assessment.reason === "work-item-closed"
                  ? "L’issue est fermée. Development ne démarrera pas ; choisissez une issue ouverte."
                  : assessment.reason === "ready-label-missing"
                    ? "Le label de readiness a été retiré. Corrigez le label ou choisissez une autre issue."
                    : assessment.reason === "work-item-is-pull-request"
                      ? "Cet objet est une Pull Request, pas une issue."
                      : !matches
                        ? "Les autres prédicats de la règle ne correspondent pas."
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
    rule: ruleSummary,
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
