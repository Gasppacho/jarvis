# Issue #195 — executed verification

Date: 2026-09-12. Implementation base: `56d8e379395b49967ee40aa6e046909f72cc33c6`.
Worktree: `/private/tmp/jarvis-issue-195`. Dependencies #190 and #193 were present
on the fetched `origin/main`; issue comments were empty when read.

## Requirements and evidence

| Requirement | Executed proof |
| --- | --- |
| Import GitHub and choose three official instances without implicit resource grants | Swift `testFreshImportOffersGuidedStartingPointsAndRefreshesHumanModuleCards`; composition-choices API test; guided harness checks empty slots before explicit binding |
| Coherent repository owner/name, portable ID, remote and target mapping | Engine-provided mapping asserted by Swift and composition-choices API; guided harness retains portable `main`, explicitly selects GitHub identity remote `github` and pushes to local bare `origin` |
| Unique Request consumers and exactly one PR | Guided harness validates the two routes to `development` and `github`, observes validation `verify: passed`, compares completion commit with the real bare-remote branch, and observes one PR after restart |
| Open blocker and historical label excluded from new model | Guided harness seeds eligible #195, blocked #196, historical-label-only #197; only #195 starts and one Request/PR exists |
| Existing `agent:ready` configuration preserved | Historical PR harness pauses, saves and reopens; complete portable configuration and bindings remain equal, then the original tag-added workflow produces one PR |
| Custom draft replacement needs confirmation | Swift checks a slots-only draft and an edited composition, cancellation preserves exact draft; confirmed replacement keeps command text |
| Draft does not poll or launch an agent | Guided harness waits multiple accelerated poll intervals before activation; zero issue requests and empty runtime invocation counter; activation of incomplete configuration returns 409 |
| Empty/unconfirmed/missing commands cannot be ready | New template has empty validationOrder and absent preparation; Engine report rejects it while save succeeds; command editing clears validation selection; missing-command test rejects activation before any execution, worktree, outbox or dead letter |
| Human label, preparation, command and activation controls | Swift exercises dedicated and schema-backed label edits, selected commands and reapproval; native UI shows command context, prerequisites, mapping and pre-existing-issue notice |
| Stop at PR, no auto-merge | No merge rule or permission added; guided harness asserts no merge event |

## Commands and results

- `rtk pnpm install --frozen-lockfile`: succeeded in the isolated worktree.
- Red: `rtk pnpm exec vitest run --project unit apps/engine/src/projects/discovery.test.ts`
  failed because the declared verify script was not proposed. Green: 17/17.
- Red: `rtk proxy swift test --package-path apps/macos --filter testFreshImportOffersGuidedStartingPointsAndRefreshesHumanModuleCards`
  failed on preselected validationOrder and implicit preparation. Final targeted rerun passed.
- `rtk pnpm build:engine`: succeeded.
- `rtk pnpm exec vitest run --project integration apps/engine/test/reference-workflow-pull-request.integration.test.ts`:
  2/2 passed (new guided and preserved historical workflows).
- Targeted workflow/composition/Development run: 33/33 passed.
- `rtk pnpm test:swift`: final run through verify passed, 167/167.
- `rtk pnpm verify`: exit 0; contracts, generation parity, formatting, TypeScript,
  architecture, Engine and release app builds; 356 unit, 363 integration and 167 Swift tests passed.
- Guided example separately validated against project schema and all three module schemas.
- `rtk proxy graft build`: refreshed 267 source cards; local cache kept outside the deliverable.
- `rtk git diff --check`: clean.

The generated API change was staged before the full gate so generate:check compares
regeneration against the intended generated artifact. No tests were disabled.
An earlier full unit run hit a Codex authentication-probe timeout (`version: null`);
its isolated 26-test suite and the final complete gate passed unchanged. Earlier
integration failures were resolved by confirming preparation in polling fixtures and
moving the missing-command assertion to the now-earlier activation boundary. The
Swift mapping test fixture was corrected to actually declare a GitHub remote.

## Review

Independent Standards and Spec reviews found four distinct issues: an alternate
label control bypassed synchronization, slots-only custom drafts were unprotected,
owner/name was absent from the mapping display, and Review overstated protections
for historical/custom projects. All were corrected; both second reviews returned
zero remaining findings. No dependency, provider or central workflow was added.

The tests use real repositories, bare remotes, SQLite and child processes with fake
external services. They do not create a real GitHub PR or launch real Codex work.
Native controls and the packaged app build are covered; no manual VoiceOver or GUI
interaction session is claimed.
