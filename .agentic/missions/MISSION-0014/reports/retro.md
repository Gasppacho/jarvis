# MISSION-0014 Retro

## What worked

- Checking lock state before building avoided repeating the prior locked-session failure.
- macOS accessibility scripting made the required UI states reachable without changing implementation.
- A temporary Jarvis capture revealed a home-directory path early; deleting it and scrolling to Local Bindings kept retained evidence clean.
- The same Project exposed both required states: an empty-candidate incompatible Slot and an available Slot that could be bound.

## Friction

- The lock-state query returned no property rather than an explicit `<false/>`; importantly, it did not return the contract's locked marker `<true/>`.
- Keyboard End did not scroll the SwiftUI detail pane until its accessibility scroll bar was targeted directly.

## Keep

- Capture the app window region only.
- Inspect temporary captures for privacy before writing final evidence.
- Use explicit Git staging paths in repositories with unrelated untracked mission material.
