# ADR 0006 — SwiftUI shell with TypeScript engine

**Status:** Accepted  
**Date:** 2026-08-28

The native shell is built with SwiftUI/AppKit, while the embedded engine and official modules use strict TypeScript. Swift provides first-class macOS integration; TypeScript provides mature agent, MCP, CLI and schema ecosystems. A versioned local API prevents either side from owning the other's business logic.
