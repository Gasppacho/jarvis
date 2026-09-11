# ADR 0018 — Bounded Delivery retries and explicit replay

**Status:** Accepted
**Date:** 2026-09-11

## Context

Eventing delivers at least once. A handler can therefore fail after its
Delivery has been persisted, and operators need a bounded way to retry a
transient failure or explicitly run a Dead Letter again without changing the
original Event identity.

## Decisions

### Unclassified failures are retryable by default

A handler's safe structured `{ code, retryable }` classification is respected.
Validation, permission and equivalent permanent signals are non-retryable. If
the runtime cannot classify the failure safely, it uses `system.internal-error`
and keeps the failure retryable. A bounded retry budget is safer than silently
dismissing an unclassified transient outage.

### Retry is bounded

The default is five attempts. Callers may select a maximum from one through the
system maximum of ten. The delay starts at one second, doubles by attempt, adds
50–100% jitter, and is capped at 60 seconds. Once the maximum is reached, the
Delivery is terminally dead-lettered with `delivery.retry-exhausted`.

### Replay reuses the original identity

Replay acts on the existing Delivery and Event rather than publishing a new
Event. It therefore reuses the original Event idempotency key, increments the
attempt number, and records the new Execution with `replayed = true`. A
successful replay writes the existing Delivery's Inbox identity and removes the
Dead Letter; a failed replay follows the normal failure path, with retryable
failures rescheduled and permanent or exhausted failures dead-lettered.

## Evidence and limits

- `packages/eventing/src/retry-policy.test.ts` proves the exponential delay,
  jitter bounds, 60-second cap and default/caller-selected exhaustion.
- `apps/engine/src/executions/delivery-consumer.test.ts` proves retry scheduling,
  permanent dead-lettering, same-Event replay and attempt numbering.
- `apps/engine/test/dead-letters.integration.test.ts` proves the authenticated
  Local API replay path and missing-Dead-Letter error.
- `apps/engine/test/engine-claim.integration.test.ts` and the DeliveryConsumer
  lease tests prove claim mechanics and live-lease exclusion. The Outbox and
  GitHub mapping tests prove their individual crash boundaries, but the
  end-to-end three-boundary matrix from #17 is not yet proved; this ADR does
  not claim the remaining restart-with-lease criterion.
