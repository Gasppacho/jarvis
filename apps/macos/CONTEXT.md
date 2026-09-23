# Context: macOS Shell

## Terms

### macOS Shell
The native application surface that supervises the Engine and presents Jarvis state.

_Avoid_: client app when it suggests a remote service; frontend when discussing the product boundary.

### Engine Supervisor
The shell component that launches, authenticates, monitors and stops the embedded Engine process.

_Avoid_: orchestrator, because it does not orchestrate module workflow.

### Engine Session
One authenticated lifetime shared by a shell launch and one Engine process.

### Local API
The versioned loopback contract used by the shell to command and observe the Engine.

### Project Overview
The first operational read model shown after Project activation: workflow progress,
GitHub readiness, polling health and pause state for one Project.

_Avoid_: recomputing eligibility in the Shell; the Engine owns reasons and claims.

### Repository Grant
User-approved local access to a repository folder, represented by a durable local reference.

_Avoid_: project permission, which also includes non-filesystem bindings.

### Project Wizard
The three-screen native flow for Workflow selection, Module settings and external
dependency verification before Project creation or configuration application.

### Live Update
An ephemeral UI notification from the Engine. Durable truth remains queryable through the Local API.
