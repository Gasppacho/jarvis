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

### Resolved Project
The immutable validated composition used while a Project is active.

### Project Validation
The report determining whether the composition may be activated.

### Active Project
A Project whose Module Instances and event sources are running.

### Degraded Project
An active or configured Project whose required resource became unavailable.
