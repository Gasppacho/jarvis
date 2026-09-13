# Jarvis

Jarvis est une application macOS native pour développer vos issues GitHub dans un
worktree isolé, vérifier le résultat et proposer une Pull Request à relire.
Le moteur et son runtime sont embarqués ; la configuration reste propre à chaque projet.

## Commencer dans l’application

1. **Dépôt** : ajouter le dossier Git et vérifier le nom, le dépôt distant et la branche de base.
2. **Workflow** : choisir **Développer une issue GitHub**, confirmer l’installation
   et les validations du projet. Pour Jarvis : installation avec lockfile gelé et
   `pnpm verify` seul, puisqu’il contient déjà les autres contrôles.
3. **Accès et agent** : choisir explicitement le compte GitHub et Codex pour ce projet.
4. **Vérification** : contrôler la configuration, choisir une issue précise puis démarrer.

Une issue ouverte portant **ready-for-agent**, sans bloqueur GitHub natif ouvert,
peut être admise. Une seule issue est développée à la fois. Les vérifications de
configuration ne sont pas l’exécution des tests : ceux-ci doivent réussir avant
le commit et le push. GitHub crée ensuite la PR sur demande du module Development.
La relecture et le merge restent humains.

La supervision conserve le dernier travail et son éventuel échec. **Mettre en pause**
empêche les nouveaux départs ; **Annuler l’exécution** interrompt le travail actif.
Les compositions historiques `agent:ready` sont conservées jusqu’à un remplacement explicite.

Voir le [parcours détaillé](docs/product/UX.md) et les
[prérequis de développement local](docs/engineering/LOCAL_DEVELOPMENT.md).

## Développer Jarvis

Lire [AGENTS.md](AGENTS.md) et [CONTEXT-MAP.md](CONTEXT-MAP.md), puis :

```bash
pnpm install --frozen-lockfile
pnpm verify
```

Le gate inclut les tests TypeScript, Swift et la construction de `dist/Jarvis.app`.
Les contrôles natifs, VoiceOver et le workflow GitHub/Codex réel sont des preuves
séparées, consignées dans [PROGRESS.md](PROGRESS.md). Un build local réussi ne prouve
ni une installation notariée ni Gatekeeper sur une machine propre.

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
