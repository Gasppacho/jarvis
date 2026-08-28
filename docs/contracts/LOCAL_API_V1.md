# Local API v1

## Source of truth

`contracts/openapi/local-api.v1.yaml`.

## Transport

- HTTP/1.1 sur `127.0.0.1` et port dynamique.
- Bearer token éphémère généré par le shell.
- JSON UTF-8.
- SSE pour les notifications temps réel.
- Pas de CORS, pas d'accès réseau externe.

## Resource groups

### System

Health, version, diagnostic et shutdown.

### Discovery

Inspection read-only d'un repository et détection des runtimes/connexions.

### Projects

Import, liste, détail, validation, activation, pause et configuration locale.

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
