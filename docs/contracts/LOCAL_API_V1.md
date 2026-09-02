# Local API v1

## Source of truth

`contracts/openapi/local-api.v1.yaml`.

## Transport

- HTTP/1.1 sur `127.0.0.1` et port dynamique.
- Bearer token éphémère généré par le shell.
- JSON UTF-8.
- SSE pour les notifications temps réel.
- Pas de CORS, pas d'accès réseau externe.

Chaque opération protégée documente deux refus : `401` (`api.unauthorized`) quand le
bearer token manque ou ne correspond pas, et `403` (`api.host-not-allowed`) quand la
requête n'adresse pas l'interface loopback. `pnpm contracts:check` échoue si une
opération protégée omet l'un des deux.

## Resource groups

### System

Health, version, diagnostic et shutdown.

### Discovery

Inspection read-only d'un repository et détection des runtimes/connexions.

### Projects

Import, liste, détail, validation, activation, pause et configuration locale.

`POST /v1/projects/{projectId}/validate` est conservé pour compatibilité et sa réponse
fermée reste exactement `{valid, issues}`. `issues` projette les `findings` avec
`code`, `severity` et `message` (l'ancien `path` optionnel reste accepté par le contrat).

Les nouveaux clients appellent `POST /v1/projects/{projectId}/validation-report`. Cette
opération distincte évite d'élargir silencieusement la réponse historique et renvoie le
schéma explicite `ProjectValidationReportV1`, identifié dans le document par
`apiVersion: jarvis.dev/project-validation/v1` et `kind: ProjectValidationReport`. Le
nom de ressource reste sous le préfixe Local API `/v1`, conformément à la pratique de
versioning de cette API.

### Modules

Catalogue global et instances par projet.

### Events and executions

Timeline, filtres, détail, cancellation et dead letters.

### Stream

Notifications de session. Le stream n'est pas source de vérité ; après reconnexion, le client recharge les snapshots.

## Error envelope

```json
{
  "error": {
    "code": "project.composition-invalid",
    "message": "The project has one request without a consumer.",
    "details": {},
    "correlationId": "api_..."
  }
}
```

`code` est stable et localisable côté UI. `message` est sûr à afficher. `details` ne contient aucun secret.

## Versioning

Le préfixe `/v1` versionne les breaking changes. Un ajout backward-compatible reste en v1. UI et moteur vérifient `apiVersion` au handshake et refusent une combinaison incompatible.
