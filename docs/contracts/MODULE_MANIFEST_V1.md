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
```

Le code ne peut enregistrer un handler ou publier un type absent du manifeste.

## Capabilities

Les IDs sont abstraits et versionnables. Exemple :

```yaml
capabilities:
  requires:
    - id: repository.write
      binding: repository
    - id: agent.execute
      binding: agentRuntime
    - id: work-items.read
      binding: tickets
  provides: []
```

`binding` référence un slot du projet ou une capability moteur. Le runtime vérifie la résolution avant activation.

## Configuration

`configuration.schemaRef` pointe vers un JSON Schema du module. La configuration d'instance est stockée dans `.jarvis/project.yaml` et validée au chargement.

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
- un schemaRef manquant ;
- un event produced non autorisé ;
- une configuration invalide.
