# ADR 0013 — SwiftPM package assembled by a script, not an Xcode project

**Status:** Accepted
**Date:** 2026-08-29

The macOS shell is a SwiftPM package. `scripts/build-app.sh` assembles `dist/Jarvis.app` from the compiled binary, a generated `Info.plist` and `dist/engine/`. There is no `.xcodeproj` and no project generator.

A hand-maintained `pbxproj` is the least reviewable file in a repository worked by agents, and a project generator would add a development prerequisite for a layout that is a dozen lines of shell. The engine tree is already assembled by `scripts/bundle-runtime.mjs`, so the app bundle follows the same shape. Ticket 19 signs and notarises what the script produces rather than restructuring a bundle-less SwiftPM build.

The cost is that Xcode's own bundling, entitlements editor and scheme management are unavailable: entitlements, signing and notarisation become explicit steps in the release pipeline. That is where ADR 0009 already puts them.
