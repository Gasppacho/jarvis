# Implementation Sequence

## Method

Le backlog suit des tracer bullets : chaque ticket livre une capacité démontrable à travers les couches nécessaires, sans construire d'abord toutes les APIs, puis toute la persistence, puis toute l'UI. Les dépendances sont explicites dans chaque ticket.

## Phase A — Product walking skeleton

### Ticket 01 — Swift app launches engine and displays health

Première tranche Swift → process → HTTP → TypeScript. Elle fixe les seams de build, bundle et test.

### Ticket 02 — Import a repository as a draft project

Ajoute la première feature utilisateur complète avec sélection native, discovery read-only et persistence.

### Ticket 03 — Restore projects after engine restart

Durcit la persistence et le lifecycle avant d'ajouter les modules.

## Phase B — Modular project composition

### Ticket 04 — Show bundled module catalog and manifests

Introduit le Contract Registry et la validation des packages.

### Ticket 05 — Configure and activate project module instances

Rend le projet composition root et produit le premier validation report.

## Phase C — Durable event runtime

### Ticket 06 — Deliver one durable fact to a sample module

Ajoute event journal, Delivery, Inbox, Outbox et Execution Ledger dans une tranche minimale.

### Ticket 07 — Display project event and execution timeline

Expose la vérité durable dans la UI avant les workflows complexes.

### Ticket 08 — Translate a matching fact with Automation Rules

Valide la chorégraphie : un module transforme un fact en request sans appel direct.

## Phase D — Local development capability

### Ticket 09 — Allocate and clean an isolated Git worktree

Établit la sécurité Git et les leases.

### Ticket 10 — Execute a deterministic Fake Agent Runtime

Traverse module → runtime → workspace → stream → résultat sans dépendance externe.

### Ticket 11 — Development produces a validated pushed branch

Implémente branche, changement, validations, commit, push et événements de sortie avec remote Git local.

### Ticket 12 — Detect and bind a real Codex runtime per project

Remplace le fake derrière le même port et vérifie l'isolation des environnements.

## Phase E — GitHub provider

### Ticket 13 — Register and bind a GitHub connection

Ajoute descriptor, Keychain reference et validation projet.

### Ticket 14 — Create an idempotent Pull Request from a request event

GitHub consomme `scm.change-request.creation-requested` et publie le fact canonique.

### Ticket 15 — Poll GitHub labels into canonical facts

Ajoute la source entrante locale sans webhook public.

### Ticket 16 — Demonstrate agent:ready to Pull Request end-to-end

Connecte les tranches et prouve le workflow de référence dans un repository sandbox.

## Phase F — Reliability, visibility and release

### Ticket 17 — Recover retries and dead letters after crashes

Ajoute failpoints, replay et UI de diagnostic.

### Ticket 18 — Render the emergent module graph and execution controls

Termine la compréhension visuelle et cancellation.

### Ticket 19 — Package, sign and notarize a self-contained DMG

Prouve l'expérience d'installation et l'absence de prérequis Node.

## Parallelism

Les tickets avec blockers satisfaits peuvent être parallélisés seulement si leurs fichiers et seams n'entrent pas en conflit. Le chemin critique reste :

```text
01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09 → 10 → 11 → 12 → 13 → 14 → 15 → 16 → 17 → 18 → 19
```

Certaines étapes de 12/13 peuvent démarrer après 05, mais elles doivent rester intégrées par une tranche verticale et ne pas créer un sous-système horizontal inutilisé.

## Prefactoring rule

Si l'exploration du code réel montre qu'un ticket est difficile à cause d'une structure déjà créée, utiliser `/to-tickets` pour insérer un petit ticket de prefactoring avant lui. Ce ticket doit rendre le changement facile, rester vert et ne pas introduire la feature finale prématurément.
