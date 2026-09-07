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
rapport porte aussi `compositionFingerprint`, un condensé stable de la Portable
Configuration et des Local Bindings exacts qu'il décrit.

`POST /v1/projects/{projectId}/activate` (ticket #53) n'accepte que le
`compositionFingerprint` d'un rapport vert pour la composition sauvegardée à l'instant de
l'appel. L'Engine recalcule ce condensé depuis l'état durable courant et refuse
l'activation sans jamais revalider silencieusement : `project.activation-not-validated`
quand aucun rapport réussi n'existe pour la composition courante, et
`project.activation-report-stale` quand la configuration ou les Local Bindings ont changé
depuis ce rapport. Un succès crée le Resolved Project immuable — composition figée,
Module Instances, bindings et routes de requests résolues — et fait passer le Project à
`active`; répéter l'activation d'une composition inchangée est idempotent et ne crée pas
un second Resolved Project. Aucun Event n'est créé ni délivré par cette opération.

`GET /v1/projects/{projectId}/subscriptions` (ticket #54) renvoie `ProjectSubscriptionsV1` :
l'ensemble des subscriptions ouvertes, dérivé à la demande du Resolved Project et des
Manifests des Module Packages, sans aucun second store durable. `items` porte un
`ValidationContractEndpoint` (`instanceId`, `moduleId`, `contract`) par contrat consommé
de chaque Module Instance `enabled` de la composition figée ; une instance désactivée n'y
contribue rien. Avant toute activation réussie, `items` est vide. Répéter l'activation
d'une composition inchangée laisse cet ensemble inchangé. Ouvrir une subscription n'est
pas délivrer un Event : cette lecture ne dispatche, ne délivre et ne démarre rien.

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

`POST /v1/projects/{projectId}/composition-graph` projette, sans mutation, le graphe de
composition `ProjectCompositionGraphV1` de la configuration sauvegardée ou d'une
`portableConfig` proposée évaluée avec les Local Bindings courants. `nodes` porte
l'identité stable de chaque Module Instance (module package, version, display name,
état enabled/disabled). `edges` porte l'id et la version du contrat d'Event, sa
direction (`from`/`to`) et son genre (`request`/`fact`); chaque edge de type `request`
porte un `routing` distinguant `resolved`, `orphaned` et `ambiguous`, ce dernier nommant
ses consumers candidats. `rail` expose les capabilities, Slots et bindings requis avec
leur état `bound`, `unbound` ou `unresolved`. `findings` reprend les `ProjectValidationReport`
findings existants sous une adresse stable `id`; `nodes`, `edges` et `rail` référencent
les findings qui s'appliquent à eux par leur `code` existant — aucun nouveau code n'est
inventé. Le graphe est entièrement dérivé du `ProjectValidationReport` de l'Engine et
des Manifests des Module Packages : l'Engine ne recalcule aucune résolution de routing,
il projette celle déjà calculée par le validateur. La réponse est déterministe pour une
entrée inchangée et triée par identités contractuelles stables.

`GET /v1/projects/{projectId}/binding-candidates` retourne les choix de la configuration sauvegardée; `POST` prévisualise les mêmes choix pour une `portableConfig` proposée sans la persister. Chaque réponse contient l'union dédupliquée des ressources éligibles et une ligne par Slot. L'Engine intersecte les grants explicites du Project, la capability du Slot et les requirements des Module Instances qui ciblent ce Slot. Les statuts `bound`, `available`, `missing`, `inaccessible` et `incompatible`, ainsi que l'impact et l'action de réparation, appartiennent au contrat; le shell ne reconstruit pas cette politique.

Depuis l'ADR 0014, chaque ligne de Slot porte aussi un champ optionnel `ineligibleGrantedResources` : les ressources déjà accordées à ce Project mais inéligibles pour ce Slot précis (capability manquante, `kind` erroné, correspondance partielle), nommées avec la raison de l'Engine. Une ressource jamais accordée à ce Project n'apparaît jamais, ni ici ni ailleurs dans la réponse — ni nom, ni identifiant, ni compte, ni indice d'ordre. L'Engine est seul à calculer l'éligibilité et la raison; le shell ne reproduit aucune de ces règles.

Ces ressources restent sous le préfixe Local API `/v1`, conformément à la pratique de
versioning de cette API.

### Modules

Catalogue global et instances par projet.

### Events and executions

Timeline, filtres, détail, cancellation et dead letters.

`GET /v1/projects/{projectId}/events` (ticket #59) renvoie le journal durable des Events
du Project : `id`, `type`, `version`, `kind`, la Module Instance productrice
(`producer`, l'id de la Module Instance, pas du Module), `subjectRef`, `occurredAt`,
`correlationId` et `causationId` (`null` pour une racine de chaîne). L'ordre est le plus
récent d'abord, par `occurredAt` décroissant puis par `id` décroissant en cas d'égalité de
timestamp — cet ordre de repli reste stable d'un appel à l'autre — et `limit` (1 à 500,
défaut 100) tronque cet ordre à son extrémité la plus ancienne. Le filtre `correlationId`
renvoie exactement les Events de cette chaîne dans le même ordre ; un `correlationId`
inconnu renvoie `items: []`, jamais une erreur.

`GET /v1/projects/{projectId}/executions` (ticket #59) renvoie les Executions du Project
telles que tenues par l'Execution Ledger, dans le même ordre le plus récent d'abord (par
`createdAt` puis `id` décroissants), et le même `limit` (1 à 500, défaut 100) que
`/events` tronque cet ordre à son extrémité la plus ancienne — sans lui, une lecture de
tout le Ledger d'un Project bloquerait le thread unique du moteur le temps de la requête
(revue de code du ticket #59, finding 1). `status` reflète l'état stocké par le Ledger pour
chacun des sept états du schéma, y compris `timed-out` dont l'orthographe stockée diffère
(`timed_out`). `ExecutionSummary` porte aussi `inputEventId` et `correlationId` : la
référence vers l'Event qui a causé l'Execution et la corrélation de cet Event, pour
qu'un client relie une Execution à l'Event qui l'a déclenchée sans deviner à partir des
timestamps ou de la Module Instance. Ces deux propriétés sont additives et optionnelles :
un client qui ignore la forme antérieure au ticket #59 reste valide.

La lecture du journal des Events et celle du Ledger des Executions respectent
l'ownership des tables (docs/architecture/PERSISTENCE.md "Logical ownership") : Eventing
lit `events`, l'Execution Ledger lit `executions`, et ni l'une ni l'autre opération ne lit
la table de l'autre contexte directement — la corrélation d'une Execution est obtenue en
demandant à Eventing, jamais en lisant `events` depuis l'Execution Ledger.

Le streaming temps réel, la cancellation, les dead letters et le replay ne sont pas
introduits par ce ticket (#17, #18).

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
