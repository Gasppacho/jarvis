# Context: Project Runtime

## Terms

### Project
The isolated composition root for one repository, selected Module Instances and their local resource choices.

_Avoid_: workspace, which is a temporary Git checkout; repository, which is only one project resource.

### Project Configuration
The project-scoped local selection of Module Instances and their user-facing values.
It is removed with the Project and is never restored from the repository.
Execution commands, Git policy, workspace policy and runtime limits are not Project
Configuration. Their former fields are rejected and removed during database migration.

### Local Bindings
Machine-specific resolution of the repository path, GitHub account and Agent CLI.

### Slot
A stable project name for a required capability, resolved by Local Bindings.

### Project Resource Choice
The read-only, project-scoped intersection of a Slot capability, the capabilities required by Module Instances that reference that Slot, and currently granted resource candidates. Its status and repair guidance may be previewed for a Draft without changing Local Bindings.

### Resolved Project
The immutable validated composition used while a Project is active.

### Project Validation
The persisted result of checking only the external dependencies required by the
selected Modules. Its identity contains the workflow, GitHub account and Agent CLI;
changing the Development label does not invalidate it.

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

### Project Preflight
The read-only assessment of whether the current Project configuration and its bound resources are ready for explicit activation. Configuration readiness is independent of the presence or eligibility of a current Work Item candidate.
