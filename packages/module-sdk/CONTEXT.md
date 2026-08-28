# Context: Module SDK

## Terms

### Module
A versioned executable bounded context that consumes and produces Events.

_Avoid_: extension, plugin when discussing the domain boundary, step, node.

### Module Package
The globally available code and manifest for a Module version.

### Module Instance
One Project-scoped configured activation of a Module Package.

### Manifest
The declarative contract of a Module Package: identity, events, capabilities, configuration and permissions.

### Handler
The module entrypoint invoked for one Delivery.

### Module Context
The scoped execution object containing input, Outbox publisher, capabilities, logger, artifacts and cancellation.

### Agentic Asset
A loop, agent, tool or prompt owned internally by a Module.

_Avoid_: submodule unless it has an independent bounded context and event contract.

### Module Configuration
Non-secret settings of one Module Instance stored in the Portable Configuration.
