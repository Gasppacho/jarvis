import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EventEnvelopeContractRegistry, InvalidEventEnvelopeError } from "./envelope.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const schema = JSON.parse(
  readFileSync(`${ROOT}/contracts/schemas/event-envelope.v1.schema.json`, "utf8"),
) as object;

function validEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    specVersion: "1.0",
    id: "evt_01K0000000000000000000",
    type: "scm.work-item.tag-added",
    version: 1,
    kind: "fact",
    occurredAt: "2026-08-28T08:00:00.000Z",
    projectId: "token-warehouse",
    producer: { moduleId: "jarvis.module.github", moduleInstanceId: "github" },
    subject: { type: "work-item", ref: "github://QServices/token-warehouse/issues/42" },
    correlationId: "corr_01K0000000000000000000",
    causationId: null,
    payload: {},
    ...overrides,
  };
}

describe("EventEnvelopeContractRegistry", () => {
  const registry = new EventEnvelopeContractRegistry({ eventEnvelopeV1: schema });

  it("accepts a fact envelope that satisfies the v1 contract", () => {
    const envelope = registry.requireEnvelope(validEnvelope());
    expect(envelope.type).toBe("scm.work-item.tag-added");
  });

  it("accepts a request envelope carrying target and idempotencyKey", () => {
    const envelope = registry.requireEnvelope(
      validEnvelope({
        kind: "request",
        type: "development.implementation.requested",
        target: { moduleInstanceId: "development" },
        idempotencyKey: "token-warehouse:issue-42:implementation:1",
      }),
    );
    expect(envelope.kind).toBe("request");
  });

  it("rejects a request envelope missing target and idempotencyKey", () => {
    expect(() =>
      registry.requireEnvelope(
        validEnvelope({ kind: "request", type: "development.implementation.requested" }),
      ),
    ).toThrow(InvalidEventEnvelopeError);
  });

  it("rejects an envelope with a malformed id", () => {
    let error: unknown;
    try {
      registry.requireEnvelope(validEnvelope({ id: "not-an-event-id" }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InvalidEventEnvelopeError);
    expect((error as InvalidEventEnvelopeError).issues.join(";")).toContain("/id");
  });

  it("rejects an envelope missing a required field", () => {
    const { correlationId: _drop, ...withoutCorrelationId } = validEnvelope();
    expect(() => registry.requireEnvelope(withoutCorrelationId)).toThrow(InvalidEventEnvelopeError);
  });

  it("rejects an envelope carrying an undeclared property", () => {
    expect(() => registry.requireEnvelope(validEnvelope({ unexpectedField: "nope" }))).toThrow(
      InvalidEventEnvelopeError,
    );
  });
});
