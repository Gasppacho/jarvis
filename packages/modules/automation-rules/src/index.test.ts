import type { EventEnvelope } from "../../../eventing/src/envelope.js";
import type {
  ModuleHandlerContext,
  ModuleHandlerPublishInput,
} from "../../../module-sdk/src/index.js";
import { describe, expect, it } from "vitest";
import { handleWorkItemTagAdded } from "./index.js";

const fact: EventEnvelope = {
  specVersion: "1.0",
  id: "evt_tag_added_001",
  type: "scm.work-item.tag-added",
  version: 1,
  kind: "fact",
  occurredAt: "2026-08-28T08:00:00.000Z",
  projectId: "token-warehouse",
  repositoryId: "main",
  producer: { moduleId: "jarvis.module.github", moduleInstanceId: "github" },
  subject: { type: "work-item", ref: "github://QServices/token-warehouse/issues/42" },
  correlationId: "corr_issue_42_generation_1",
  causationId: null,
  metadata: { generation: 1 },
  payload: {
    workItemRef: "github://QServices/token-warehouse/issues/42",
    tag: "agent:ready",
  },
};

function context(
  configuration: ModuleHandlerContext["configuration"],
  event: EventEnvelope = fact,
  repositoryDefaultBranch = "main",
): { readonly ctx: ModuleHandlerContext; readonly published: ModuleHandlerPublishInput[] } {
  const published: ModuleHandlerPublishInput[] = [];
  return {
    published,
    ctx: {
      projectId: event.projectId,
      executionId: "execution-test",
      moduleInstanceId: "automation-rules",
      repositoryId: event.repositoryId,
      repositoryDefaultBranch,
      event,
      configuration,
      signal: new AbortController().signal,
      capabilities: {},
      recordCheckpoint: () => {},
      publish: (input) => {
        published.push(input);
        return event;
      },
      publishFailure: (input) => {
        published.push(input);
        return event;
      },
    },
  };
}

describe("handleWorkItemTagAdded", () => {
  it("publishes one targeted implementation request for a matching tag", () => {
    const { ctx, published } = context({
      rules: [
        {
          id: "ready-label-starts-development",
          when: { eventType: "scm.work-item.tag-added", equals: { "payload.tag": "agent:ready" } },
          emit: {
            type: "development.implementation.requested",
            target: { moduleInstanceId: "development" },
          },
        },
      ],
    });

    expect(handleWorkItemTagAdded(ctx)).toEqual({
      matchedRuleIds: ["ready-label-starts-development"],
      emittedEventIds: ["evt_tag_added_001"],
    });
    expect(published).toEqual([
      {
        type: "development.implementation.requested",
        version: 1,
        kind: "request",
        subject: fact.subject,
        repositoryId: "main",
        target: { moduleInstanceId: "development" },
        idempotencyKey: "token-warehouse:issue-42:development:1",
        payload: {
          workItemRef: "github://QServices/token-warehouse/issues/42",
          repositoryId: "main",
          baseBranch: "main",
          tag: "agent:ready",
        },
        metadata: { generation: 1 },
      },
    ]);
  });

  it("does not publish when the event type, value, or path does not match", () => {
    const { ctx, published } = context(
      {
        rules: [
          {
            id: "ready",
            when: {
              eventType: "scm.work-item.tag-added",
              equals: { "payload.tag": "agent:ready" },
            },
            emit: {
              type: "development.implementation.requested",
              target: { binding: "development" },
            },
          },
          {
            id: "unbounded",
            when: {
              eventType: "scm.work-item.tag-added",
              equals: { "payload.nested.tag": "agent:ready" },
            },
            emit: {
              type: "development.implementation.requested",
              target: { binding: "development" },
            },
          },
        ],
      },
      {
        ...fact,
        type: "scm.work-item.updated",
      },
    );

    expect(handleWorkItemTagAdded(ctx)).toEqual({ matchedRuleIds: [], emittedEventIds: [] });
    expect(published).toEqual([]);
  });

  it("emits only for the first matching rule", () => {
    const { ctx, published } = context({
      rules: [
        {
          id: "first",
          when: { eventType: "scm.work-item.tag-added", equals: { "payload.tag": "agent:ready" } },
          emit: {
            type: "development.implementation.requested",
            target: { moduleInstanceId: "development" },
          },
        },
        {
          id: "second",
          when: { eventType: "scm.work-item.tag-added", equals: { "payload.tag": "agent:ready" } },
          emit: {
            type: "development.implementation.requested",
            target: { binding: "sourceControl" },
          },
        },
      ],
    });

    expect(handleWorkItemTagAdded(ctx)).toEqual({
      matchedRuleIds: ["first"],
      emittedEventIds: ["evt_tag_added_001"],
    });
    expect(published).toHaveLength(1);
    expect(published[0]?.target).toEqual({ moduleInstanceId: "development" });
  });

  it("does not emit a request outside the manifest permission", () => {
    const { ctx, published } = context({
      rules: [
        {
          id: "unauthorized",
          when: { eventType: "scm.work-item.tag-added", equals: { "payload.tag": "agent:ready" } },
          emit: {
            type: "scm.work-item.tag-added",
            target: { moduleInstanceId: "development" },
          },
        },
      ],
    });

    // Terminal, not a silent skip: under first-match-wins a dropped Rule would
    // quietly promote whichever Rule follows it.
    expect(() => handleWorkItemTagAdded(ctx)).toThrow(/unauthorized/);
    expect(published).toEqual([]);
  });

  it("fails the Delivery rather than letting an unhonorable Rule promote the one behind it", () => {
    const { ctx, published } = context({
      rules: [
        {
          id: "undeclared-contract",
          when: { eventType: "scm.work-item.tag-added", equals: { "payload.tag": "agent:ready" } },
          emit: {
            type: "scm.change-request.merge-requested",
            target: { binding: "sourceControl" },
          },
        },
        {
          id: "would-win-if-dropped",
          when: { eventType: "scm.work-item.tag-added", equals: { "payload.tag": "agent:ready" } },
          emit: {
            type: "development.implementation.requested",
            target: { moduleInstanceId: "development" },
          },
        },
      ],
    });

    expect(() => handleWorkItemTagAdded(ctx)).toThrow(/index 0 \(undeclared-contract\)/);
    expect(published).toEqual([]);
  });

  it("uses the bound repository default branch when the rule does not override it", () => {
    const { ctx, published } = context(
      {
        rules: [
          {
            id: "ready",
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
      fact,
      "develop",
    );

    handleWorkItemTagAdded(ctx);

    expect(published[0]?.payload["baseBranch"]).toBe("develop");
  });

  it("keeps the configured target and compatible static generation fields", () => {
    const { ctx, published } = context({
      rules: [
        {
          id: "ready",
          when: { eventType: "scm.work-item.tag-added", equals: { "payload.tag": "agent:ready" } },
          emit: {
            type: "development.implementation.requested",
            target: { binding: "development" },
            payload: { baseBranch: "trunk", requestedGeneration: 2 },
          },
        },
      ],
    });

    handleWorkItemTagAdded(ctx);

    expect(published[0]).toMatchObject({
      target: { binding: "development" },
      payload: {
        workItemRef: "github://QServices/token-warehouse/issues/42",
        repositoryId: "main",
        baseBranch: "trunk",
        requestedGeneration: 2,
      },
    });
    expect(published[0]?.idempotencyKey).toBe("token-warehouse:issue-42:development:1");
  });
  it("distinguishes a payload field that is absent from one explicitly set to null", () => {
    const nullRule = {
      id: "null-title",
      when: {
        eventType: "scm.work-item.tag-added",
        equals: { "payload.tag": "agent:ready", "payload.title": null },
      },
      emit: {
        type: "development.implementation.requested",
        target: { moduleInstanceId: "development" },
      },
    };

    // `title` is absent from the Fact: a predicate expecting an explicit null
    // must not treat "no such field" as a match.
    const absent = context({ rules: [nullRule] });
    expect(handleWorkItemTagAdded(absent.ctx)).toEqual({ matchedRuleIds: [], emittedEventIds: [] });
    expect(absent.published).toEqual([]);

    const explicit = context(
      { rules: [nullRule] },
      {
        ...fact,
        payload: { ...fact.payload, title: null },
      },
    );
    expect(handleWorkItemTagAdded(explicit.ctx)).toEqual({
      matchedRuleIds: ["null-title"],
      emittedEventIds: ["evt_tag_added_001"],
    });
  });

  it("rejects rather than inventing a repository or branch the Project does not supply", () => {
    const rules = [
      {
        id: "ready",
        when: { eventType: "scm.work-item.tag-added", equals: { "payload.tag": "agent:ready" } },
        emit: {
          type: "development.implementation.requested",
          target: { moduleInstanceId: "development" },
        },
      },
    ];
    // Built here rather than through `context`, whose default parameter would
    // substitute a branch for the `undefined` these two cases are about.
    const bare = (event: EventEnvelope, repositoryDefaultBranch: string | undefined) => {
      const published: ModuleHandlerPublishInput[] = [];
      const ctx: ModuleHandlerContext = {
        projectId: event.projectId,
        executionId: "execution-test",
        moduleInstanceId: "automation-rules",
        repositoryId: event.repositoryId,
        repositoryDefaultBranch,
        event,
        configuration: { rules },
        signal: new AbortController().signal,
        capabilities: {},
        recordCheckpoint: () => {},
        publish: (input) => {
          published.push(input);
          return event;
        },
        publishFailure: (input) => {
          published.push(input);
          return event;
        },
      };
      return { ctx, published };
    };
    const { repositoryId: _unbound, ...withoutRepository } = fact;

    const noBranch = bare(fact, undefined);
    expect(() => handleWorkItemTagAdded(noBranch.ctx)).toThrow(/baseBranch/);
    expect(noBranch.published).toEqual([]);

    const noRepository = bare(withoutRepository, "main");
    expect(() => handleWorkItemTagAdded(noRepository.ctx)).toThrow(/repositoryId/);
    expect(noRepository.published).toEqual([]);
  });
});
