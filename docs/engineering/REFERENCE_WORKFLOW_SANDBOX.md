# Real GitHub reference-workflow sandbox

This is an opt-in manual acceptance runbook. It is never part of `rtk proxy pnpm verify`.

## Safety boundary

Use a newly created, private, disposable GitHub repository owned by the operator. Never use a Jarvis repository, a production repository, or a client repository. Do not copy private source, credentials, tickets, or repository content into the sandbox. Delete or close every generated resource after the run.

## Prerequisites

- macOS development prerequisites from `docs/engineering/LOCAL_DEVELOPMENT.md`;
- authenticated `gh` CLI with permission to create and delete a private sandbox repository;
- a detected, authenticated `runtime/codex-default` Agent Runtime;
- a clean disposable local checkout and a disposable local Jarvis data root;
- the current Jarvis build and generated contracts.

Confirm the runtime and GitHub connection are available before activating the project. Do not put a token in project configuration, environment files, events, prompts, logs, or this document. Jarvis should resolve the GitHub credential through the authenticated `gh` adapter and store only an opaque `secretRef`.

## Isolated project setup

1. Create a new private repository with no relationship to any project or client repository. Add only a minimal fixture matching the reference workflow: a valid `.jarvis/project.yaml`, a `main` branch, and the project validation command.
2. Import that checkout as a new Jarvis Project and use a disposable `JARVIS_DATA_ROOT`.
3. Register and validate a dedicated GitHub connection for the sandbox account. Bind that connection to both `sourceControl` and `tickets`.
4. Bind `agentRuntime` to the detected real `runtime/codex-default` candidate. Do not rely on a global candidate without a Project Binding.
5. Configure the GitHub module to poll only the new sandbox repository. Bind Development to its repository, `tickets`, and `sourceControl`; keep the validated branch pattern, push remote, bounded timeout, output limit, and validation commands from the project example.
6. Validate the composition and activate the Project. Record only safe identifiers needed for cleanup; do not record tokens, personal absolute paths, or source content.

## Run

Create one simple, disposable GitHub Issue in the sandbox. Its body must request a small demonstrable change and an automated test. Add the exact label `agent:ready` once, then wait for the workflow to settle.

Observe the safe Engine/API timeline and GitHub UI. The expected chain is:

1. one logical `scm.work-item.tag-added` fact;
2. one `development.implementation.requested` request;
3. Development's execution creates a non-empty commit and pushes one `agent/{workItemId}-{slug}` branch;
4. one `scm.change-request.creation-requested` request with stable idempotency;
5. one Pull Request and one `scm.change-request.created` fact.

Record the Issue number, pushed branch, Pull Request URL and the four conceptual execution boundaries: GitHub polling, Automation Rules, Development, and GitHub action. The polling boundary ends after its Outbox fact; it is not a long-running execution spanning the other three. Confirm correlation and causation link the timeline, and that a redelivery leaves one branch and one Pull Request. Do not treat ticket, repository, prompt, or provider payload text as Jarvis policy.

## Cleanup

Before removing the sandbox, verify that no worktree or process remains active. Close the Issue, close the Pull Request, delete the pushed branch, and delete the private repository. Remove the disposable local checkout and data root. Confirm that the normal project and client repositories were never configured as targets.

If an outcome is recorded on the issue tracker, record only the safe Issue number, branch name, Pull Request URL, conceptual execution observations, and cleanup status. Never record tokens, personal absolute paths, or sandbox source content. This document intentionally records no run outcome; a real run must be performed and reported separately rather than fabricated.

## Assumptions

This runbook follows the project example's portable slots and module bindings, the fixture's isolated repository/connection/runtime composition, and the documented security rule that credentials remain opaque and Project-scoped. The operator supplies the disposable repository, authenticated account, runtime availability, and real-run outcome.
