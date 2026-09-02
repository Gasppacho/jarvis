import type {
  PortableProjectConfiguration,
  ProjectCompositionChoices,
  ProjectCompositionChoiceInstance,
  ProjectCompositionModuleInstance,
  ProjectCompositionModulePackage,
  ProjectModuleInstanceConfiguration,
  ProjectSlotBinding,
  ProjectValidationFinding,
  StoredPortableProjectConfiguration,
} from "./project-types.js";
import type {
  ProjectModuleContractDescriptor,
  ProjectModulePackageValidationPort,
} from "./composition-validator.js";

interface EventContractMetadata {
  readonly label: string;
  readonly description: string;
  readonly payloadSchema: Readonly<Record<string, unknown>>;
}

export interface ProjectCompositionChoicePackagePort extends ProjectModulePackageValidationPort {
  eventContract(schemaRef: string): EventContractMetadata;
  catalog(): readonly ProjectCompositionModulePackage[];
}

export interface ProjectCompositionChoiceInput {
  readonly projectId: string;
  readonly configuration: StoredPortableProjectConfiguration;
  readonly slotBindings: Readonly<Record<string, ProjectSlotBinding>>;
  readonly validationFindings?: readonly ProjectValidationFinding[];
}

interface Declaration {
  readonly instance: ProjectModuleInstanceConfiguration;
  readonly contract: ProjectModuleContractDescriptor;
}

export function previewProjectCompositionChoices(
  modules: ProjectCompositionChoicePackagePort,
  input: ProjectCompositionChoiceInput,
): ProjectCompositionChoices {
  const enabled = input.configuration.modules.filter((instance) => instance.enabled);
  const producers = declarations(enabled, modules, "produces");
  const consumers = declarations(enabled, modules, "consumes");
  const contracts = uniqueContracts([...producers, ...consumers]);

  const choices = contracts.map((contract) => {
    const metadata = modules.eventContract(contract.schemaRef);
    const declaringProducers = producers.filter((item) => compatible(item.contract, contract));
    const sameTypeConsumers = consumers.filter((item) => item.contract.type === contract.type);
    const compatibleConsumers = sameTypeConsumers.filter((item) =>
      compatible(item.contract, contract),
    );
    const producerTargets = declaringProducers.flatMap(({ instance }) =>
      routedConsumers(modules, instance, contract, compatibleConsumers, input.slotBindings),
    );
    const routableConsumers = uniqueInstances(
      declaringProducers.length === 0
        ? compatibleConsumers.map(({ instance }) => instance)
        : producerTargets,
    );

    return {
      ...metadata,
      type: contract.type,
      version: contract.version,
      kind: contract.kind,
      producers: uniqueInstances(declaringProducers.map(({ instance }) => instance)),
      consumers: uniqueConsumers(sameTypeConsumers, contract),
      routing:
        contract.kind === "fact"
          ? {
              status: "broadcast" as const,
              explanation: `Facts may be delivered to zero or many compatible consumers (${compatibleConsumers.length} available).`,
            }
          : requestRouting(routableConsumers),
    };
  });

  choices.sort((left, right) =>
    contractKey(left) < contractKey(right) ? -1 : contractKey(left) > contractKey(right) ? 1 : 0,
  );
  return {
    apiVersion: "jarvis.dev/project-composition-choices/v1",
    kind: "ProjectCompositionChoices",
    projectId: input.projectId,
    startingPoints: startingPoints(input.configuration),
    modulePackages: [...modules.catalog()].sort(compareJson),
    moduleInstances: moduleInstances(input.configuration, input.validationFindings ?? [], modules),
    choices,
  };
}

function startingPoints(configuration: StoredPortableProjectConfiguration) {
  return [
    {
      id: "github-development" as const,
      displayName: "GitHub Development",
      description:
        "Start from GitHub intake, Automation Rules, and an isolated Development Module Instance.",
      template: githubDevelopmentTemplate(configuration),
    },
    {
      id: "custom" as const,
      displayName: "Custom composition",
      description: "Keep the imported Project details and choose each Module Instance yourself.",
    },
  ];
}

function githubDevelopmentTemplate(
  base: StoredPortableProjectConfiguration,
): PortableProjectConfiguration {
  const repository = base.repositories[0];
  return {
    ...base,
    repositories: [
      {
        id: "main",
        root: ".",
        defaultBranch: repository?.defaultBranch ?? "main",
        remote: repository?.remote ?? "origin",
      },
    ],
    slots: {
      agentRuntime: { requires: "agent.execute" },
      sourceControl: { requires: "scm.change-request.manage" },
      tickets: { requires: "work-items.read" },
    },
    modules: [
      {
        instanceId: "github",
        moduleId: "jarvis.module.github",
        enabled: true,
        bindings: { sourceControl: "sourceControl", tickets: "tickets" },
        configuration: {
          bootstrapLabelPolicy: "ignore-existing",
          pollIntervalSeconds: 60,
          repositories: ["main"],
        },
      },
      {
        instanceId: "automation-rules",
        moduleId: "jarvis.module.automation-rules",
        enabled: true,
        configuration: {
          rules: [
            {
              id: "ready-label-starts-development",
              when: {
                eventType: "scm.work-item.tag-added",
                equals: { "payload.tag": "agent:ready" },
              },
              emit: {
                type: "development.implementation.requested",
                target: { moduleInstanceId: "development" },
              },
            },
          ],
        },
      },
      {
        instanceId: "development",
        moduleId: "jarvis.module.development",
        enabled: true,
        runtimeSlot: "agentRuntime",
        bindings: {
          tickets: "tickets",
          repository: "main",
          sourceControl: "sourceControl",
        },
        configuration: {
          validationOrder: ["lint", "typecheck", "test", "build"],
          maxRepairCycles: 2,
          retainWorkspaceOnSuccess: false,
        },
      },
    ],
  };
}

function moduleInstances(
  configuration: StoredPortableProjectConfiguration,
  validationFindings: readonly ProjectValidationFinding[],
  modules: ProjectCompositionChoicePackagePort,
): ProjectCompositionModuleInstance[] {
  return configuration.modules
    .map((instance) => {
      const modulePackage = modules.package(instance.moduleId) as
        ProjectCompositionModulePackage | undefined;
      if (modulePackage === undefined) {
        return {
          instanceId: instance.instanceId,
          moduleId: instance.moduleId,
          enabled: instance.enabled,
          version: "Unavailable",
          displayName: "Unavailable Module Package",
          description: "This Module Package is not available in the bundled catalogue.",
          consumes: [],
          produces: [],
          requiredCapabilities: [],
          compatibility: "incompatible" as const,
          missingResources: [],
        };
      }
      const validation = modules.validateConfiguration(
        instance.moduleId,
        instance.configuration ?? {},
      );
      const missingResources = validationFindings
        .flatMap((finding) =>
          finding.target.kind === "capability" &&
          "instanceId" in finding.target &&
          finding.target.instanceId === instance.instanceId
            ? [finding.target.capability]
            : [],
        )
        .sort();
      return {
        instanceId: instance.instanceId,
        moduleId: instance.moduleId,
        enabled: instance.enabled,
        version: modulePackage.version,
        displayName: modulePackage.displayName,
        description: modulePackage.description,
        consumes: modulePackage.consumes,
        produces: modulePackage.produces,
        requiredCapabilities: modulePackage.requires,
        compatibility:
          validation.issues.length === 0 ? ("compatible" as const) : ("incompatible" as const),
        missingResources,
      };
    })
    .sort(compareJson);
}

function declarations(
  instances: readonly ProjectModuleInstanceConfiguration[],
  modules: ProjectCompositionChoicePackagePort,
  direction: "consumes" | "produces",
): Declaration[] {
  return instances.flatMap((instance) =>
    (modules.composition(instance.moduleId)?.[direction] ?? []).map((contract) => ({
      instance,
      contract,
    })),
  );
}

function uniqueContracts(
  declarationsToIndex: readonly Declaration[],
): ProjectModuleContractDescriptor[] {
  const contracts = new Map<string, ProjectModuleContractDescriptor>();
  for (const { contract } of declarationsToIndex) {
    contracts.set(contractKey(contract), contract);
  }
  return [...contracts.values()].sort(compareJson);
}

function routedConsumers(
  modules: ProjectCompositionChoicePackagePort,
  producer: ProjectModuleInstanceConfiguration,
  contract: ProjectModuleContractDescriptor,
  consumers: readonly Declaration[],
  slotBindings: Readonly<Record<string, ProjectSlotBinding>>,
): ProjectModuleInstanceConfiguration[] {
  if (contract.kind === "fact") return consumers.map(({ instance }) => instance);
  const targets = modules.configuredRequestTargets(
    producer.moduleId,
    producer.configuration,
    contract,
  );
  if (targets === undefined) return consumers.map(({ instance }) => instance);
  return targets.flatMap((target) => {
    if (target.moduleInstanceId !== undefined) {
      return consumers
        .filter(({ instance }) => instance.instanceId === target.moduleInstanceId)
        .map(({ instance }) => instance);
    }
    const portableSlot = producer.bindings?.[target.binding ?? ""] ?? target.binding ?? "";
    const binding = slotBindings[portableSlot];
    if (binding?.kind !== "module-instance") return [];
    return consumers
      .filter(({ instance }) => instance.instanceId === binding.ref)
      .map(({ instance }) => instance);
  });
}

function requestRouting(consumers: readonly ProjectCompositionChoiceInstance[]) {
  if (consumers.length === 1) {
    return {
      status: "resolved" as const,
      selectedConsumer: consumers[0]!,
      explanation: "The Request resolves to exactly one compatible consumer.",
    };
  }
  if (consumers.length === 0) {
    return {
      status: "orphaned" as const,
      explanation: "The Request has no compatible consumer; add or enable one and select it.",
    };
  }
  return {
    status: "ambiguous" as const,
    explanation: `The Request has ${consumers.length} compatible consumers; select exactly one.`,
  };
}

function uniqueInstances(
  instances: readonly ProjectModuleInstanceConfiguration[],
): ProjectCompositionChoiceInstance[] {
  const unique = new Map<string, ProjectCompositionChoiceInstance>();
  for (const instance of instances) {
    unique.set(instance.instanceId, {
      instanceId: instance.instanceId,
      moduleId: instance.moduleId,
    });
  }
  return [...unique.values()].sort(compareJson);
}

function uniqueConsumers(
  declarationsToIndex: readonly Declaration[],
  expected: ProjectModuleContractDescriptor,
) {
  const unique = new Map<string, ReturnType<typeof toConsumer>>();
  for (const declaration of declarationsToIndex) {
    const consumer = toConsumer(declaration, expected);
    unique.set(`${consumer.instanceId}:${consumer.compatibility}`, consumer);
  }
  return [...unique.values()].sort(compareJson);
}

function toConsumer(declaration: Declaration, expected: ProjectModuleContractDescriptor) {
  return {
    instanceId: declaration.instance.instanceId,
    moduleId: declaration.instance.moduleId,
    compatibility: compatible(declaration.contract, expected)
      ? ("compatible" as const)
      : ("incompatible" as const),
  };
}

function compatible(left: ProjectModuleContractDescriptor, right: ProjectModuleContractDescriptor) {
  return contractKey(left) === contractKey(right);
}

function contractKey(contract: Pick<ProjectModuleContractDescriptor, "type" | "version" | "kind">) {
  return `${contract.type}\u0000${contract.version}\u0000${contract.kind}`;
}

function compareJson(left: unknown, right: unknown): number {
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}
