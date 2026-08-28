# Event Catalog v1

## MVP events

| Event | Kind | Producer | Intended consumer | Payload schema |
|---|---|---|---|---|
| `scm.work-item.tag-added` | Fact | GitHub | Automation Rules and observers | `contracts/events/scm.work-item.tag-added.v1.schema.json` |
| `development.implementation.requested` | Request | Automation Rules or future decision module | Development | `contracts/events/development.implementation.requested.v1.schema.json` |
| `development.implementation.completed` | Fact | Development | Observers; future modules | `contracts/events/development.implementation.completed.v1.schema.json` |
| `development.implementation.failed` | Fact | Development | Observers; future remediation | `contracts/events/development.implementation.failed.v1.schema.json` |
| `scm.change-request.creation-requested` | Request | Development | Bound SCM provider | `contracts/events/scm.change-request.creation-requested.v1.schema.json` |
| `scm.change-request.created` | Fact | SCM provider | Observers; future Review module | `contracts/events/scm.change-request.created.v1.schema.json` |
| `scm.change-request.creation-failed` | Fact | SCM provider | Observers; future remediation | `contracts/events/scm.change-request.creation-failed.v1.schema.json` |

## Reserved post-MVP names

These names document direction but are not MVP contracts until schemas and manifests are added:

```text
scm.change-request.review-publication-requested
scm.change-request.review-published
scm.change-request.merge-requested
scm.change-request.merged
scm.checks.completed
change-request.review.completed
```

No module may emit a reserved name before it is registered as a versioned contract.

## Ownership rule

The event type belongs to the integration contract catalog, not to either producer or consumer implementation. A breaking payload change increments the event version and requires an explicit compatibility plan.
