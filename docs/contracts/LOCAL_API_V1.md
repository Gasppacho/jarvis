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
`apiVersion: jarvis.dev/project-validation/v1` et `kind: ProjectValidationReport`.

`POST /v1/projects/{projectId}/composition-choices` prévisualise, sans mutation, les
Events déclarés par la configuration sauvegardée ou par une `portableConfig` proposée.
La réponse `ProjectCompositionChoicesV1` est déterministe et explique la diffusion des
Facts ainsi que les Requests orphelines, résolues ou ambiguës. Elle expose aussi les
starting points `github-development` et `custom`, le catalogue des Module Packages
validés et les cartes des Module Instances de la proposition. Le template transporte
une Portable Configuration complète; `custom` n'en transporte aucune et conserve le
draft importé. Les cartes mènent par nom et description humains, puis donnent Events,
capabilities requises, compatibilité et ressources manquantes; IDs, versions et
références de schéma restent des détails techniques.

Labels, descriptions et payload schemas viennent des contrats Event versionnés; les
producteurs, consumers et routes viennent des Manifests des Module Instances activées.
Prévisualiser ou choisir un template ne crée aucun Local Binding, grant ou graphe impératif persistant.

`PUT /v1/projects/{projectId}/configuration` accepte aussi le `PortableProjectDraft`
Engine complet mais encore vide de Slots et Module Instances. Cela permet de sauvegarder
et rouvrir un point de départ incomplet sans affaiblir le schéma de la Portable
Configuration prête à valider.

`POST /v1/projects/{projectId}/composition-review` assemble le même inventaire avec le
rapport de validation et les choix de ressources dans une réponse
`ProjectCompositionReviewV1`. `readyToValidate` est exactement le résultat Engine de
validation de la Portable Configuration proposée (ou sauvegardée) avec les Local Bindings
courants. L'opération est read-only : elle ne sauvegarde ni Draft, ni relation Event, ni
état de Review. Le shell invalide l'état Ready dès qu'un Draft sauvegardé est modifié et ne
le rétablit qu'après une nouvelle réponse Engine.

`GET /v1/projects/{projectId}/binding-candidates` retourne les choix de la configuration sauvegardée; `POST` prévisualise les mêmes choix pour une `portableConfig` proposée sans la persister. Chaque réponse contient l'union dédupliquée des ressources éligibles et une ligne par Slot. L'Engine intersecte les grants explicites du Project, la capability du Slot et les requirements des Module Instances qui ciblent ce Slot. Les statuts `bound`, `available`, `missing`, `inaccessible` et `incompatible`, ainsi que l'impact et l'action de réparation, appartiennent au contrat; le shell ne reconstruit pas cette politique.

Ces ressources restent sous le préfixe Local API `/v1`, conformément à la pratique de
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
