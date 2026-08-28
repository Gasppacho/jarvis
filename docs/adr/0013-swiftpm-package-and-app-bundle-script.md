# ADR 0013 — SwiftPM package plus an assembly script for `Jarvis.app`

**Status:** Accepted
**Date:** 2026-08-28

The macOS shell is a SwiftPM package (`apps/macos/Package.swift`) with a `JarvisCore`
library, a `JarvisAPI` target generated from the OpenAPI contract, and a `JarvisApp`
executable. `scripts/make-app-bundle.sh` assembles `Jarvis.app` around the built
executable and `dist/engine`.

A committed `.xcodeproj` was rejected: it is a generated, merge-hostile file that no
reviewer reads, and it would make the engine resources a manual build-phase concern.
A package keeps `swift build` and `swift test` headless in CI and lets the OpenAPI
generator run as a build plugin, so no hand-written DTO can drift from
`contracts/openapi/local-api.v1.yaml`. `xcodebuild -scheme Jarvis` also works against
the package, but it needs `-skipPackagePluginValidation`: Xcode otherwise blocks on an
interactive prompt to approve the generator plugin, which fails in CI.

The cost is that XCUITest, entitlements, signing and notarisation need the bundle the
script produces rather than an Xcode target. Ticket 19 owns that pipeline and may add
an Xcode project or `xcodebuild` archive step for signing without changing this layout.
