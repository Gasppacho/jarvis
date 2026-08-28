# Event Architecture

## Core model

Tous les échanges intermodules utilisent une enveloppe canonique versionnée. Le terme **Event** couvre deux sémantiques explicitement distinguées par `kind`.

### Request Event

Une intention demandant à un module capable d'effectuer un side effect ou un travail :

```text
development.implementation.requested
scm.change-request.creation-requested
scm.change-request.review-publication-requested
scm.change-request.merge-requested
```

Une request n'affirme jamais que l'action a réussi.

### Fact Event

Un fait qui s'est réellement produit :

```text
scm.work-item.tag-added
development.implementation.completed
scm.change-request.created
scm.change-request.merged
```

Un fact peut provenir d'une action Jarvis ou d'une action humaine/externe observée.

## Naming

Format : `<domain>.<entity>.<outcome>` en kebab-case pour les segments composés.

- Requests terminent par `requested`.
- Facts utilisent le passé ou un résultat accompli : `created`, `completed`, `failed`, `added`.
- Le provider externe ne figure pas dans le type canonique.
- Les breaking changes augmentent `version`, pas nécessairement le nom.

## Envelope

La source machine-readable est `contracts/schemas/event-envelope.v1.schema.json`. Champs essentiels :

| Field | Purpose |
|---|---|
| `id` | Déduplication de l'événement |
| `type` + `version` | Contrat versionné |
| `kind` | `request` ou `fact` |
| `projectId` | Frontière obligatoire de routage |
| `repositoryId` | Repository concerné, lorsque pertinent |
| `producer` | Package et instance responsables |
| `subject` | Ressource métier principale |
| `correlationId` | Chaîne de travail complète |
| `causationId` | Événement direct ayant causé celui-ci |
| `target` | Binding ou instance ciblée pour une request |
| `idempotencyKey` | Side effect logique unique d'une request |
| `payload` | Données contractuelles, sans secret |

## Routing

### Facts

Un fact est diffusé à zéro, un ou plusieurs consumers actifs dont :

- le manifeste déclare le type/version ;
- l'instance appartient au même projet ;
- les filtres de subscription correspondent.

Zéro consumer est légal. Le fact reste visible et auditable.

### Requests

Une request doit résoudre à exactement un consumer actif dans le projet. Le `target` utilise prioritairement un slot/binding stable :

```json
{"binding":"sourceControl"}
```

Le Project Runtime résout le binding vers l'instance provider du projet. Un target direct par `moduleInstanceId` est réservé aux cas internes explicites.

Résultats de validation :

- 0 consumer : composition invalide, request non dispatchée ;
- 1 consumer : delivery créée ;
- >1 consumers : composition ambiguë, projet invalide.

## Delivery semantics

Le système garantit **at-least-once delivery**. Exactement-une-fois n'est pas revendiqué : chaque consumer doit être idempotent.

```text
transaction module
  ├── state changes
  ├── execution update
  └── outbox rows
commit
    ↓
dispatcher
    ↓
delivery + consumer inbox
```

L'Inbox possède une contrainte unique `(consumer_instance_id, event_id)`. Une redélivrance retrouve le résultat enregistré ou ne réapplique pas le side effect.

## Retry and dead letters

- Backoff exponentiel avec jitter.
- Nombre maximal configurable, borné par défaut.
- Erreurs de validation ou permission : non retryables.
- Erreurs réseau/transitoires : retryables.
- Après épuisement : dead letter avec erreur nettoyée, tentative, timestamps et lien d'exécution.
- Le replay est une action explicite, auditée et réutilise l'idempotency key.

## Ordering

Aucun ordre global n'est garanti. Lorsqu'un invariant exige l'ordre, le consumer déclare une `partitionKey`, généralement :

```text
projectId + subject.ref
```

Un worker ne traite qu'une delivery active par partition. Les autres sujets restent parallèles.

## Correlation and causation

Pour le workflow de référence :

```text
evt_label_added
  correlationId = corr_issue_42
  causationId    = null

evt_development_requested
  correlationId = corr_issue_42
  causationId    = evt_label_added

evt_change_request_requested
  correlationId = corr_issue_42
  causationId    = evt_development_requested

evt_change_request_created
  correlationId = corr_issue_42
  causationId    = evt_change_request_requested
```

Le graphe d'UI est reconstruit à partir de ces liens, pas d'un workflow central enregistré.

## Event transaction rule

Un module ne doit jamais :

1. muter son état ;
2. commit ;
3. publier ensuite hors transaction sans Outbox.

La mutation métier et l'intention de publication doivent être atomiques. Le side effect externe, lorsqu'il existe, est idempotent et son résultat produit un nouveau fact dans une transaction ultérieure.

## Artifacts

Le payload reste petit, sérialisable et stable. Les diffs, transcripts, logs volumineux, bundles Git et rapports utilisent :

```json
{"artifactRef":"artifact://project-id/execution-id/review.json"}
```

L'Artifact Store applique scope projet, checksum, taille, type MIME, durée de rétention et redaction.

## Cycles

Les cycles sont autorisés lorsqu'ils représentent une itération métier, par exemple review → changes requested → nouvelle implémentation. Ils doivent transporter :

- la même correlation ;
- une génération ou tentative métier ;
- une limite explicite ;
- une condition de sortie visible.

Le Kernel bloque une publication dépassant la limite configurée et crée un fact d'échec, plutôt qu'une boucle infinie.

## External observations

Un provider peut observer un fait déjà initié par Jarvis. Il doit dédupliquer le fact à l'aide de l'identifiant externe et du mapping local. Exemple : après création API d'une PR et émission immédiate de `scm.change-request.created`, le polling ultérieur ne doit pas émettre un doublon logique.
