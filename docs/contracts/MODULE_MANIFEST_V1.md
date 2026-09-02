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
    configurationPath: /rules/*/emit
```

Pour une Request configurée, `targeting.configurationPath` sélectionne les descriptors d'émission `{type, target}` avec un JSON Pointer contenant un segment wildcard `*`. Le Kernel peut ainsi résoudre les targets de composition sans interpréter le modèle métier du module. Le chemin est optionnel pour les producers dont la target n'est pas issue de la configuration.

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

`configuration.schemaRef` pointe vers un JSON Schema du module. La configuration d'instance est stockée dans `.jarvis/project.yaml` et validée au chargement.

### Guided configuration semantics

A Module Configuration schema may use standard JSON Schema `$comment` annotations to
select a specialized editor without inventing a second configuration contract:

- `jarvis:automation-rule-set` marks the repeatable Rule Set array;
- `jarvis:event-kind=fact` and `jarvis:event-kind=request` mark Event selectors;
- `jarvis:bounded-match` marks the Rule's exact scalar match object;
- `jarvis:request-target` marks the Engine-resolved Request target.

These annotations are presentation metadata only. The canonical value remains Module
Configuration, normal JSON Schema keywords validate custom values, and routing metadata
comes from the project-scoped composition choices response. Unknown annotations are
ignored so older shells retain their generic schema editor.

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
