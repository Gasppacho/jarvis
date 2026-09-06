# ADR 0014 — Disclose granted-but-ineligible resources only

**Status:** Accepted
**Date:** 2026-09-06

Ticket #47 asks the Engine to explain, not just hide, why a resource cannot fill
a Portable Configuration Slot. `docs/contracts/PROJECT_CONFIG_V1.md` forbade
disclosing two different things under one rule: a resource never granted to
the Project, and a resource granted to the Project but not eligible for a
particular Slot (missing capability, wrong `kind`, or only a partial
capability match). Reversing either half is a product and security decision,
not an implementation detail, so ticket #47 blocked on the repository owner
making it. The owner made it on 2026-09-06:

**Decision.** Disclose granted-but-ineligible resources only. A resource
already granted to the Project but ineligible for a Slot — missing
capability, wrong `kind`, partial capability match — is named (`ref`, `kind`,
`displayName`, `capabilities`) and explained with the Engine's reason. A
resource **not granted** to the Project stays completely invisible: not
named, not counted, not hinted at, in any form (no entry, no identifier, no
count, no placeholder, no ordering hint, no timing difference).

## Threat boundary

Invariant 2 (`AGENTS.md`): configuration is project-scoped; global registries
only expose candidates a project may use. A Project must never be able to
read the global inventory of connections, runtimes or repositories belonging
to other projects. The boundary this ADR draws is the **grant**, computed by
`ProjectResourceGrantPort.grantedToProject(projectId)`: everything on the
Engine side of that call for this project's `projectId` may be named back to
the project, in full, with the Engine's own reasoning attached. Everything
that call does not return for this `projectId` — because it was never granted,
or was granted to a different project — does not exist for this response, at
any level of detail. The disclosure this ADR adds moves entirely inside a
boundary the Project already sits inside; it draws no new line and does not
touch what crosses the project boundary in the first place.

## What was rejected, and why

An anonymous count or aggregate for non-granted resources ("3 more runtimes
exist but are not granted to this Project") was considered and rejected.
Cardinality is still a leak across the project boundary: it tells a Project
something concrete about another project's or the machine's global inventory
that it has no grant to see, even without a name attached. The only safe
disclosure is one computed entirely from resources already inside this
Project's own grant.

## Compatibility and versioning

`PROJECT_CONFIG_V1` and the Local API contract (`ProjectResourceChoices` /
`ProjectResourceBindingChoice`, served by `GET`/`POST
/v1/projects/{projectId}/binding-candidates`) are extended, not replaced.
`ProjectResourceBindingChoice` gains one field,
`ineligibleGrantedResources`, an array of `{ candidate, reason }`. The field
is **optional**: a response with no granted-but-ineligible resource for a
Slot omits it, and existing consumers (including hand-written Swift fixtures
under `apps/macos/JarvisAppTests` that predate this ticket) keep decoding the
unchanged required shape without modification. No existing field, status
value or required property changes meaning. `candidates` and `items` keep
meaning exactly what they meant before: eligible, project-scoped resources
only. The Engine alone computes both eligibility and the reason text; no
client-side rule reproduces this policy, so a future policy change (e.g. a
new ineligibility case) needs no matching client change beyond decoding one
more string.

`docs/contracts/PROJECT_CONFIG_V1.md` said the candidates list "n'expose
jamais une ressource globale non accordée ni une ressource qui ne satisfait
qu'une partie des capabilities requises" (never exposes a non-granted global
resource, nor a resource that satisfies only part of the required
capabilities). This ADR supersedes only the second half: a granted resource
that only partially matches — or otherwise fails — a Slot's requirements may
now be named, in the new `ineligibleGrantedResources` field, with the
Engine's reason. The first half — never a non-granted global resource — is
unchanged and continues to hold in both `candidates`/`items` and the new
field.
