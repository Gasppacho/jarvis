# Context: GitHub Integration

## Terms

### GitHub Connection
A project-bindable descriptor granting the provider access to selected GitHub resources.

### External Work Item
A GitHub Issue translated to a canonical Work Item reference.

_Avoid_: Work Item inside GitHub adapter internals when the concrete Issue behavior matters.

### Pull Request
The GitHub representation of a canonical Change Request.

_Avoid_: Pull Request in cross-module event names.

### External Mapping
The idempotent relation between a Jarvis request key and a GitHub resource.

### Poll Cursor
The durable position or timestamp used by the inbound observer.

### Observed Fact
A canonical Fact emitted after detecting GitHub state, regardless of who caused it.

### Provider Action
An idempotent GitHub mutation performed only in response to a targeted Request.
