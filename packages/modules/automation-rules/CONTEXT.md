# Context: Automation Rules

## Terms

### Rule
A project-configured mapping from a matching Fact to a new Request.

_Avoid_: workflow, pipeline, orchestration.

### Matcher
The pure predicate evaluated against an Event and project configuration.

### Emission Template
The declared Request type, target and payload projection produced by a Rule.

A Rule's static `emit.payload` wins over every derived value; whatever it
leaves unset is derived — the Work Item reference from the input Fact, the
repository and base branch from the activated project-scoped context. A
required field with neither a static value nor a project-scoped source is a
terminal failure, never an invented repository or branch. The reference
composition configures no `emit.payload` and is fully derived.

### Rule Match
The durable decision that one Rule matched one input Event. A Fact matching no
Rule produces no Rule Match and no Request, and still completes as an auditable
terminal Execution.

### Rule Set
The ordered collection of Rules owned by one Module Instance.

**First matching Rule wins.** Rules are evaluated in configured order and
evaluation stops at the first match, so one input Fact yields at most one Rule
Match and at most one emitted Request per Module Instance — never one emission
per matching Rule. Reordering a Rule Set therefore changes which Rule is
selected. Each Module Instance evaluates its own Rule Set independently, within
its own Project.

### Projection
A safe mapping from input fields and constants into an output payload.

_Avoid_: arbitrary script; the MVP rules language is declarative and bounded.
