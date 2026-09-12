# Project Config v1

## Sources

- Portable : `.jarvis/project.yaml`, schéma `project-config.v1.schema.json`.
- Local : base Jarvis, forme exportable `project-bindings.v1.schema.json`.

## Portable config

La configuration portable définit la composition logique. Exemple complet : `examples/project/.jarvis/project.yaml`.

### Key sections

- `metadata` : ID stable et nom.
- `repositories` : un ou plusieurs repositories logiques aux IDs uniques, chacun avec root `.` ; branche et remote. Ils partagent le Repository Grant local unique du MVP.
- `slots` : capabilities que la machine doit binder.
- `commands` : commandes projet contrôlées.
- `git` : pattern de branche, stratégie de commit et push.
- `workspace` : worktree et concurrence.
- `modules` : instances, package, activation, config et bindings.

L'instance Development déclare aussi une décision `preparation` : `install`
exécute l'unique `commands.install` confirmé dans le worktree, `none` confirme
explicitement qu'aucune préparation n'est requise. Une valeur absente arrête
l'exécution avant l'agent. Elle peut également déclarer `timeoutMs`,
`outputLimitBytes` et `environmentAllowlist`. L'allowlist ne contient que des
noms, jamais des valeurs ni des secrets.

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
    environment:
      PATH: /opt/homebrew/bin:/usr/bin:/bin
```

Le profil `environment` est local au binding runtime : il fournit uniquement
les valeurs nommées dans l'allowlist au child et au preflight. Il peut inclure
un contexte d'authentification local tel que `CODEX_HOME`, jamais un token ni
un chemin vers un fichier de credentials. Les noms secrets, tokens et chemins
de fichiers d'authentification sont refusés. Le fichier est un exemple de
forme ; l'implémentation stocke ces valeurs localement et ne les commit pas.

Un import ou draft non résolu reste explicitement valide avec `slots: {}`. Un ancien import peut aussi porter `bookmarkRef: null` jusqu'à ce que le macOS Shell fournisse un Repository Grant. Un `ref` de slot n'est accepté que s'il désigne un candidat explicitement dans l'autorité du projet, du bon `kind`, et fournissant **toutes** les capabilities demandées par le Slot et par les Module Instances qui le référencent. Les descripteurs Connection et Runtime persistés alimentent les candidats globaux, mais aucun grant implicite n'est synthétisé : seule la liaison locale du Project autorise leur résolution. Les Module Instances déjà sélectionnées sont des candidats project-scoped uniquement pour les capabilities déclarées dans `provides` par leur Manifest.

`GET /v1/projects/{projectId}/binding-candidates` renvoie cette intersection pour la configuration sauvegardée; `POST` la prévisualise pour un Draft proposé, sans mutation. Les lignes sont ordonnées par Slot. Chaque ligne porte un statut `bound`, `available`, `missing`, `inaccessible` ou `incompatible`, l'impact sur les Module Instances et une action de réparation. Sa liste `candidates` n'expose jamais une ressource globale non accordée à ce Project — ADR 0014 ne change rien à cette moitié de la règle.

ADR 0014 change l'autre moitié : une ressource déjà accordée à ce Project mais inéligible pour ce Slot précis — capability manquante, `kind` erroné, ou correspondance partielle des capabilities — est nommée dans le champ optionnel `ineligibleGrantedResources`, avec la raison de l'Engine. Une ressource jamais accordée à ce Project reste strictement invisible : ni nommée, ni comptée, ni suggérée, sous quelque forme que ce soit.

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

Un `ref` de connexion peut pointer vers un record global contenant un `secretRef` opaque, actuellement une référence `gh://account` résolue par le CLI GitHub authentifié. La config portable et les bindings exportés ne contiennent jamais la valeur secrète.

## Validation beyond schema

Certaines règles sont sémantiques :

- ID unique de module instance ;
- au moins un repository logique aux IDs uniques, chacun de root `.` ;
- tous les bindings requis présents ;
- requests avec un consumer unique ;
- commandes autorisées ;
- modules compatibles ;
- runtime et provider disponibles.

## Inventaire guidé Codex (#197)

Le champ optionnel `agentRuntimes` du contrat de ressources est une surface de
**découverte**, distincte des ressources résolues transmises aux modules. Il
nomme les candidats Codex globaux sûrs afin de permettre un choix explicite,
y compris leurs incompatibilités; leur visibilité ne constitue aucun grant.
La règle de non-divulgation ci-dessus s’applique aux ressources résolues et
aux agents, pas à cet inventaire du shell. Seul le choix local explicite
accorde le profil détecté au Project. Un slot runtime optionnel sans consumer
actif ne rend pas le contrôle runtime obligatoire pour l’activation.
