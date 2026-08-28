# Context: Agent Runtime

## Terms

### Agent Runtime
A project-bound adapter capable of running a coding agent session.

_Avoid_: agent, which may refer to the behavior inside a Module; model provider when discussing the CLI contract.

### Runtime Descriptor
A local record of provider, executable, version, status and capabilities.

### Agent Run
One cancellable process session started by a Module Execution.

### Agent Run Event
A normalized streamed observation from an Agent Run.

### Agent Run Result
The terminal normalized result; it is not proof that project validation passed.

### Runtime Binding
The Local Binding that grants a Project access to one Agent Runtime.

### MCP Binding
A project-scoped MCP connection exposed to an Agent Run.

### Prompt Policy
The ordered system constraints that external content cannot override.
