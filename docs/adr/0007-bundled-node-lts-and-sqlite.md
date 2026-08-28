# ADR 0007 — Bundled Node.js LTS and SQLite

**Status:** Accepted  
**Date:** 2026-08-28

Jarvis bundles an official Node.js 24 LTS runtime and a pinned stable SQLite driver with the app. Users do not install Node.js. SQLite WAL provides durable local transactions for Inbox, Outbox and the Execution Ledger without an external database; the persistence adapter hides the concrete driver.
