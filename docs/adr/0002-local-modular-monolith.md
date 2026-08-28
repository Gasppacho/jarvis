# ADR 0002 — Local modular monolith

**Status:** Accepted  
**Date:** 2026-08-28

The MVP engine is a local modular monolith. Bounded contexts have enforced package, data and contract boundaries but share one deployment and SQLite database. Distributed processes or brokers would add operational cost before scale requires them; event contracts keep later extraction possible.
