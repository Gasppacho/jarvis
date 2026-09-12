# Reference Development Workflow

## Recommended guided starting point (#195)

Fresh imports use `ready-for-agent` and the canonical `scm.work-item.ready` v1
Fact. GitHub confirms the issue is open and its complete native `blocked_by`
list contains no open blocker. Already-labelled issues are eligible at activation.
Unknown or blocked observations never start Development. The single Automation
Rule targets the `development` instance. Development itself requests PR creation
after validation and push: there is no second PR rule and no merge permission.

The template preserves discovered repository IDs, target branches and remote names;
`repositories[].remote` identifies the GitHub owner/name through the granted local
repository, while `git.pushRemote` is the explicitly configured Git push destination.
The poller receives a portable repository ID, never an example owner/name. Different
identity and push remotes are supported (and exercised with a bare remote by the harness).
Concurrency is fixed to one in the template. Global connections and runtimes remain
candidates until bound explicitly to this project.

Commands remain proposals. `commands.verify` is offered when the repository declares
that script (`pnpm verify` for Jarvis). The new template has `validationOrder: []` and
no preparation decision. Selecting a validation command confirms it; editing command
text clears that selection, and editing `install` clears preparation. An empty list,
a missing selected command, or absent worktree preparation blocks Engine readiness
and activation, while the incomplete draft remains saveable. Confirm `install`, or
explicitly choose no preparation. Install runs in each fresh worktree before the
agent; selected validations run there after implementation and must pass before push.
Jarvis requires macOS/Xcode command line tools and Swift, Node 24, and the pnpm version
in `packageManager`, with tool paths approved in the project runtime binding.

Custom composition keeps the current draft. Returning to the recommended model asks
for replacement confirmation; declining preserves edits. This replaces modules,
rules and slot requirements, preserving project details and command text. Saving
or choosing a model never activates the project. Review announces pre-existing ready
issues and the manual review/merge boundary before explicit activation.

The existing example below and `examples/project/.jarvis/project.yaml` retain the
historical `agent:ready` / `scm.work-item.tag-added` policy. Opening and saving an
existing project does not migrate labels, rules, IDs, parameters or bindings.
`examples/guided-project/.jarvis/project.yaml` illustrates confirmed choices for a
repository with `verify`; templates do not copy either example into real projects.

## Configuration

The Project enables three Module Instances:

```text
github
  produces scm.work-item.tag-added
  produces scm.work-item.ready
  consumes scm.change-request.creation-requested

automation-rules
  consumes scm.work-item.tag-added
  consumes scm.work-item.ready
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
