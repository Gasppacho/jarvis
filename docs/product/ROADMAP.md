# Roadmap

## M0 — Foundation documents and contracts

- Valider le vocabulaire, les ADR et les contrats v1.
- Créer le repository, la CI et les tests de validation documentaire.
- Publier les tickets tracer-bullet.

## M1 — Native walking skeleton

- SwiftUI app lancée par double-clic.
- Moteur TypeScript supervisé.
- Handshake sécurisé, health API et SSE.
- Packaging de développement local.

## M2 — Project composition

- Import d'un repository.
- Détection de l'écosystème.
- Configuration portable et bindings locaux.
- Module catalog, instances et validation du graphe.

## M3 — Durable event runtime (historical delivery)

- SQLite, migrations, Inbox, Outbox et Execution Ledger.
- Routing request/fact par projet.
- Timeline et reprise après redémarrage.
- Event routing, Inbox/Outbox and bounded retries.

## M4 — Development vertical slice (historical delivery)

- Workspace Manager et worktrees.
- Fake Agent Runtime puis adapter Codex CLI.
- Development Module : changement, commit et push.
- GitHub connection, polling entrant et création de Pull Request.
- Démonstration historique `agent:ready → PR`, conservée pour l'archive de migration.

## M5 — Product hardening

- Retries, dead letters, idempotence et diagnostics.
- Graphe émergent et UI d'exécutions.
- Signature, hardened runtime, notarisation et DMG.
- Test de mise à jour et crash recovery.

## Post-MVP

Ordre recommandé :

1. Change Request Review Module.
2. CI Observer et CI Fix Module.
3. Module de décision Auto Merge, désactivé par défaut.
4. GitLab Provider.
5. Ticket Refinement Module.
6. Multi-repository par projet.
7. SDK de modules tiers et signature des packages.
8. Nouveaux domaines d'automatisation au-delà du développement.
