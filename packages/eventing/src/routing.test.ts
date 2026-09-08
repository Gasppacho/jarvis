import { describe, expect, it } from "vitest";
import {
  resolveConsumers,
  resolveRequestConsumer,
  type EventingOpenSubscription,
  type EventingRequestRoutingSnapshot,
} from "./routing.js";

const fact = { type: "scm.work-item.tag-added", version: 1, kind: "fact" as const };
const request = {
  type: "development.implementation.requested",
  version: 1,
  kind: "request" as const,
  projectId: "project-a",
  producer: {
    moduleId: "jarvis.module.automation-rules",
    moduleInstanceId: "automation-rules",
  },
};

const requestRoute = {
  contract: { type: request.type, version: request.version, kind: request.kind },
  producer: {
    moduleId: request.producer.moduleId,
    instanceId: request.producer.moduleInstanceId,
  },
  consumer: { moduleId: "jarvis.module.development", instanceId: "development" },
};

function requestSnapshot(
  overrides: Partial<EventingRequestRoutingSnapshot> = {},
): EventingRequestRoutingSnapshot {
  return {
    moduleInstances: [
      {
        instanceId: request.producer.moduleInstanceId,
        moduleId: request.producer.moduleId,
        bindings: { implementation: "development-slot" },
      },
    ],
    bindings: {
      slots: {
        "development-slot": { kind: "module-instance", ref: "development" },
      },
    },
    requestRoutes: [requestRoute],
    ...overrides,
  };
}

function subscription(
  instanceId: string,
  overrides: Partial<EventingOpenSubscription["contract"]> = {},
): EventingOpenSubscription {
  return {
    instanceId,
    moduleId: `jarvis.module.${instanceId}`,
    contract: { ...fact, ...overrides },
  };
}

describe("resolveConsumers", () => {
  it("routes to zero consumers when no subscription matches — legal, still journaled elsewhere", () => {
    expect(resolveConsumers(fact, [])).toEqual([]);
  });

  it("routes to every subscription matching type, version and kind", () => {
    const subs = [subscription("automation-rules"), subscription("change-request-review")];
    expect(resolveConsumers(fact, subs)).toEqual([
      { moduleInstanceId: "automation-rules", moduleId: "jarvis.module.automation-rules" },
      {
        moduleInstanceId: "change-request-review",
        moduleId: "jarvis.module.change-request-review",
      },
    ]);
  });

  it("ignores a subscription to a different type", () => {
    const subs = [subscription("other", { type: "scm.change-request.created" })];
    expect(resolveConsumers(fact, subs)).toEqual([]);
  });

  it("ignores a subscription to a different version", () => {
    const subs = [subscription("other", { version: 2 })];
    expect(resolveConsumers(fact, subs)).toEqual([]);
  });

  it("ignores a subscription declared for the request side of the same contract name", () => {
    const subs = [subscription("other", { kind: "request" })];
    expect(resolveConsumers(fact, subs)).toEqual([]);
  });
});

describe("resolveRequestConsumer", () => {
  it("resolves a direct module-instance target from the frozen request route", () => {
    expect(
      resolveRequestConsumer(
        { ...request, target: { moduleInstanceId: "development" } },
        requestSnapshot(),
      ),
    ).toEqual({ moduleInstanceId: "development", moduleId: "jarvis.module.development" });
  });

  it("resolves a binding target through the producer alias and frozen slot binding", () => {
    expect(
      resolveRequestConsumer(
        { ...request, target: { binding: "implementation" } },
        requestSnapshot(),
      ),
    ).toEqual({ moduleInstanceId: "development", moduleId: "jarvis.module.development" });
  });

  it("fails clearly when the target has no matching consumer", () => {
    expect(() =>
      resolveRequestConsumer(
        { ...request, target: { moduleInstanceId: "missing" } },
        requestSnapshot(),
      ),
    ).toThrowError(/has no target consumer/);
  });

  it("fails clearly when the frozen snapshot names genuinely different consumers", () => {
    expect(() =>
      resolveRequestConsumer(
        { ...request, target: { moduleInstanceId: "development" } },
        requestSnapshot({
          requestRoutes: [
            requestRoute,
            {
              ...requestRoute,
              consumer: { moduleId: "jarvis.module.other", instanceId: "development" },
            },
          ],
        }),
      ),
    ).toThrowError(/has multiple target consumers/);
  });

  it("resolves when the frozen snapshot repeats one consumer, as a multi-Rule Rule Set does", () => {
    // One route per configured emission: an Automation Rules instance whose
    // Rule Set sends several different tags to the same Development instance
    // freezes the identical route once per Rule. That is one candidate, not an
    // ambiguity — including in snapshots written before the report itself
    // deduplicated them.
    expect(
      resolveRequestConsumer(
        { ...request, target: { moduleInstanceId: "development" } },
        requestSnapshot({ requestRoutes: [requestRoute, requestRoute, requestRoute] }),
      ),
    ).toEqual({ moduleInstanceId: "development", moduleId: "jarvis.module.development" });
  });
});
