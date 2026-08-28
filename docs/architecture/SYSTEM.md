# System Architecture

## Architectural style

Jarvis est un **modular monolith local** livré comme une seule application macOS. Le produit contient deux processus coopérant sur la même machine :

```text
┌──────────────────────────────────────────────────────────────┐
│                         Jarvis.app                           │
│                                                              │
│  ┌────────────────────────┐     Local API + SSE             │
│  │ macOS Shell            │◄──────────────────────────┐      │
│  │ SwiftUI / AppKit       │                           │      │
│  └────────────┬───────────┘                           │      │
│               │ supervises                            │      │
│  ┌────────────▼───────────────────────────────────────────┐  │
│  │ Jarvis Engine — TypeScript / bundled Node.js LTS      │  │
│  │                                                       │  │
│  │ Kernel · Project Runtime · Eventing · Persistence     │  │
│  │ Module Host · Agent Runtime · Workspace Manager       │  │
│  │ Official Modules                                     │  │
│  └─────────────────────────────┬─────────────────────────┘  │
│                                │                            │
│                     SQLite · Git · CLI · MCP                │
└──────────────────────────────────────────────────────────────┘
```

La séparation de processus améliore la robustesse et permet d'utiliser l'écosystème TypeScript/CLI sans exposer une complexité opérationnelle. L'utilisateur installe, démarre, met à jour et quitte un seul produit.

## Technology baseline

| Area | Decision |
|---|---|
| macOS UI | Swift, SwiftUI, AppKit lorsque nécessaire |
| Minimum target | Apple Silicon, macOS 15+ pour le MVP |
| Engine | TypeScript strict, ESM, Node.js 24 LTS embarqué |
| Monorepo | `pnpm` workspaces |
| Local API | HTTP loopback, OpenAPI 3.1, SSE pour les mises à jour |
| Swift API client | Généré depuis OpenAPI avec Swift OpenAPI Generator |
| Persistence | SQLite, WAL, migrations versionnées, driver stable épinglé |
| Validation | JSON Schema 2020-12 aux frontières événement/configuration |
| External tooling | Git, `gh`, runtimes agentiques et MCP détectés puis bindés par projet |
| Distribution | Developer ID, hardened runtime, notarisation, DMG |

## Top-level components

### macOS Shell

Responsable de l'expérience native, du choix des dossiers, du trousseau, de la supervision du moteur et de l'affichage. Il ne contient aucune règle métier de module.

### Engine Supervisor

Le shell génère un token aléatoire, lance le moteur enfant, lit son message `ready`, surveille sa santé et ordonne son arrêt. Il collecte stderr seulement pour le diagnostic de bootstrap.

### Kernel

Le Kernel fournit les mécanismes partagés : Project Registry, Module Host, Contract Registry, Event Bus, Execution Ledger, Connection Registry, Runtime Registry, Artifact Store et Scheduler. Il ne contient pas de règles propres à un workflow.

### Project Runtime

Chaque projet activé possède un runtime logique isolé qui :

- résout sa configuration portable et ses bindings locaux ;
- instancie ses modules ;
- construit ses subscriptions ;
- interdit la livraison cross-project ;
- limite concurrence, workspaces et ressources ;
- expose son état au Kernel.

### Module Host

Charge les packages officiels connus, valide leur manifeste, crée les instances projet et invoque leurs handlers via le Module SDK.

### Eventing

Persiste, route et délivre des événements versionnés. Les facts se diffusent ; les requests sont résolues vers un unique consommateur. Inbox, Outbox, retries et dead letters assurent la fiabilité.

### Agent Runtime

Fournit un port commun pour les CLIs agentiques. Il construit un environnement minimal à partir des bindings du projet et transmet les tools/MCP autorisés.

### Workspace Manager

Alloue un worktree et un lease par exécution de développement, protège le repository principal et nettoie selon le résultat.

## Startup protocol

1. `Jarvis.app` génère un token bearer de 256 bits et un identifiant de session.
2. Le shell lance l'exécutable moteur embarqué avec le token transmis par descripteur ou environnement éphémère.
3. Le moteur bind `127.0.0.1` sur un port dynamique, exécute les migrations et valide son build.
4. Le moteur écrit une unique ligne JSON sur stdout :

```json
{"type":"ready","port":43127,"apiVersion":"v1","sessionId":"..."}
```

5. Le shell crée le client OpenAPI avec le token et appelle `/v1/health`.
6. Le moteur charge les projets marqués actifs et valide chaque composition avant de démarrer ses pollers/schedulers.
7. Le shell ouvre le flux SSE et hydrate l'état de l'interface.

Aucun autre processus local ne doit pouvoir invoquer l'API sans token. Le moteur refuse les hosts non-loopback.

## Shutdown protocol

1. Le shell envoie `POST /v1/system/shutdown`.
2. Les projets passent en `draining` : aucune nouvelle delivery n'est réclamée.
3. Les exécutions annulables reçoivent un signal ; les transactions courtes terminent.
4. Les cursors, logs et états sont flushés.
5. Le moteur ferme SQLite et répond, puis sort.
6. Après un délai borné, le shell termine le processus si nécessaire.

Un arrêt brutal ne doit pas perdre un événement commité : la reprise s'appuie sur Inbox/Outbox et les leases expirables.

## Dependency rules

```text
apps/macos ───────► Local API contract
engine/bootstrap ─► Kernel public ports
Kernel ───────────► shared primitives only
Project Runtime ──► Module SDK, Eventing, registries
Modules ──────────► Module SDK + their own internals
Modules ──X───────► another module implementation
```

Le package `shared-kernel` doit rester petit : IDs, clock, result/error primitives, serialization metadata. Aucun `WorkItem`, `ChangeRequest` ou modèle GitHub n'y appartient sauf sous forme de contrat d'intégration versionné.

## Reference flow

```text
GitHub Poller
  → fact scm.work-item.tag-added
Automation Rules
  → request development.implementation.requested
Development
  → worktree → agent → validate → commit → push
  → fact development.implementation.completed
  → request scm.change-request.creation-requested
GitHub Action Handler
  → external Pull Request
  → fact scm.change-request.created
```

Chaque flèche après un module correspond à une transaction locale terminée et une nouvelle delivery. Aucune exécution globale ne reste suspendue en attente de l'étape suivante.

## Repository shape

```text
/
├── apps/
│   ├── macos/
│   └── engine/
├── packages/
│   ├── kernel/
│   ├── eventing/
│   ├── persistence/
│   ├── project-runtime/
│   ├── module-sdk/
│   ├── agent-runtime/
│   ├── workspace/
│   ├── local-api/
│   └── modules/
│       ├── github/
│       ├── automation-rules/
│       ├── development/
│       └── change-request-review/
├── contracts/
├── docs/
└── .scratch/
```

## Evolution rule

Le monolithe modulaire est un choix de déploiement, pas un couplage de domaine. Si un jour un module doit sortir du processus, ses contrats événementiels, son Inbox et son ownership de données fournissent déjà la frontière. Aucune distribution n'est nécessaire au MVP.
