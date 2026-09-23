# Module Manifest v1

## Status

Contractuel pour les modules officiels du MVP. Schéma : `contracts/schemas/module-manifest.v1.schema.json`.

## Responsibilities

Le manifeste permet au Kernel de connaître un module sans importer ses détails métier :

- identité/version/catégorie ;
- entrypoint ;
- contracts consommés et produits ;
- capabilities requises/fournies ;
- configuration ;
- assets agentiques ;
- permissions ;
- concurrence.

## Minimal shape

```yaml
apiVersion: jarvis.dev/module/v1
kind: Module
metadata:
  id: jarvis.module.development
  version: 1.0.0
  displayName: Development
  description: Implements a ready work item in an isolated workspace.
  categories: [agentic]
runtime:
  entrypoint: dist/index.js
contracts:
  consumes: []
  produces: []
capabilities:
  requires: []
  provides: []
```

## Contract descriptors

Consumer :

```yaml
- type: development.implementation.requested
  version: 1
  kind: request
  schemaRef: contracts/events/development.implementation.requested.v1.schema.json
  handler: handleImplementationRequested
```

Producer :

```yaml
- type: scm.change-request.creation-requested
  version: 1
  kind: request
  schemaRef: contracts/events/scm.change-request.creation-requested.v1.schema.json
  targeting:
    mode: self
```

Pour une Request issue d'une configuration métier, le targeting décrit explicitement
la résolution déclarée par le module. Pour une Request interne qui cible toujours
l'instance productrice, `targeting.mode: self` déclare cette target sans introduire
de configuration utilisateur. Le targeting est optionnel pour les producers dont
la target n'est pas issue de la configuration. Aucun targeting utilisateur de règle
ou de payload n'est exposé par le catalogue fixed-modules.

Le code ne peut enregistrer un handler ou publier un type absent du manifeste. `schemaRef` doit identifier exactement le contrat versionné déclaré, selon la forme canonique `contracts/events/<type>.v<version>.schema.json` ; il documente et résout le payload ainsi que ses `title` et `description` humains pour les choix de composition, mais ne constitue jamais une identité d'événement alternative.

## Capabilities

Les IDs sont abstraits et versionnables. Exemple :

```yaml
capabilities:
  requires:
    - id: repository.write
      binding: repository
      resolution:
        kind: project-repository
    - id: shell.execute
      resolution:
        kind: engine
        ref: engine/local
    - id: agent.execute
      binding: agentRuntime
    - id: work-items.read
      binding: tickets
  provides: []
```

Sans `resolution`, `binding` référence un slot du projet. `resolution.kind: project-repository` rend `binding` obligatoire ; il doit référencer un repository déclaré par le Project, doté d'un Local Binding sauvegardé et actuellement accessible. `resolution.kind: engine` désigne un service partagé du moteur par son `ref` ; sa capability doit être présente dans la source de candidats disponibles du Project. Le manifeste seul ne prouve jamais la disponibilité. Le runtime vérifie la résolution avant activation.

## Configuration

`configuration.schemaRef` pointe vers un JSON Schema du module. La configuration d'instance est stockée localement par Jarvis et validée au chargement.

### Guided configuration semantics

The guided UI presents only fixed module descriptors and business settings. Module
Configuration schemas may use standard JSON Schema metadata (`title`, `description`,
`examples`, `default`, required membership and bounds) for generic controls. Legacy
rule annotations, when encountered while decoding an archived configuration, are
ignored as inert migration metadata and never select an editor or create routing.

The Project Wizard also derives its generic controls recursively from standard JSON
Schema keywords; it never infers meaning from property names. Schema authors provide
`title`, `description`, `examples`, `default`, required membership, enum choices and
applicable string, numeric and collection bounds. Objects and arrays are structured and
repeatable in the normal path. Raw JSON is an Advanced repair path that preserves input
which cannot currently be represented as valid structured values.

## Permissions

Les permissions décrivent le blast radius attendu :

- événements que le module peut émettre ;
- accès filesystem/workspace ;
- usage réseau via bindings ;
- external mutations ;
- secrets résolus par adapters.

Le manifeste n'accorde rien seul : le Project Runtime intersecte déclaration, politique système et bindings projet.

## Agentic metadata

La section optionnelle documente les loops, agents, tools et prompts internes pour l'UI et les diagnostics. Elle n'autorise aucun autre module à les appeler directement.

## Compatibility

Le Kernel refuse :

- un `apiVersion` inconnu ;
- un module dupliqué avec contenu différent ;
- une version incompatible avec le moteur ;
- un schemaRef manquant ou incohérent avec le type et la version déclarés ;
- un event produced non autorisé ;
- une configuration invalide.
