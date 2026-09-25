# Module Architecture

## Definition

Un **Module** est un bounded context exécutable et versionné. Il possède un comportement cohérent et peut encapsuler :

```text
module/
├── module.manifest.yaml
├── domain/
├── application/
├── handlers/
├── loops/
├── agents/
├── tools/
├── prompts/
├── adapters/
├── persistence/
└── tests/
```

Le contenu est optionnel selon la nature du module. Un provider peut ne pas avoir de loop agentique ; un module de développement peut en avoir plusieurs.

## Module package and module instance

### Module Package

Code global embarqué dans Jarvis, identifié par `metadata.id` et `metadata.version`. Exemple : `jarvis.module.development@1.0.0`.

### Module Instance

Activation configurée dans un projet, identifiée par `projectId + instanceId`. Deux projets peuvent exécuter le même package avec des configurations, connexions et runtimes distincts.

```text
Package: jarvis.module.development@1.0.0
  ├── Instance token-warehouse/development
  └── Instance client-a/feature-development
```

Aucun état mutable n'est partagé entre ces instances.

## Module categories

Les catégories facilitent l'UI, mais n'introduisent pas de types d'extension différents :

- `provider` : traduit un service externe vers/depuis les événements canoniques ;
- `automation` : catégorie historique; aucun moteur Automation Rules n'est
  exécutable depuis L13, mais ses métadonnées restent disponibles pour le
  décodage de migration et l'export brut ;
- `agentic` : réalise un travail cognitif/technique avec une loop et un runtime agentique ;
- `decision` : agrège des faits et décide d'émettre une request sensible ;
- `observer` : métriques, audit ou notification sans piloter la suite.

Un module peut annoncer plusieurs traits, mais reste un seul bounded context.

## Internal architecture

```text
Event Handler / Command Adapter
            ↓
Application Service
            ↓
Domain Model / Loop Coordinator
      ↙              ↘
Owned Repository      Ports
                      ↓
                  Adapters
```

- Le handler valide l'enveloppe et traduit le payload vers un input applicatif.
- L'application service garantit les invariants, ouvre une transaction et utilise l'Outbox.
- Le domaine ne connaît ni SQLite, ni API locale, ni autre module.
- Les adapters traduisent Git, CLI, MCP ou réseau derrière des ports locaux au module ou partagés par capability.

## Manifest

Le manifeste déclare :

- identité et version ;
- entrypoint ;
- événements consommés et produits ;
- pour une Request produite depuis une collection de configuration, le chemin de composition permettant au Project Runtime de lire ses targets sans connaître le modèle interne du module ;
- capabilities requises et fournies, y compris leur résolution par le moteur ou le repository du projet lorsqu'elle ne passe pas par un slot ;
- schéma de configuration ;
- assets agentiques éventuels ;
- permissions attendues ;
- stratégie de concurrence.

Il ne déclare pas l'ordre global du workflow.

Le manifeste historique `jarvis.module.automation-rules` conserve son identité
et son schéma pour lire les configurations L11/L12. Il n'est plus découvert
dans le catalogue de production et son ancien entrypoint n'est jamais chargé.

## Subscription model

Une subscription relie un contrat consommé à un handler interne :

```yaml
contracts:
  consumes:
    - type: development.implementation.requested
      version: 1
      kind: request
      handler: handleImplementationRequested
```

Le Project Runtime active la subscription uniquement si l'instance est activée et valide. Le handler ne reçoit que des événements du même `projectId`. Une edge contractuelle est identifiée par `type + version + kind` (ou par un targeting explicitement déclaré) ; partager un `schemaRef` ne relie jamais deux types d'événement différents. Le Kernel rejette séparément un manifeste dont `schemaRef` n'identifie pas le type et la version déclarés.

## Produced events

Un module ne peut publier que les types déclarés dans son manifeste et autorisés par le Project Runtime. Ce contrôle empêche une loop ou un prompt compromis de demander arbitrairement un merge.

La décision métier reste dans le module : l'autorisation du runtime est une limite de sécurité, pas une condition métier.

## State ownership

- Une table ou namespace logique a un owner unique.
- Un module ne lit pas directement les tables d'un autre module.
- Les read models d'UI peuvent être construits par le Kernel depuis les événements et métadonnées, sans exposer les aggregates.
- Une migration de module est versionnée avec le package et exécutée par le moteur lors du bootstrap.

## Capability access

Le module déclare des besoins abstraits :

```text
repository.read
repository.write
git.branch
git.commit
git.push
shell.execute
tickets.read
agent.execute
```

Le Project Runtime les résout depuis :

- services partagés du moteur ;
- bindings de connexion ;
- binding de runtime ;
- MCP autorisés ;
- configuration du repository.

Le module ne reçoit jamais le catalogue global complet.

## Agentic assets

Une loop, un agent, un tool ou un prompt appartient au module qui porte le comportement. Le manifeste peut les décrire pour l'observabilité :

```yaml
agentic:
  loops:
    - id: implement-work-item
      entrypoint: loops/implement-work-item.js
  agents:
    - id: developer
      prompt: prompts/developer.md
  tools:
    - workspace
    - project-commands
```

Ils ne sont pas des modules séparés tant qu'ils n'ont pas une responsabilité, un état et des contrats d'intégration autonomes.

## Lifecycle

```text
Discovered → Validated → Configured → Active → Draining → Inactive
                         ↘ Invalid / Degraded
```

- `Discovered` : package trouvé dans le catalogue.
- `Validated` : manifeste et schémas valides.
- `Configured` : instance projet enregistrée.
- `Active` : subscriptions ouvertes.
- `Degraded` : certaines capabilities indisponibles ; aucune nouvelle request concernée n'est acceptée.
- `Draining` : arrêt des nouvelles deliveries.
- `Inactive` : aucun handler actif.

Une instance legacy contenant Automation Rules peut rester enregistrée pour
consultation. Elle est `Degraded`, ses deliveries restent conservées et aucun
handler, polling ou replay legacy n'est ouvert; seule la migration guidée ou
l'export brut peut la faire évoluer.

## Concurrency

Le manifeste peut proposer une valeur par défaut, mais le projet fixe la limite finale. Les clés de sérialisation typiques sont :

- `repositoryId` pour les opérations Git sensibles ;
- `subject.ref` pour une Change Request ;
- `workItemRef` pour éviter deux implémentations du même ticket.

Le Kernel gère le lease, le module choisit la clé métier.

## Provider responsibilities

Le module GitHub :

- observe les changements GitHub et publie des facts canoniques ;
- consomme les requests SCM ciblant son binding ;
- appelle GitHub de manière idempotente ;
- publie success/failure facts ;
- conserve cursors et mappings externes.

Il ne :

- choisit pas quel ticket développer ;
- modifie pas le code ;
- décide pas qu'une review est satisfaisante ;
- décide pas de merger sans request.

## Development responsibilities

Le module Development :

- comprend le ticket ;
- alloue un workspace ;
- crée branche/worktree ;
- invoque l'agent ;
- exécute les commandes projet ;
- commit et push ;
- publie `development.implementation.completed` après le push réussi.

Il ne prépare pas le titre ou la description de la Change Request, n'émet pas
sa demande de création et ne décide pas du merge.

## Pull Request

Le module Pull Request consomme le fait de fin de Development, récupère le
Work Item et le diff du commit poussé dans son propre workspace, puis prépare
le titre et la description de la Change Request. Il lit les métadonnées du
dépôt GitHub pour choisir sa branche cible, puis émet
`scm.change-request.creation-requested` vers le binding SCM du projet. Il
n'appelle pas l'API provider pour créer la Pull Request et ne décide pas du
merge; le module GitHub réalise la création idempotente.

Le module GitHub conserve la création idempotente de la Pull Request. Le
module Pull Request cible la branche par défaut lue sur GitHub et ajoute
`Closes #N` à la description pour fermer l'issue à la fusion.

## Enforcement

La CI doit inclure des tests d'architecture :

- graphe d'imports inter-packages autorisé ;
- aucune dépendance de `kernel` vers `packages/modules/*` ;
- aucune dépendance d'un module vers un autre module ;
- accès persistence uniquement via le repository du context ;
- événements produits déclarés dans le manifeste.
