# MISSION-0004 Retro

## What worked

- Local merge history, rather than unchanged GitHub labels or open issue state, identified #36 as the frontier.
- Extending the #34 composition-choice tracer bullet kept template, package, instance and Event guidance in one read-only Project-scoped response.
- Application Harness and XCTest produced clear red/green evidence at the agreed seams.
- Reusing Project Validation findings prevented the UI from inventing resource compatibility policy.
- Revision-gated preview refresh preserves newer Draft edits when asynchronous responses arrive out of order.
- Staging generated output before `pnpm verify` allowed `generate:check` to verify regeneration without an early ticket commit.

## What to improve

- The OpenAPI generator emits several untyped value containers for inline enums/unions. Future contract work should prefer named schemas where that yields stronger generated Swift enums and avoids JSON re-decoding adapters.
- The mission material should explicitly say that the full verification gate may stage intended files before commit because `generate:check` compares generated worktree output to the index.
- Starting-point confirmation behavior may need product refinement if later tickets make reapplying a template destructive enough to warrant a confirmation; #36 intentionally keeps it a direct editable-Draft action.
- Engine service availability currently appears as a missing `shell.execute` resource in validation-derived cards in test fixtures. A later resource/readiness slice should ensure the user-facing explanation distinguishes built-in Engine services from user-bindable resources.
