# Reference Development Workflow

## Configuration

The Project enables three Module Instances:

```text
github
  produces scm.work-item.tag-added
  consumes scm.change-request.creation-requested

automation-rules
  consumes scm.work-item.tag-added
  produces development.implementation.requested

development
  consumes development.implementation.requested
  produces development.implementation.completed
  produces scm.change-request.creation-requested
```

## Sequence

```text
User/GitHub          GitHub Module       Rules Module       Development        Eventing
    │                     │                   │                   │                 │
    │ add agent:ready     │                   │                   │                 │
    ├────────────────────►│                   │                   │                 │
    │                     │ publish Fact      │                   │                 │
    │                     ├───────────────────────────────────────────────────────►│
    │                     │                   │ consume Fact       │                 │
    │                     │                   ◄────────────────────────────────────┤
    │                     │                   │ publish Request    │                 │
    │                     │                   ├────────────────────────────────────►│
    │                     │                   │                   │ consume Request │
    │                     │                   │                   ◄─────────────────┤
    │                     │                   │                   │ worktree/agent  │
    │                     │                   │                   │ test/commit/push│
    │                     │                   │                   │ publish outputs │
    │                     │                   │                   ├─────────────────►│
    │                     │ consume CR Request│                   │                 │
    │                     ◄────────────────────────────────────────────────────────┤
    │                     │ create PR         │                   │                 │
    │◄────────────────────┤                   │                   │                 │
    │                     │ publish Fact      │                   │                 │
    │                     ├───────────────────────────────────────────────────────►│
```

## Transaction and execution boundaries

1. GitHub polling execution ends after persisting the Fact in Outbox.
2. Rules execution ends after persisting the Development Request.
3. Development execution ends after branch push and both output Events are in Outbox.
4. GitHub action execution ends after PR creation and result Fact publication.

There is no execution spanning all four boundaries and no handler waiting for the next Event.

## Responsibilities

| Concern | Owner |
|---|---|
| Detect label | GitHub Module |
| Decide that label means development | Automation Rules Module |
| Understand ticket | Development Module using bound read capabilities |
| Worktree and branch | Development Module via Workspace/Git capabilities |
| Code, tests, commit, push | Development Module |
| Decide to request a Change Request | Development Module terminal behavior |
| Create provider resource | GitHub Module |
| Decide to review later | Optional Review Module consuming the created Fact |
| Decide to merge later | Optional decision Module; absent in MVP |

## Failure examples

### Development validation fails

Development emits `development.implementation.failed`; no Change Request Request is emitted. GitHub is not involved.

### Branch push succeeds, PR call times out

Development is already complete. GitHub retries the same request using its idempotency key and external lookup.

### Review module is absent

`scm.change-request.created` has zero consumers. This is valid and the workflow naturally stops.

### Auto-merge module is absent

No `scm.change-request.merge-requested` can be emitted, so the provider never merges.

## Concrete fixtures

The JSON chain is under `examples/events/01-...` through `04-...`. The project composition is under `examples/project/.jarvis/project.yaml`.
