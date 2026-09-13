import { describe, expect, it } from "vitest";
import type { WorkItemStateObservation } from "../../../module-sdk/src/index.js";
import { assessDevelopmentEligibility, isDevelopmentEligible } from "./index.js";

const baseObservation: WorkItemStateObservation = {
  title: "Issue",
  state: "open",
  tags: ["ready-to-dev"],
  dependencies: { status: "complete", openWorkItemRefs: [] },
  verification: "verified",
  reasonCode: null,
};

function candidate(
  observation: WorkItemStateObservation = baseObservation,
  overrides: Partial<Parameters<typeof assessDevelopmentEligibility>[0]> = {},
) {
  return {
    repositoryId: "main",
    authorizedRepositoryId: "main",
    workItemRef: "github://Gasppacho/jarvis/issues/222",
    observation,
    readyLabel: " ready-to-dev ",
    scope: { kind: "all" } as const,
    alreadyStarted: false,
    ...overrides,
  };
}

describe("Development observation admission", () => {
  it.each([
    [
      "unverified snapshot",
      { ...baseObservation, verification: "unavailable", reasonCode: "provider-unavailable" },
    ],
    ["closed issue", { ...baseObservation, state: "closed" }],
    ["missing label", { ...baseObservation, tags: [] }],
    [
      "open blocker",
      { ...baseObservation, dependencies: { status: "complete", openWorkItemRefs: ["blocker"] } },
    ],
    ["issue scope mismatch", baseObservation],
    ["unauthorized repository", baseObservation],
    ["already started", baseObservation],
  ] as const)("rejects %s without an admission", (reason, observation) => {
    const input =
      reason === "issue scope mismatch"
        ? candidate(observation, {
            scope: { kind: "issue", workItemRef: "github://Gasppacho/jarvis/issues/999" },
          })
        : reason === "unauthorized repository"
          ? candidate(observation, { authorizedRepositoryId: undefined })
          : reason === "already started"
            ? candidate(observation, { alreadyStarted: true })
            : candidate(observation);
    expect(isDevelopmentEligible(input)).toBe(false);
    expect(assessDevelopmentEligibility(input).eligible).toBe(false);
  });

  it("accepts only the exact configured label after trimming configuration input", () => {
    expect(isDevelopmentEligible(candidate())).toBe(true);
    expect(isDevelopmentEligible(candidate({ ...baseObservation, tags: ["Ready-to-dev"] }))).toBe(
      false,
    );
  });
});
