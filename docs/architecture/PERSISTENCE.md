# Persistence Architecture

## Database

Une base SQLite locale unique simplifie installation, transactions et diagnostics. Elle fonctionne en mode WAL avec foreign keys activées et busy timeout configuré. Les migrations sont séquentielles, testées sur une copie et exécutées avant activation des projets.

Chemin :

```text
~/Library/Application Support/Jarvis/jarvis.sqlite
```

## Logical ownership

La base est physiquement partagée, mais chaque table a un owner :

| Tables | Owner |
|---|---|
| `projects`, `project_bindings`, `project_validations` | Project Runtime |
| `module_packages`, `module_instances` | Module Host |
| `events`, `deliveries`, `inbox`, `outbox`, `dead_letters` | Eventing |
| `executions`, `execution_steps`, `execution_logs` | Execution Ledger |
| `artifacts` | Artifact Store |
| `workspace_leases` | Workspace |
| `connections`, `runtime_descriptors` | Registries; secrets remain in Keychain |
| `github_cursors`, `github_external_mappings` | GitHub Module |
| module-specific tables | The owning module only |

Aucun module ne requête les tables d'un autre owner.

## Project scoping

Toute table métier/exécution inclut `project_id` et un index commençant par cette colonne. Les repositories d'accès exigent un `ProjectId` non optionnel.

Pour les rows globales, comme les packages de module, le scope est explicitement `global` et elles ne transportent aucune donnée de projet.

## Event store versus event log

Jarvis ne revendique pas l'event sourcing complet des aggregates. La table `events` est un journal d'intégration durable et audit. Les modules peuvent conserver leur état courant dans leurs propres tables.

## Project deletion

`DELETE /v1/projects/{projectId}` supprime la row `projects` dans une transaction SQLite. Les foreign keys `ON DELETE CASCADE` retirent atomiquement les Local Bindings et tout état moteur project-scoped rattaché ; les autres Projects restent isolés. Le commit rend l'absence durable après redémarrage. Dans cette transaction, un Project actif est refusé avant toute mutation.

Cette transaction ne couvre que l'état moteur local. Elle n'inclut ni le repository ni le Repository Grant shell-owned.

## Transaction patterns

### Consume and publish

Dans une seule transaction :

1. vérifier/insérer Inbox ;
2. charger et muter l'état du module ;
3. mettre à jour l'Execution ;
4. insérer les événements sortants dans Outbox ;
5. marquer la delivery terminée ;
6. commit.

### External side effect

Le handler enregistre une tentative idempotente, effectue l'appel externe hors transaction longue, puis ouvre une transaction courte pour stocker le mapping, l'output fact et la fin d'exécution. Le side effect doit être récupérable après crash via l'idempotency key et une lookup externe.

## Outbox dispatcher

- Réclame des rows par lease.
- Copie l'événement vers le journal canonique.
- Crée les deliveries atomiquement avec la résolution de routing.
- Marque la row dispatchée.
- Une redélivrance d'Outbox est dédupliquée par event ID.

## Inbox

Contrainte unique :

```text
(project_id, module_instance_id, event_id)
```

Le record conserve statut, attempt, résultat terminal et timestamps. Un consumer peut retourner le résultat précédent sans réexécuter le domaine.

## Execution logs

Les logs structurés courts vont en SQLite. Les transcripts volumineux vont dans l'Artifact Store. Les logs possèdent level, code, timestamp, execution ID, correlation ID et message nettoyé.

## Artifact store

```text
~/Library/Application Support/Jarvis/projects/<project-id>/artifacts/
```

Metadata en base : checksum SHA-256, MIME, taille, owner execution, createdAt, retention, redaction status. Les chemins ne sont jamais acceptés directement depuis un event externe.

## Workspace metadata

Les worktrees résident séparément des artefacts :

```text
~/Library/Application Support/Jarvis/projects/<project-id>/workspaces/<execution-id>/
```

Le lease conserve repository, branch, base SHA, PID éventuel, expiration et cleanup policy.

## Migrations

- Nommage monotone `0001_initial.sql`.
- Migrations globales d'abord, puis modules officiels dans ordre stable.
- Une migration appliquée est immuable.
- Backup automatique avant migration non triviale.
- Test CI : base vide → latest et snapshot N-1 → latest.

## Retention

Valeurs MVP proposées :

- events/executions : illimitées jusqu'à option utilisateur ;
- logs détaillés : 30 jours ;
- artifacts success : 14 jours ;
- artifacts failure : 30 jours ;
- worktree success : suppression après PR créée ou délai court ;
- worktree failure : conservation 7 jours ;
- dead letters : jusqu'à résolution/archivage.

Les purges sont projet-scopées, auditables et n'effacent pas les facts minimaux nécessaires à la timeline.
