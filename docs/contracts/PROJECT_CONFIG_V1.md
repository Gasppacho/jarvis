# Project Config v1

## Sources

- Portable : `.jarvis/project.yaml`, schéma `project-config.v1.schema.json`.
- Local : base Jarvis, forme exportable `project-bindings.v1.schema.json`.

## Portable config

La configuration portable définit la composition logique. Exemple complet : `examples/project/.jarvis/project.yaml`.

### Key sections

- `metadata` : ID stable et nom.
- `repositories` : repository logique, root relative, branche et remote.
- `slots` : capabilities que la machine doit binder.
- `commands` : commandes projet contrôlées.
- `git` : pattern de branche, stratégie de commit et push.
- `workspace` : worktree et concurrence.
- `modules` : instances, package, activation, config et bindings.

## Local bindings

Les bindings lient le projet à cette machine :

```yaml
apiVersion: jarvis.dev/project-bindings/v1
kind: ProjectBindings
projectId: token-warehouse
repositories:
  main:
    path: /Users/example/Developer/token-warehouse
    bookmarkRef: keychain-or-app-support-ref
slots:
  sourceControl:
    kind: connection
    ref: connection/github-qservices
  tickets:
    kind: mcp
    ref: mcp/github-qservices
  agentRuntime:
    kind: runtime
    ref: runtime/codex-default
```

Le fichier est un exemple de forme ; l'implémentation stocke ces valeurs localement et ne les commit pas.

Un import ou draft non résolu reste explicitement valide avec `slots: {}`. Un ancien import peut aussi porter `bookmarkRef: null` jusqu'à ce que le macOS Shell fournisse un Repository Grant. Les `ref` de slots sont des identifiants locaux opaques : leur présence ne prouve ni l'existence ni la disponibilité d'une connexion, d'un MCP ou d'un Agent Runtime. Les registres correspondants ne font pas partie de ce tracer bullet et aucune candidate implicite n'est synthétisée.

## Merge algorithm

1. Valider portable config.
2. Charger bindings correspondant au `projectId`.
3. Résoudre repository roots.
4. Résoudre chaque slot.
5. Créer les module instances.
6. Valider capabilities et contracts.
7. Produire un `ResolvedProject` immutable pour l'activation.

Un override local ne peut pas changer les modules ou règles métier sans modifier la config portable ; il ne résout que des ressources de machine.

## Secret policy

Un `ref` de connexion peut pointer vers un record global contenant un `secretRef` Keychain. La config portable et les bindings exportés ne contiennent jamais la valeur secrète.

## Validation beyond schema

Certaines règles sont sémantiques :

- ID unique de module instance ;
- exactement un repository `main` au MVP ;
- tous les bindings requis présents ;
- requests avec un consumer unique ;
- commandes autorisées ;
- modules compatibles ;
- runtime et provider disponibles.
