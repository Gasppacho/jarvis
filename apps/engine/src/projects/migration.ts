import type {
  ProjectBindings,
  PortableProjectConfiguration,
  StoredPortableProjectConfiguration,
} from "./types.js";

export interface MigrationReason {
  readonly code: string;
  readonly message: string;
}
export type GuidedMigrationScope =
  { readonly kind: "all" } | { readonly kind: "issue"; readonly workItemRef: string };
export interface GuidedMigrationPlan {
  readonly preserved: {
    readonly projectId: string;
    readonly moduleInstanceIds: readonly string[];
    readonly repositoryIds: readonly string[];
    readonly remotes: Readonly<Record<string, string | null>>;
    readonly branches: Readonly<Record<string, string | null>>;
    readonly commands: Readonly<Record<string, string>>;
    readonly git: PortableProjectConfiguration["git"] | StoredPortableProjectConfiguration["git"];
    readonly workspace: PortableProjectConfiguration["workspace"];
    readonly bindings: ProjectBindings;
    readonly readyLabel: string;
    readonly scope: GuidedMigrationScope;
  };
  readonly removedModule: "jarvis.module.automation-rules";
  readonly destination: {
    readonly modules: readonly ["jarvis.module.github", "jarvis.module.development"];
    readonly compositionMode: "fixed-modules";
    readonly readyLabel: string;
    readonly scope: GuidedMigrationScope;
  };
}

const keys = (value: object) => Object.keys(value).sort();
const exactKeys = (value: object, expected: readonly string[]) =>
  JSON.stringify(keys(value)) === JSON.stringify([...expected].sort());

export function classifyGuidedMigration(
  configuration: StoredPortableProjectConfiguration,
  bindings: ProjectBindings,
): { readonly plan?: GuidedMigrationPlan; readonly reasons: readonly MigrationReason[] } {
  const reasons: MigrationReason[] = [];
  if (configuration.compositionMode === "fixed-modules")
    reasons.push({ code: "already-fixed", message: "Le projet utilise déjà la composition fixe." });
  if (configuration.modules.length !== 3)
    reasons.push({
      code: "module-count",
      message: "D06 exige exactement GitHub, Automation Rules et Development.",
    });
  const enabled = configuration.modules.filter((module) => module.enabled);
  if (enabled.length !== 3)
    reasons.push({
      code: "disabled-module",
      message: "D06 exige que les trois instances historiques soient activées.",
    });
  const github = configuration.modules.filter(
    (module) => module.moduleId === "jarvis.module.github",
  );
  const rules = configuration.modules.filter(
    (module) => module.moduleId === "jarvis.module.automation-rules",
  );
  const development = configuration.modules.filter(
    (module) => module.moduleId === "jarvis.module.development",
  );
  if (github.length !== 1 || rules.length !== 1 || development.length !== 1)
    reasons.push({
      code: "module-instances",
      message: "D06 refuse toute autre instance ou plusieurs instances d’un module.",
    });
  if (reasons.length > 0) return { reasons };
  const githubInstance = github[0]!;
  const rulesInstance = rules[0]!;
  const developmentInstance = development[0]!;
  const rawRules = rulesInstance.configuration?.["rules"];
  if (!Array.isArray(rawRules) || rawRules.length !== 1)
    reasons.push({ code: "rule-count", message: "D06 exige une seule règle historique." });
  const rule = Array.isArray(rawRules) ? rawRules[0] : undefined;
  const when =
    typeof rule === "object" && rule !== null
      ? (rule as Record<string, unknown>)["when"]
      : undefined;
  const emit =
    typeof rule === "object" && rule !== null
      ? (rule as Record<string, unknown>)["emit"]
      : undefined;
  const equals =
    typeof when === "object" && when !== null
      ? (when as Record<string, unknown>)["equals"]
      : undefined;
  const target =
    typeof emit === "object" && emit !== null
      ? (emit as Record<string, unknown>)["target"]
      : undefined;
  const tag =
    typeof equals === "object" && equals !== null
      ? (equals as Record<string, unknown>)["payload.tag"]
      : undefined;
  const workItemRef =
    typeof equals === "object" && equals !== null
      ? (equals as Record<string, unknown>)["payload.workItemRef"]
      : undefined;
  if (typeof rule !== "object" || rule === null || !exactKeys(rule, ["id", "when", "emit"]))
    reasons.push({
      code: "rule-shape",
      message: "La règle historique contient une clé supplémentaire ou manque une clé D06.",
    });
  if (
    typeof when !== "object" ||
    when === null ||
    !exactKeys(when, ["eventType", "equals"]) ||
    (when as Record<string, unknown>)["eventType"] !== "scm.work-item.ready"
  )
    reasons.push({
      code: "unknown-condition",
      message: "La condition doit être exactement scm.work-item.ready.",
    });
  if (
    typeof equals !== "object" ||
    equals === null ||
    !exactKeys(
      equals,
      workItemRef === undefined ? ["payload.tag"] : ["payload.tag", "payload.workItemRef"],
    ) ||
    typeof tag !== "string" ||
    tag.trim() === "" ||
    (workItemRef !== undefined && (typeof workItemRef !== "string" || workItemRef.trim() === ""))
  )
    reasons.push({
      code: "condition-shape",
      message: "La seule condition admise est payload.tag avec une valeur non vide.",
    });
  if (
    typeof emit !== "object" ||
    emit === null ||
    !exactKeys(emit, ["type", "target"]) ||
    (emit as Record<string, unknown>)["type"] !== "development.implementation.requested"
  )
    reasons.push({
      code: "emission-shape",
      message: "L’émission doit être exactement la demande Development sans payload statique.",
    });
  if (
    typeof target !== "object" ||
    target === null ||
    !exactKeys(target, ["moduleInstanceId"]) ||
    (target as Record<string, unknown>)["moduleInstanceId"] !== developmentInstance.instanceId
  )
    reasons.push({
      code: "target",
      message: "La cible doit être exactement l’instance Development configurée.",
    });
  const readyLabel = githubInstance.configuration?.["readyLabel"];
  if (typeof readyLabel !== "string" || readyLabel.trim() === "" || readyLabel.trim() !== tag)
    reasons.push({
      code: "label-mismatch",
      message: "Le label de GitHub doit être identique à payload.tag.",
    });
  if (reasons.length > 0) return { reasons };
  const label = readyLabel as string;
  const scope: GuidedMigrationScope =
    typeof workItemRef === "string"
      ? { kind: "issue", workItemRef: workItemRef.trim() }
      : { kind: "all" };
  return {
    reasons,
    plan: {
      preserved: {
        projectId: configuration.metadata.id,
        moduleInstanceIds: configuration.modules.map((module) => module.instanceId),
        repositoryIds: configuration.repositories.map((repository) => repository.id),
        remotes: Object.fromEntries(
          configuration.repositories.map((repository) => [
            repository.id,
            repository.remote ?? null,
          ]),
        ),
        branches: Object.fromEntries(
          configuration.repositories.map((repository) => [
            repository.id,
            repository.defaultBranch ?? null,
          ]),
        ),
        commands: configuration.commands,
        git: configuration.git,
        workspace: configuration.workspace,
        bindings,
        readyLabel: label,
        scope,
      },
      removedModule: "jarvis.module.automation-rules",
      destination: {
        modules: ["jarvis.module.github", "jarvis.module.development"],
        compositionMode: "fixed-modules",
        readyLabel: label,
        scope,
      },
    },
  };
}

export function migratedConfiguration(
  configuration: StoredPortableProjectConfiguration,
  plan: GuidedMigrationPlan,
): PortableProjectConfiguration {
  const github = configuration.modules.find(
    (module) => module.moduleId === "jarvis.module.github",
  )!;
  const development = configuration.modules.find(
    (module) => module.moduleId === "jarvis.module.development",
  )!;
  const { readyLabel: _legacyReadyLabel, ...githubConfiguration } = github.configuration ?? {};
  return {
    ...configuration,
    compositionMode: "fixed-modules",
    modules: [
      { ...github, configuration: githubConfiguration },
      {
        ...development,
        configuration: {
          ...development.configuration,
          readyLabel: plan.destination.readyLabel,
          scope: plan.destination.scope,
        },
      },
    ],
  } as PortableProjectConfiguration;
}
