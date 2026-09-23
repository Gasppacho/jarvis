# Reference Development Workflow

## Canonical GitHub → Development flow

Fresh imports start with an empty `fixed-modules` composition. The user may select
GitHub, Development, both or neither. When both are selected, GitHub confirms the
issue is open and its complete native `blocked_by` list contains no open blocker;
Development owns the admission predicate and requests PR creation after push. No user
rule, editable target, payload mapping or merge permission exists.

`repositories[].remote` identifies the GitHub owner/name through the granted local
repository. Branch, push destination, worktree, command and concurrency policy are
internal to Development. Global connections and runtimes remain candidates until the
user selects one explicitly for this Project.

Development may run its detected installation step in each fresh worktree before the
agent. It does not run a second project-validation plan after the agent. None of these
internal choices appear in Project configuration.

Selecting or removing a Module never activates the Project. Removing one also removes
its settings and bindings; selecting it again starts from its defaults.

## Guided configuration and proof

After the read-only repository import, native configuration has exactly three screens:
**Workflow → Paramétrage → Vérification**. The canvas explains the Engine-declared
events; it is not a second routing model. Verification checks only the selected
external dependencies without running the agent or repository commands.

When both Modules are selected, the chain is `scm.work-item.observed` →
`development.implementation.requested` → Development preparation, agent,
commit and push → `scm.change-request.creation-requested` → GitHub PR creation.
The overview keeps the failed execution linked even after removal of the trigger label. Pausing stops
new admissions; cancelling an active execution is a separate explicit action.

The [progress ledger](../../PROGRESS.md) distinguishes Harness coverage, native
screenshots and real GitHub/Codex delivery. None substitutes for another.

## Fixed catalogue

The catalogue offers these two Module Instances, each selectable at most once:

```text
github
  produces scm.work-item.tag-added
  consumes scm.change-request.creation-requested

development
  consumes scm.work-item.observed
  produces development.implementation.requested
  produces development.implementation.completed
  produces scm.change-request.creation-requested
```

Development owns the fixed admission predicate after GitHub observation. The
descriptor contains `readyLabel`, `scope` and the confirmed project bindings;
there is no editable rule, target or payload mapping.

## Historical archive: sequence (`agent:ready`)

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

This diagram documents the retired L12 composition for migration and audit. It
is not an active catalog option, handler or acceptance target.

## Transaction and execution boundaries

1. GitHub polling execution ends after persisting the Fact in Outbox.
2. Development admission and implementation are separate finite executions;
   admission ends after persisting the targeted Request.
3. Development implementation ends after branch push and both output Events are in Outbox.
4. GitHub action execution ends after PR creation and result Fact publication.

There is no execution spanning all four boundaries and no handler waiting for the next Event.

## Responsibilities

| Concern | Owner |
|---|---|
| Detect label | GitHub Module |
| Decide whether an observed issue is eligible | Development Module |
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
