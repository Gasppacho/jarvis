# Contract Validation

## Required checks

`pnpm contracts:check` must fail when any of these conditions occurs:

1. A JSON Schema is not valid Draft 2020-12.
2. An event example fails the envelope schema.
3. An event payload fails its `(type, version)` schema.
4. A Module Manifest fails its schema.
5. A manifest `schemaRef` does not exist.
6. A Project example fails Project Config schema.
7. A Module Instance configuration fails its module schema.
8. A manifest declares a producer/consumer without a registered event contract.
9. An example project references an unknown Module Package.
10. OpenAPI is invalid or generated Swift/TypeScript output differs.
11. A breaking contract change is made without version increment or migration test.

## Compatibility snapshots

Release tags retain copies/checksums of public v1 schemas. CI compares current versions to the last release:

- optional additive fields are allowed when consumers tolerate them ;
- new enum values require caution and consumer tests ;
- required fields, narrowed types or removed fields require a new event version ;
- changing Request target semantics requires an ADR and envelope version review.

## Example-driven contracts

Every event in the catalog has at least one valid example. Important errors should have invalid fixtures proving the validator rejects them. Examples are documentation and test inputs, not decorative snippets.

## Runtime validation

Ajv validates:

- Project and Module configuration at load ;
- Event envelope and payload before journal commit ;
- handler output before Outbox commit.

A validation error is permanent/non-retryable and includes schema path without echoing sensitive values.
