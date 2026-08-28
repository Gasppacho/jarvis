# ADR 0011 — Bundled official modules for the MVP

**Status:** Accepted  
**Date:** 2026-08-28

The production MVP loads only official module packages bundled and registered at build time. Project instances remain dynamic, but arbitrary third-party package loading is deferred because signing, isolation, compatibility and permission review require a separate security design.
