# Event Envelope v1

## Status

Contractuel pour le MVP. Schéma : `contracts/schemas/event-envelope.v1.schema.json`.

## Purpose

L'enveloppe transporte tous les messages intermodules et fournit le scope, la causalité, le routage et l'idempotence sans exposer les modèles internes des modules.

## Required fields

```json
{
  "specVersion": "1.0",
  "id": "evt_01K...",
  "type": "development.implementation.requested",
  "version": 1,
  "kind": "request",
  "occurredAt": "2026-08-28T08:00:00.000Z",
  "projectId": "token-warehouse",
  "producer": {
    "moduleId": "jarvis.module.automation-rules",
    "moduleInstanceId": "automation-rules"
  },
  "subject": {
    "type": "work-item",
    "ref": "github://QServices/token-warehouse/issues/42"
  },
  "correlationId": "corr_01K...",
  "causationId": "evt_01J...",
  "target": { "moduleInstanceId": "development" },
  "idempotencyKey": "token-warehouse:issue-42:implementation:1",
  "payload": {}
}
```

## Semantics

- `id` identifie cette publication physique et reste stable lors d'une redélivrance.
- `type` et `version` sélectionnent le JSON Schema du payload.
- `kind=request` exige `target` et `idempotencyKey`.
- `projectId` est obligatoire et immuable.
- `repositoryId` vaut `main` dans le workflow MVP lorsqu'un repository est concerné.
- `producer` désigne l'instance ayant créé l'événement, pas le service externe observé.
- `subject` désigne la ressource principale et sert de partition par défaut.
- `correlationId` relie la chaîne métier ; `causationId` pointe vers l'événement direct ou `null` pour la racine.
- `target.binding` demande au Project Runtime de résoudre un binding stable tel que `sourceControl`.
- `target.moduleInstanceId` adresse explicitement une instance du même projet.
- `idempotencyKey` représente l'intention logique et peut survivre à une nouvelle publication après recovery.
- `payload` ne contient ni secret ni contenu volumineux.

## Payload contracts

Chaque descriptor dans un manifeste référence un schéma de payload distinct. Le schéma de l'enveloppe ne valide que la structure générique ; le Contract Registry valide ensuite le payload avec `(type, version)`.

## Evolution

- Ajout d'un champ optionnel compatible : même `specVersion`.
- Changement incompatible de l'enveloppe : nouvelle `specVersion` et migration explicite.
- Changement incompatible du payload : `version + 1` pour le type d'événement.
- Un producer peut publier plusieurs versions pendant une fenêtre de migration.

## Examples

Voir `examples/events/` pour la chaîne complète du MVP.
