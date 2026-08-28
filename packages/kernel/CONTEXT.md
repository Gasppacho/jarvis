# Context: Kernel

## Terms

### Kernel
The minimal host that owns system-wide mechanisms and invariants while remaining unaware of module business semantics.

_Avoid_: workflow engine, brain, business orchestrator.

### Module Host
The Kernel service that validates packages and creates project-scoped Module Instances.

### Contract Registry
The registry that maps an event type and version to its schema and known producers/consumers.

### Project Registry
The catalog of Project records and their lifecycle state.

### Connection Registry
The global catalog of connection descriptors; secrets are referenced, not stored in the registry.

### Runtime Registry
The global catalog of detected Agent Runtime descriptors.

### Execution Ledger
The durable record of Module Executions, attempts and terminal outcomes.

### Artifact Store
The project-scoped store for large outputs referenced by events and executions.

### Capability Grant
The resolved, scoped authority exposed to one Module Instance for one Project.
