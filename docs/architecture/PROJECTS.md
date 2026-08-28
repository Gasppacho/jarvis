# Project Architecture

## Project as composition root

Le projet est la frontière où Jarvis assemble :

- repository principal ;
- instances de modules ;
- connexions et MCP ;
- runtime agentique ;
- commandes ;
- conventions Git ;
- limites de concurrence ;
- règles de composition ;
- stockage, événements, exécutions et artefacts scopés.

Le Kernel connaît des packages et ressources globales ; il ne les expose pas automatiquement au projet.

## Portable config and local bindings

### Portable project config

Le fichier `.jarvis/project.yaml` est commité dans le repository. Il contient des choix partageables :

- ID et nom ;
- repository logique `main` avec root relative `.` ;
- branche par défaut et remote logique ;
- slots requis ;
- commandes ;
- conventions Git ;
- modules et configurations non secrètes ;
- limites.

Il ne contient :

- aucun secret ;
- aucun chemin absolu ;
- aucun token ;
- aucun identifiant machine spécifique ;
- aucun bookmark macOS.

### Local bindings

Les bindings locaux restent dans Application Support/SQLite et référencent :

- chemin réel du repository et security-scoped bookmark ;
- connexion globale choisie pour un slot ;
- runtime local choisi ;
- MCP autorisés ;
- overrides machine non portables.

Un exemple exportable nettoyé est fourni sous `examples/project/local-bindings.yaml`, mais le fichier réel n'est pas commité.

## Slots

La configuration portable demande des capabilities via des noms stables :

```yaml
slots:
  sourceControl:
    requires: scm.change-request.manage
  tickets:
    requires: work-items.read
  agentRuntime:
    requires: agent.execute
```

Les bindings locaux résolvent :

```text
sourceControl → connection/github-qservices
tickets       → mcp/github-qservices
agentRuntime  → runtime/codex-default
```

Un module référence un slot, jamais le catalogue global.

## Import flow

1. Le shell obtient l'accès au dossier.
2. Le moteur inspecte le repository sans modification.
3. Si `.jarvis/project.yaml` existe, il le valide ; sinon il propose un draft.
4. L'utilisateur confirme les commandes et conventions.
5. Jarvis présente le diff de `.jarvis/project.yaml`; après confirmation, il écrit ce fichier dans le repository sans créer automatiquement de commit.
6. L'utilisateur sélectionne les bindings locaux.
7. Le Project Runtime résout manifests, contrats et capabilities.
8. Le projet est sauvegardé en `inactive`.
9. `Validate` produit un rapport ; `Activate` n'est autorisé que si le rapport est vert.

## Detection

La détection peut lire :

- `.git/config`, remotes et refs ;
- `package.json`, lockfiles et scripts ;
- fichiers Xcode, Gradle, Cargo, Python ou autres ;
- `AGENTS.md`, `CLAUDE.md` et instructions spécifiques ;
- présence de CLI via un login shell contrôlé.

La détection ne lance pas les scripts projet et ne modifie pas le repository.

## Isolation

Tous les records persistés liés au travail portent `project_id`. Les services exigent un `ProjectContext` explicite ; aucune API ne fournit une requête non scopée aux modules.

```text
Event A(project=token-warehouse)
   └── deliveries uniquement vers instances project=token-warehouse
```

Les workspaces et artefacts sont placés sous :

```text
~/Library/Application Support/Jarvis/projects/<project-id>/
```

Les secrets restent dans le Keychain et sont accessibles uniquement via un binding autorisé.

## Project states

```text
Draft → Valid → Active → Paused → Archived
          ↘ Invalid / Degraded
```

- `Draft` : configuration incomplète.
- `Valid` : composition vérifiée mais subscriptions inactives.
- `Active` : pollers, schedules et consumers actifs.
- `Paused` : aucune nouvelle delivery ; exécutions en cours selon politique.
- `Degraded` : ressource devenue indisponible ; chemins impactés suspendus.
- `Archived` : historique consultable, aucun travail.

## Validation report

Le rapport vérifie :

- JSON Schema du projet ;
- packages et versions de modules présents ;
- schémas de configuration de chaque instance ;
- compatibilité event type/version ;
- unicité des consumers de requests ;
- capabilities requises ;
- bindings et secret refs ;
- repository accessible et Git propre à l'import ;
- branche/remote existants ;
- commandes non vides et syntaxiquement valides ;
- runtime disponible ;
- cycles et limites ;
- permissions demandées.

## One repository in MVP

Le schema conserve une liste `repositories` avec `repositoryId`, mais le validateur MVP exige exactement un élément identifié `main`. Cette forme évite un breaking change lorsque le multi-repository sera ajouté.

## Project template

Un template accélère le setup sans masquer la composition :

```text
GitHub Development
  - GitHub Module
  - Automation Rules
  - Development Module
  - agent:ready rule
  - sourceControl/tickets/agentRuntime slots
```

Le template produit un draft modifiable. Il n'est ni un workflow central ni un nouveau type de module.
