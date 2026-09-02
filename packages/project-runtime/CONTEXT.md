# Context: Project Runtime

## Terms

### Project
The isolated composition root for repositories, Module Instances, bindings, commands and limits.

_Avoid_: workspace, which is a temporary Git checkout; repository, which is only one project resource.

### Portable Configuration
The committed, machine-independent `.jarvis/project.yaml` definition.

### Local Bindings
Machine-specific resolution of repository paths, connections, MCP and Agent Runtimes.

### Slot
A stable project name for a required capability, resolved by Local Bindings.

### Project Resource Choice
The read-only, project-scoped intersection of a Slot capability, the capabilities required by Module Instances that reference that Slot, and currently granted resource candidates. Its status and repair guidance may be previewed for a Draft without changing Local Bindings.

### Resolved Project
The immutable validated composition used while a Project is active.

### Project Validation
The read-only evaluation determining whether a saved Project composition may be activated. Project Runtime owns this policy behind `ProjectCompositionValidationPort`; adapters supply a `SavedProjectCompositionValidationInput` loaded from persisted Portable Configuration, Local Bindings, project grants and local repository availability.

### Project Request Route
The unique producer-to-consumer edge resolved for one versioned Request Event in a Project.

### Project Satisfied Capability
A capability requirement, optional or required, whose target (Project slot or Module Instance) resolves to an eligible project-scoped resource. A Project repository is reported with the distinct `repository` source kind.

### Project Validation Finding
A stable, actionable result identifying why a saved composition cannot be activated and the affected instance, slot or event edge. An unknown, rejected or unavailable Module Package is distinct from invalid instance configuration and targets the instance's `/moduleId` field.

### Active Project
A Project whose Module Instances and event sources are running.

### Degraded Project
An active or configured Project whose required resource became unavailable.
