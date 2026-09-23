import type { StoredPortableProjectConfiguration, ProjectValidationReport } from "./types.js";
import type { components } from "../api/generated/local-api.js";
import type { PreflightCheck } from "./preflight-types.js";

export type { PreflightCheck, ProjectPreflight } from "./preflight-types.js";

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
  return typeof label === "string" && label.trim() !== ""
    ? {
        moduleInstanceId: instance.instanceId,
        moduleId: "jarvis.module.development",
        readyLabel: label.trim(),
        scope: { kind: "all" },
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
    const pullRequest = enabled.find((module) => module.moduleId === "jarvis.module.pull-request");
    const route = (type: string, producer: string, consumer: string) =>
      validation.requestRoutes.some(
        (item) =>
          item.contract.type === type &&
          item.contract.version === 1 &&
          item.producer.instanceId === producer &&
          item.consumer.instanceId === consumer,
      );
    return (
      enabled.length === 3 &&
      github !== undefined &&
      development !== undefined &&
      pullRequest !== undefined &&
      route(
        "development.implementation.requested",
        development.instanceId,
        development.instanceId,
      ) &&
      route("scm.change-request.creation-requested", pullRequest.instanceId, github.instanceId) &&
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
