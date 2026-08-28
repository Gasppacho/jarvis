# Context: Automation Rules

## Terms

### Rule
A project-configured mapping from a matching Fact to a new Request.

_Avoid_: workflow, pipeline, orchestration.

### Matcher
The pure predicate evaluated against an Event and project configuration.

### Emission Template
The declared Request type, target and payload projection produced by a Rule.

### Rule Match
The durable decision that one Rule matched one input Event.

### Rule Set
The ordered collection of Rules owned by one Module Instance.

### Projection
A safe mapping from input fields and constants into an output payload.

_Avoid_: arbitrary script; the MVP rules language is declarative and bounded.
