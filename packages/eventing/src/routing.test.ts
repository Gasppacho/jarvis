import { describe, expect, it } from "vitest";
import { resolveConsumers, type EventingOpenSubscription } from "./routing.js";

const fact = { type: "scm.work-item.tag-added", version: 1, kind: "fact" as const };

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
