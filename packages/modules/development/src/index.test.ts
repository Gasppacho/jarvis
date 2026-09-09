import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "../../../eventing/src/envelope.js";
import type {
  ModuleHandlerContext,
  ModuleHandlerPublishInput,
} from "../../../module-sdk/src/index.js";
import { buildChangeRequestIdempotencyKey, handleImplementationRequested } from "./index.js";

describe("Development outputs", () => {
  it("derives a stable bounded Change Request idempotency key", () => {
    const first = buildChangeRequestIdempotencyKey(
      "project",
      "main",
      "github://owner/repository/issues/42",
      "a".repeat(40),
    );

    expect(first).toBe(
      buildChangeRequestIdempotencyKey(
        "project",
        "main",
        "github://owner/repository/issues/42",
        "a".repeat(40),
      ),
    );
    expect(first).not.toBe(
      buildChangeRequestIdempotencyKey(
        "project",
        "main",
        "github://owner/repository/issues/42",
        "b".repeat(40),
      ),
    );
    expect(first).toMatch(/^change-request:[0-9a-f]{64}$/);
  });

  it("publishes a safe failure fact for an invalid input request", async () => {
    const published: ModuleHandlerPublishInput[] = [];
    const event = {
      specVersion: "1.0",
      id: "evt_invalid",
      type: "development.implementation.requested",
      version: 1,
      kind: "request",
      occurredAt: "2026-09-09T00:00:00.000Z",
      projectId: "project",
      repositoryId: "main",
      producer: { moduleId: "jarvis.module.automation-rules", moduleInstanceId: "rules" },
      subject: { type: "work-item", ref: "/tmp/private-work-item" },
      correlationId: "corr_invalid",
      causationId: null,
      target: { moduleInstanceId: "development" },
      idempotencyKey: "project:invalid-input",
      payload: { repositoryId: "main" },
    } satisfies EventEnvelope;
    const publish = (input: ModuleHandlerPublishInput): EventEnvelope => {
      published.push(input);
      return event;
    };
    const ctx: ModuleHandlerContext = {
      projectId: event.projectId,
      executionId: "exec_invalid",
      moduleInstanceId: "development",
      repositoryId: event.repositoryId,
      repositoryDefaultBranch: "main",
      event,
      configuration: {},
      signal: new AbortController().signal,
      capabilities: {},
      recordCheckpoint: () => {},
      publish,
      publishFailure: publish,
    };

    await expect(handleImplementationRequested(ctx)).rejects.toMatchObject({
      code: "event.payload-invalid",
    });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: "development.implementation.failed",
      kind: "fact",
      payload: {
        workItemRef: "work-item",
        repositoryId: "main",
        code: "event.payload-invalid",
        message: expect.stringContaining("Project project"),
        retryable: false,
      },
    });
    expect(JSON.stringify(published[0])).not.toContain("/tmp/private-work-item");
  });
});
