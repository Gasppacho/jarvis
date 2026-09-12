import { constants, accessSync, statSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import {
  filteredEnvironment,
  secretEnvironmentValues,
} from "../../../../packages/agent-runtime/src/request-builder.js";
import type { LocalAgentRuntimeRegistry } from "./resource-grants.js";
import type { RuntimeDescriptor } from "../../../../packages/agent-runtime/src/types.js";
import type {
  ProjectAgentRuntimeChoices,
  ProjectResourceBindingChoice,
  ProjectRuntimeReadiness,
  StoredPortableProjectConfiguration,
} from "../../../../packages/project-runtime/src/project-types.js";
import type { ProjectRow } from "./store.js";

export function runtimeReadiness(
  status: ProjectRuntimeReadiness["status"],
  detail: string,
  checkedAt: string | null = null,
): ProjectRuntimeReadiness {
  return { status, detail, checkedAt };
}

export function runtimeSlots(
  configuration: StoredPortableProjectConfiguration,
  slots: readonly ProjectResourceBindingChoice[],
): readonly ProjectResourceBindingChoice[] {
  return slots.filter((slot) =>
    configuration.modules.some(
      (instance) => instance.enabled && instance.runtimeSlot === slot.slotId,
    ),
  );
}

export function projectAgentRuntimeChoices(
  project: ProjectRow,
  configuration: StoredPortableProjectConfiguration,
  slots: readonly ProjectResourceBindingChoice[],
  descriptors: readonly RuntimeDescriptor[],
): ProjectAgentRuntimeChoices {
  const requiredSlots = runtimeSlots(configuration, slots);
  const items = descriptors
    .filter((descriptor) => descriptor.provider === "codex")
    .map((descriptor) => {
      const missingCapabilities = [
        ...new Set(requiredSlots.flatMap((slot) => slot.requiredCapabilities)),
      ].filter((capability) => !descriptor.capabilities.includes(capability));
      const compatible = missingCapabilities.length === 0 && requiredSlots.length > 0;
      const status =
        !compatible || descriptor.status === "degraded"
          ? "incompatible"
          : descriptor.status === "unauthenticated"
            ? "access-denied"
            : descriptor.status === "unavailable"
              ? unavailableStatus(descriptor.executablePath)
              : "unchecked";
      return {
        ref: descriptor.id,
        displayName: safeName(descriptor.displayName),
        provider: descriptor.provider,
        version:
          descriptor.version !== null && /^\d+\.\d+\.\d+$/.test(descriptor.version)
            ? descriptor.version
            : null,
        capabilities: [...descriptor.capabilities],
        bound: requiredSlots.some(
          (slot) =>
            project.slotBindings[slot.slotId]?.kind === "runtime" &&
            project.slotBindings[slot.slotId]?.ref === descriptor.id,
        ),
        selectable: compatible && descriptor.status === "available",
        readiness: runtimeReadiness(
          status,
          missingCapabilities.length > 0
            ? `Capabilities manquantes : ${missingCapabilities.join(", ")}. Choisissez un runtime compatible.`
            : status === "incompatible"
              ? "La version ou le workflow est incompatible. Choisissez un runtime compatible ou configurez le workflow."
              : status === "access-denied"
                ? "Autorisez la connexion locale Codex, puis relancez la découverte."
                : status === "absent"
                  ? "Installez ou activez Codex avec les instructions locales, puis relancez la découverte."
                  : status === "engine-error"
                    ? "Le contrôle du candidat n’a pas abouti. Vérifiez Codex localement, puis relancez la découverte."
                    : "La découverte ne vérifie pas les accès de ce projet. Choisissez puis vérifiez le runtime.",
        ),
      };
    })
    .sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) ||
        (left.version ?? "").localeCompare(right.version ?? ""),
    );
  return {
    required: requiredSlots.length > 0,
    items,
    readiness: runtimeReadiness(
      items.length === 0 ? "absent" : "unchecked",
      items.length === 0
        ? "Aucun runtime Codex découvert. Installez ou activez Codex avec les instructions locales, puis relancez la découverte."
        : "Choisissez explicitement un runtime et vérifiez ses accès pour ce projet.",
    ),
  };
}

/** Same descriptor and filtering as Development; probes never call runtime.start. */
export async function checkProjectRuntimeReadiness(
  project: ProjectRow,
  slots: readonly ProjectResourceBindingChoice[],
  runtimes: LocalAgentRuntimeRegistry,
): Promise<ProjectRuntimeReadiness> {
  const checkedAt = new Date().toISOString();
  const deadline = Date.now() + 10_000;
  const verifiedProfiles = new Set<string>();
  const result = (status: ProjectRuntimeReadiness["status"], detail: string) =>
    runtimeReadiness(status, detail, checkedAt);
  const requiredSlots = runtimeSlots(project.portableConfig, slots);
  if (requiredSlots.length === 0)
    return result(
      "unchecked",
      "Configurez un workflow qui utilise un runtime avant de le vérifier.",
    );
  for (const slot of requiredSlots) {
    const binding = project.slotBindings[slot.slotId];
    if (binding?.kind !== "runtime")
      return result(
        "unchecked",
        "Choisissez explicitement un runtime et autorisez son profil local pour ce projet.",
      );
    const descriptor = runtimes.descriptor(project.id, binding.ref);
    if (descriptor?.provider !== "codex" || descriptor.executablePath === null) {
      return result(
        "absent",
        "Le runtime choisi est absent. Installez ou activez Codex avec les instructions locales, ou choisissez un autre runtime.",
      );
    }
    try {
      const file = await stat(descriptor.executablePath);
      if (!file.isFile())
        return result(
          "absent",
          "Le runtime choisi est absent. Relancez la découverte ou choisissez un autre runtime.",
        );
      await access(descriptor.executablePath, constants.X_OK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "EACCES" || code === "EPERM"
        ? result(
            "access-denied",
            "L’exécution de Codex est refusée. Corrigez l’autorisation locale ou choisissez un autre runtime.",
          )
        : result(
            "absent",
            "Le runtime choisi est absent. Relancez la découverte ou choisissez un autre runtime.",
          );
    }
    const missing = slot.requiredCapabilities.filter(
      (capability) => !descriptor.capabilities.includes(capability),
    );
    if (missing.length > 0)
      return result(
        "incompatible",
        `Capabilities manquantes : ${missing.join(", ")}. Choisissez un runtime compatible.`,
      );
    const consumers = project.portableConfig.modules.filter(
      (instance) => instance.enabled && instance.runtimeSlot === slot.slotId,
    );
    if (consumers.length === 0)
      return result(
        "unchecked",
        "Configurez le workflow utilisant ce runtime avant de vérifier son profil.",
      );
    for (const instance of consumers) {
      const raw = instance.configuration?.["environmentAllowlist"];
      const allowlist = Array.isArray(raw)
        ? raw.filter((name): name is string => typeof name === "string")
        : [];
      const environment = filteredEnvironment(
        binding.environment ?? {},
        allowlist,
        secretEnvironmentValues(process.env),
      );
      if (!environment["PATH"]?.trim())
        return result(
          "access-denied",
          "Le profil d’outils n’est pas autorisé. Autorisez PATH dans le workflow et choisissez à nouveau le runtime pour confirmer son profil local.",
        );
      const profileKey = JSON.stringify([descriptor.id, descriptor.executablePath, environment]);
      if (verifiedProfiles.has(profileKey)) continue;
      if (Date.now() >= deadline)
        return result(
          "engine-error",
          "La vérification a atteint sa limite de temps. Réessayez après avoir vérifié les runtimes locaux.",
        );
      try {
        const runtime = runtimes.resolve(project.id, binding.ref);
        if (runtime === undefined)
          return result(
            descriptor.status === "degraded" ? "incompatible" : "access-denied",
            "Le runtime n’est plus disponible. Corrigez sa version ou sa connexion locale, puis relancez la découverte.",
          );
        const observed = await runtime.describe(environment);
        if (observed.status === "unauthenticated")
          return result(
            "access-denied",
            "Codex ne peut pas utiliser sa connexion dans ce projet. Autorisez son contexte local, reconnectez Codex puis réessayez.",
          );
        if (observed.status === "degraded")
          return result(
            "incompatible",
            "La version de Codex n’est pas compatible avec le protocole attendu. Choisissez une version compatible, puis relancez la découverte.",
          );
        if (observed.status !== "available")
          return result(
            "engine-error",
            "Le contrôle du runtime n’a pas abouti dans le délai prévu. Vérifiez Codex localement ou choisissez un autre runtime, puis réessayez.",
          );
        if (
          !slot.requiredCapabilities.every((capability) =>
            observed.capabilities.includes(capability),
          )
        )
          return result(
            "incompatible",
            "Le runtime ne fournit plus les capabilities requises. Choisissez un runtime compatible.",
          );
        verifiedProfiles.add(profileKey);
      } catch {
        return result(
          "engine-error",
          "Le moteur n’a pas pu vérifier le runtime. Réessayez après avoir vérifié la connexion au moteur.",
        );
      }
    }
  }
  return result(
    "ready",
    "Le runtime et son profil local sont prêts pour Development dans ce projet.",
  );
}

function unavailableStatus(path: string | null): ProjectRuntimeReadiness["status"] {
  if (path === null) return "absent";
  try {
    if (!statSync(path).isFile()) return "absent";
    accessSync(path, constants.X_OK);
    return "engine-error";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM" ? "access-denied" : "absent";
  }
}

function safeName(value: string): string {
  return value.length <= 100 &&
    /^[\p{L}\p{N} ._—–()-]+$/u.test(value) &&
    !/(?:github_pat_|gh[opsu]_|sk-|token|password|secret)/i.test(value)
    ? value
    : "Codex";
}
