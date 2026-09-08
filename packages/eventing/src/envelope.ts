import type { ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

const addFormats = addFormatsModule.default;

export interface EventEnvelopeProducer {
  readonly moduleId: string;
  readonly moduleInstanceId: string;
}

export interface EventEnvelopeSubject {
  readonly type: string;
  readonly ref: string;
}

export interface EventEnvelopeTarget {
  readonly binding?: string;
  readonly moduleInstanceId?: string;
}

export interface EventEnvelopeMetadata {
  readonly generation?: number;
  readonly traceId?: string;
  readonly externalObservedAt?: string;
}

/** docs/contracts/EVENT_ENVELOPE_V1.md; machine source contracts/schemas/event-envelope.v1.schema.json. */
export interface EventEnvelope {
  readonly specVersion: "1.0";
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly kind: "request" | "fact";
  readonly occurredAt: string;
  readonly projectId: string;
  readonly repositoryId?: string;
  readonly producer: EventEnvelopeProducer;
  readonly subject: EventEnvelopeSubject;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly target?: EventEnvelopeTarget;
  readonly idempotencyKey?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly metadata?: EventEnvelopeMetadata;
}

export interface EventPayloadContract {
  readonly type: string;
  readonly version: number;
  readonly schema: object;
}

export class InvalidEventEnvelopeError extends Error {
  public constructor(public readonly issues: readonly string[]) {
    super(`Invalid Event Envelope: ${issues.join("; ")}`);
    this.name = "InvalidEventEnvelopeError";
  }
}

/**
 * Eventing's runtime enforcement of the versioned Event Envelope contract
 * (ticket #56). Mirrors `ModuleManifestContractRegistry`
 * (packages/kernel/src/module-host.ts): the schema is the source of truth,
 * compiled once and validated many times, so this and `pnpm contracts:check`
 * are the only two places the contract is enforced from.
 */
export class EventEnvelopeContractRegistry {
  private readonly validateEventEnvelopeV1: ValidateFunction<EventEnvelope>;
  private readonly validatePayloadByEvent = new Map<
    string,
    ValidateFunction<Readonly<Record<string, unknown>>>
  >();

  public constructor(contracts: {
    readonly eventEnvelopeV1: object;
    readonly eventPayloads?: readonly EventPayloadContract[];
  }) {
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
    addFormats(ajv);
    this.validateEventEnvelopeV1 = ajv.compile<EventEnvelope>(contracts.eventEnvelopeV1);
    for (const contract of contracts.eventPayloads ?? []) {
      this.validatePayloadByEvent.set(
        eventKey(contract.type, contract.version),
        ajv.compile<Readonly<Record<string, unknown>>>(contract.schema),
      );
    }
  }

  /** Throws `InvalidEventEnvelopeError` rather than returning a boolean: every
   * caller's next step is either a validated envelope or a rejection, never a
   * silent continue. */
  public requireEnvelope(candidate: unknown): EventEnvelope {
    if (!this.validateEventEnvelopeV1(candidate)) {
      const issues = (this.validateEventEnvelopeV1.errors ?? []).map(
        (error) =>
          `${error.instancePath === "" ? "/" : error.instancePath} ${error.message ?? "is invalid"}`,
      );
      throw new InvalidEventEnvelopeError(issues);
    }
    const envelope = candidate;
    const validatePayload = this.validatePayloadByEvent.get(
      eventKey(envelope.type, envelope.version),
    );
    if (validatePayload !== undefined && !validatePayload(envelope.payload)) {
      const issues = (validatePayload.errors ?? []).map(
        (error) =>
          `/payload${error.instancePath === "" ? "" : error.instancePath} ${error.message ?? "is invalid"}`,
      );
      throw new InvalidEventEnvelopeError(issues);
    }
    return envelope;
  }
}

function eventKey(type: string, version: number): string {
  return `${type}.v${version}`;
}
