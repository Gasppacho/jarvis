import { describe, expect, it } from "vitest";

import type { ExecutionCheckpoint } from "../executions/checkpoints.js";
import type { LedgerExecutionSummary } from "../executions/ledger.js";
import type { EventDetail } from "../events/timeline.js";
import { buildExecutionDetail } from "./execution-detail.js";

const projectId = "project-a";
const startedAt = "2026-09-13T00:00:00.000Z";

describe("buildExecutionDetail", () => {
  it("keeps successful checks when a later operation fails before its fact is journaled", () => {
    const detail = buildExecutionDetail({
      projectId,
      correlationId: "corr-commit-error",
      anchor: execution({ status: "failed", error: "Commit creation failed" }),
      executions: [],
      events: [],
      checkpoints: new Map([
        [
          "execution-anchor",
          [
            checkpoint({ type: "validation.started", payload: { check: "test" } }),
            checkpoint({
              type: "validation.completed",
              sequence: 2,
              payload: { check: "test", durationMs: 10, planComplete: true },
            }),
          ],
        ],
      ]),
      leases: new Map(),
      readiness: [],
      retryDeliveryId: null,
    });
    expect(detail.checks[0]?.status).toBe("passed");
    expect(detail.steps.find((step) => step.id === "checks")?.status).toBe("proved");
    expect(detail.failure?.stepId).toBeNull();
  });

  it("keeps cancellation and retry evidence explicit across the workflow", () => {
    const detail = buildExecutionDetail({
      projectId,
      correlationId: "corr-cancelled",
      anchor: execution({
        id: "execution-cancelled",
        inputEventId: "event-root",
        status: "cancelled",
        error: "token=ghp_should-not-leak /private/tmp/secret",
        completedAt: "2026-09-13T00:00:03.000Z",
      }),
      executions: [],
      events: [event({ id: "event-root", correlationId: "corr-cancelled", type: "unrelated" })],
      checkpoints: new Map(),
      leases: new Map(),
      readiness: [],
      retryDeliveryId: "delivery-retry",
    });

    expect(detail.steps).toHaveLength(6);
    expect(detail.steps.map((step) => step.label)).toEqual([
      "Issue reçue",
      "Éligibilité confirmée",
      "Préparation du projet",
      "Développement",
      "Commit et push",
      "Création de la Pull Request",
    ]);
    expect(detail.steps.find((step) => step.id === "agent-running")?.status).toBe("cancelled");
    expect(
      detail.steps
        .filter((step) => step.id !== "agent-running")
        .every((step) => step.status === "unavailable" || step.status === "not-started"),
    ).toBe(true);
    expect(detail.failure).toMatchObject({
      code: "execution.cancelled",
      retryable: true,
      stepId: "agent-running",
    });
    expect(detail.executions[0]?.error).not.toContain("ghp_should-not-leak");
    expect(detail.failure?.message).not.toContain("/private/tmp/secret");
    expect(detail.cancellableExecutionId).toBeNull();
    expect(detail.retryDeliveryId).toBe("delivery-retry");
    expect(detail.executions[0]?.durationMs).toBe(3000);
  });

  it("bounds and redacts technical and agent evidence while mapping a PR result", () => {
    const longMessage = `token=ghp_should-not-leak ${"x".repeat(700)} /private/tmp/secret`;
    const detail = buildExecutionDetail({
      projectId,
      correlationId: "corr-complete",
      anchor: execution({ inputEventId: "event-request", status: "completed" }),
      executions: [],
      events: [
        event({
          id: "event-created",
          type: "scm.change-request.created",
          subjectRef: "github:pull/42",
          payload: {
            changeRequestRef: "github:pull/42",
            externalNumber: 42,
            url: "https://user:secret@github.com/Gasppacho/jarvis/pull/42?token=leak",
            token: "ghp_should-not-leak",
            ghp_secret_key: "should-not-appear",
            ...Object.fromEntries(
              Array.from({ length: 1_000 }, (_, index) => [`field-${index}`, "value"]),
            ),
          },
        }),
        event({
          id: "event-request",
          type: "scm.change-request.creation-requested",
          payload: { title: "token=ghp_should-not-leak Implement execution detail" },
        }),
      ],
      checkpoints: new Map([
        ["execution-anchor", [checkpoint({ payload: { message: longMessage } })]],
      ]),
      leases: new Map(),
      readiness: [],
      retryDeliveryId: null,
    });

    expect(detail.pullRequest).toMatchObject({
      ref: "github:pull/42",
      number: 42,
      title: "token=<redacted> Implement execution detail",
      url: null,
    });
    expect(detail.agentExcerpts[0]?.text.length).toBeLessThanOrEqual(512);
    expect(detail.agentExcerpts[0]?.text).not.toContain("ghp_should-not-leak");
    expect(detail.agentExcerpts[0]?.text).not.toContain("/private/tmp/secret");
    expect(detail.technical.events[0]?.payloadExcerpt.length).toBeLessThanOrEqual(512);
    expect(detail.technical.events[0]?.payloadExcerpt).not.toContain("ghp_should-not-leak");
    expect(detail.technical.events[0]?.payloadExcerpt).not.toContain("ghp_secret_key");
    expect(detail.technical.events[0]?.payloadExcerpt).not.toContain("field-999");
    expect(detail.steps).toHaveLength(6);
  });

  it("shows the final correlated result instead of an earlier failed attempt", () => {
    const failed = execution({
      id: "execution-failed",
      status: "failed",
      error: "first attempt failed",
      completedAt: "2026-09-13T00:00:01.000Z",
    });
    const succeeded = execution({
      id: "execution-retry",
      status: "completed",
      createdAt: "2026-09-13T00:00:02.000Z",
      completedAt: "2026-09-13T00:00:03.000Z",
      inputEventId: "event-retry",
    });
    const detail = buildExecutionDetail({
      projectId,
      correlationId: "corr-retry",
      anchor: failed,
      executions: [succeeded],
      events: [
        event({
          id: "event-failed",
          type: "development.implementation.failed",
          correlationId: "corr-retry",
        }),
        event({
          id: "event-retry",
          type: "development.implementation.requested",
          correlationId: "corr-retry",
        }),
      ],
      checkpoints: new Map(),
      leases: new Map(),
      readiness: [],
      retryDeliveryId: null,
    });

    expect(detail.executions.at(-1)?.status).toBe("completed");
    expect(detail.failure).toBeNull();
  });

  it("uses the observed work item as input and the internal request as admission", () => {
    const detail = buildExecutionDetail({
      projectId,
      correlationId: "corr-observed",
      anchor: execution({ inputEventId: "event-request" }),
      executions: [],
      events: [
        event({
          id: "event-request",
          type: "development.implementation.requested",
          kind: "request",
          correlationId: "corr-observed",
          causationId: "event-observed",
        }),
        event({
          id: "event-observed",
          type: "scm.work-item.observed",
          kind: "fact",
          correlationId: "corr-observed",
          subjectRef: "github:issue/42",
        }),
      ],
      checkpoints: new Map(),
      leases: new Map(),
      readiness: [],
      retryDeliveryId: null,
    });

    expect(detail.steps[0]).toMatchObject({ id: "issue-received", status: "proved" });
    expect(detail.steps[1]).toMatchObject({ id: "eligibility-confirmed", status: "proved" });
  });

  it("attributes a Pull Request creation failure to the PR step", () => {
    const detail = buildExecutionDetail({
      projectId,
      correlationId: "corr-pr-failed",
      anchor: execution({ status: "failed", error: "GitHub rejected the request" }),
      executions: [],
      events: [
        event({
          id: "event-pr-failed",
          type: "scm.change-request.creation-failed",
          correlationId: "corr-pr-failed",
          payload: {
            code: "github.change-request-create-failed",
            message: "GitHub rejected the request",
          },
        }),
      ],
      checkpoints: new Map(),
      leases: new Map(),
      readiness: [],
      retryDeliveryId: null,
    });

    expect(detail.failure?.stepId).toBe("pull-request");
    expect(detail.steps.at(-1)).toMatchObject({ id: "pull-request", status: "failed" });
  });

  it("bounds correlated executions while retaining the requested anchor", () => {
    const anchor = execution({ inputEventId: "event-anchor" });
    const detail = buildExecutionDetail({
      projectId,
      correlationId: "corr-large",
      anchor,
      executions: Array.from({ length: 101 }, (_, index) =>
        execution({
          id: `execution-${index}`,
          inputEventId: `event-${index}`,
          createdAt: startedAt,
        }),
      ),
      events: [event({ id: "event-anchor", correlationId: "corr-large" })],
      checkpoints: new Map(),
      leases: new Map(),
      readiness: [],
      retryDeliveryId: null,
    });

    expect(detail.executions).toHaveLength(100);
    expect(detail.executions.some(({ id }) => id === anchor.id)).toBe(true);
  });

  it("bounds checks derived from a validation snapshot", () => {
    const detail = buildExecutionDetail({
      projectId,
      correlationId: "corr-checks",
      anchor: execution(),
      executions: [],
      events: [event()],
      checkpoints: new Map([
        [
          "execution-anchor",
          [
            checkpoint({
              type: "commit.created",
              payload: {
                validation: {
                  commands: Array.from({ length: 101 }, (_, index) => ({
                    name: `check-${index}`,
                    durationMs: index,
                  })),
                },
              },
            }),
          ],
        ],
      ]),
      leases: new Map(),
      readiness: [],
      retryDeliveryId: null,
    });

    expect(detail.checks).toHaveLength(100);
  });
});

function execution(overrides: Partial<LedgerExecutionSummary> = {}): LedgerExecutionSummary {
  return {
    id: "execution-anchor",
    projectId,
    moduleInstanceId: "development",
    status: "completed",
    attempt: 1,
    createdAt: startedAt,
    error: null,
    completedAt: "2026-09-13T00:00:01.000Z",
    inputEventId: "event-request",
    replayed: false,
    ...overrides,
  };
}

function event(overrides: Partial<EventDetail> = {}): EventDetail {
  return {
    id: "event-request",
    type: "development.implementation.requested",
    version: 1,
    kind: "request",
    occurredAt: startedAt,
    producer: "rules",
    correlationId: "corr-complete",
    causationId: null,
    subjectRef: "github:issue/42",
    repositoryId: "Gasppacho/jarvis",
    subjectType: "work-item",
    payload: {},
    ...overrides,
  };
}

function checkpoint(overrides: Partial<ExecutionCheckpoint> = {}): ExecutionCheckpoint {
  return {
    projectId,
    executionId: "execution-anchor",
    sequence: 1,
    sourceSequence: 1,
    type: "agent.message",
    payload: { message: "Agent output" },
    occurredAt: startedAt,
    ...overrides,
  };
}
