# Jarvis — Development Pack

Ce dépôt documentaire constitue la source de vérité initiale pour développer **Jarvis**, une application macOS native permettant d'assembler et d'exécuter des automatisations agentiques modulaires, locales et pilotées par événements.

## Décisions déjà prises

- Jarvis est livré comme **une seule application macOS**, installée et démarrée par l'utilisateur comme un seul produit.
- L'interface et l'exécution tournent sur **le même Mac**. Deux processus internes sont autorisés pour la robustesse, mais ils restent embarqués dans `Jarvis.app`.
- L'interface est native en **SwiftUI/AppKit**.
- Le moteur local et les modules officiels sont écrits en **TypeScript** et exécutés par un runtime Node.js LTS embarqué.
- Le système est un **modular monolith DDD**. Un module est un bounded context exécutable pouvant contenir handlers, loops, agents, tools, prompts, état et adaptateurs.
- Les modules ne s'appellent jamais directement. Ils se composent par **chorégraphie événementielle**.
- Une exécution de module effectue un travail fini, publie zéro, un ou plusieurs événements, puis se termine. Un événement ultérieur démarre une nouvelle exécution ; il ne reprend pas une ancienne loop.
- Toute configuration métier et technique est faite **par projet** : modules, connexions, MCP, runtime agentique, commandes, conventions Git et règles.
- Dans les modules de développement, le module propriétaire du travail gère le worktree, la branche, les modifications, les tests, le commit et le push.
- Le provider de code source crée la Pull Request ou Merge Request uniquement lorsqu'il reçoit une demande canonique de création de **Change Request**.
- Aucun merge automatique n'a lieu si aucun module ne publie de demande de merge.

## Par où commencer

1. Lire [`START_HERE.md`](START_HERE.md).
2. Installer les skills de Matt Pocock et vérifier le setup du dépôt.
3. Lire [`AGENTS.md`](AGENTS.md), puis [`CONTEXT-MAP.md`](CONTEXT-MAP.md).
4. Utiliser [`docs/product/MVP_SPEC.md`](docs/product/MVP_SPEC.md) comme spécification produit du premier incrément.
5. Implémenter les tickets de [`.scratch/jarvis-mvp/issues`](.scratch/jarvis-mvp/issues) dans l'ordre de leurs dépendances.
6. Ne modifier une décision structurante qu'en ajoutant ou remplaçant un ADR dans [`docs/adr`](docs/adr).

## Carte de la documentation

| Besoin | Source de vérité |
|---|---|
| Vision et principes produit | [`docs/product/VISION.md`](docs/product/VISION.md) |
| Périmètre MVP | [`docs/product/MVP_SPEC.md`](docs/product/MVP_SPEC.md) |
| Parcours et écrans macOS | [`docs/product/UX.md`](docs/product/UX.md) |
| Architecture globale | [`docs/architecture/SYSTEM.md`](docs/architecture/SYSTEM.md) |
| Modèle de modules | [`docs/architecture/MODULES.md`](docs/architecture/MODULES.md) |
| Événements et routage | [`docs/architecture/EVENTS.md`](docs/architecture/EVENTS.md) |
| Configuration par projet | [`docs/architecture/PROJECTS.md`](docs/architecture/PROJECTS.md) |
| Connexions, MCP et bindings | [`docs/architecture/CONNECTIONS_AND_BINDINGS.md`](docs/architecture/CONNECTIONS_AND_BINDINGS.md) |
| Workflow de référence détaillé | [`docs/architecture/REFERENCE_WORKFLOW.md`](docs/architecture/REFERENCE_WORKFLOW.md) |
| Stack technique | [`docs/architecture/TECHNOLOGY_STACK.md`](docs/architecture/TECHNOLOGY_STACK.md) |
| Exécutions et loops | [`docs/architecture/EXECUTIONS.md`](docs/architecture/EXECUTIONS.md) |
| Runtimes agentiques et MCP | [`docs/architecture/AGENT_RUNTIMES.md`](docs/architecture/AGENT_RUNTIMES.md) |
| Sécurité | [`docs/architecture/SECURITY.md`](docs/architecture/SECURITY.md) |
| Stratégie de tests | [`docs/architecture/TESTING.md`](docs/architecture/TESTING.md) |
| Contrats versionnés | [`docs/contracts`](docs/contracts) et [`contracts`](contracts) |
| Catalogue des événements v1 | [`docs/contracts/EVENT_CATALOG_V1.md`](docs/contracts/EVENT_CATALOG_V1.md) |
| Capabilities et erreurs v1 | [`docs/contracts/CAPABILITY_CATALOG_V1.md`](docs/contracts/CAPABILITY_CATALOG_V1.md), [`docs/contracts/ERROR_CODES_V1.md`](docs/contracts/ERROR_CODES_V1.md) |
| Développement local et fixtures | [`docs/engineering`](docs/engineering) |
| Décisions structurantes | [`docs/adr`](docs/adr) |
| Ordre de construction | [`docs/plans/IMPLEMENTATION_SEQUENCE.md`](docs/plans/IMPLEMENTATION_SEQUENCE.md) |
| Critères de sortie MVP | [`docs/plans/MVP_ACCEPTANCE.md`](docs/plans/MVP_ACCEPTANCE.md) |
| Instructions destinées aux agents | [`docs/agents`](docs/agents) |

## Vertical slice de référence

```text
GitHub Issue + label agent:ready
        ↓
GitHub Module publie scm.work-item.tag-added
        ↓
Automation Rules Module publie development.implementation.requested
        ↓
Development Module
  lit le ticket, crée un worktree et une branche,
  implémente, teste, commit et push
        ↓
publie scm.change-request.creation-requested
        ↓
GitHub Module crée la Pull Request
        ↓
publie scm.change-request.created
```

Le module de review est volontairement optionnel pour le MVP. Son ajout ne modifie aucun module existant : il suffit qu'il consomme `scm.change-request.created`.

## Validation du pack

```bash
python3 -m pip install -r scripts/requirements-docs.txt
python3 scripts/validate-pack.py
```

Le rapport de génération est disponible dans [`VALIDATION_REPORT.md`](VALIDATION_REPORT.md).

## État du pack

Ce pack est une **baseline prête à coder**. Les fichiers JSON Schema et OpenAPI sont contractuels ; les exemples doivent rester validables par ces contrats. Les tickets sont des propositions de tracer bullets et peuvent être publiés dans GitHub Issues avec `/to-tickets` après inspection du dépôt réel.
