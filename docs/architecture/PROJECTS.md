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

Un exemple exportable nettoyé est fourni sous `examples/project/local-bindings.yaml`, mais le fichier réel n'est pas commité. La configuration portable et les Local Bindings sont remplacés indépendamment dans SQLite ; chaque remplacement SQLite est transactionnel. Une configuration invalide ne modifie aucune ligne.

Quand `writeToRepository` vaut `true`, le moteur écrit un sibling temporaire privé puis le renomme sur `.jarvis/project.yaml`, sans créer de commit Git. Le système de fichiers et SQLite ne peuvent pas partager une transaction : l'écriture/rename précède donc SQLite afin qu'un échec fichier ne change pas la base. Si SQLite refuse ensuite le remplacement, le moteur restaure le dernier fichier durable (ou supprime le nouveau fichier lorsqu'il n'en existait pas). Cette compensation est testée, sans prétendre fournir une transaction cross-resource générale.

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

Les bindings locaux pourront résoudre :

```text
sourceControl → connection/github-qservices
tickets       → mcp/github-qservices
agentRuntime  → runtime/codex-default
```

Un module référence un slot, jamais le catalogue global. Les Module Instances sélectionnées sont des candidats déjà project-scoped pour les capabilities qu'elles fournissent. Les autres candidats passent par un port de grants explicites ; tant que les registres Connection, MCP et Agent Runtime ne sont pas implémentés, leur catalogue est vide et les slots concernés restent `Unbound`. Jarvis ne fabrique ni grant, ni connexion, ni activation implicite.

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

## Project deletion

La suppression oublie un Project inactif de l'installation locale : record du Project Registry, Local Bindings et état moteur project-scoped. Le moteur effectue cette suppression dans une transaction locale et refuse un Project `Active` tant qu'il n'est pas pausé.

La suppression ne lit, ne modifie et ne supprime jamais le repository, `.jarvis/project.yaml`, les branches, commits ou fichiers. Le Repository Grant appartient au shell macOS : il n'est retiré, et son accès security-scoped n'est libéré, qu'après confirmation de la suppression moteur.

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

Le rapport `jarvis.dev/project-validation/v1` est calculé par le Project Runtime, derrière son port de validation et son input explicite, uniquement depuis la Portable Configuration et les Local Bindings sauvegardés, avec les métadonnées des Module Packages embarqués. L'adapter Engine charge cet état, fournit les grants et l'accessibilité locale, puis adapte le résultat à la Local API sans posséder la politique de composition. Il contient les routes de requests résolues, les capabilities satisfaites et des findings actionnables ciblant slots, instances ou extrémités d'une edge. Une Request dotée de métadonnées de targeting mais sans émission configurée ne crée ni route ni finding ; une déclaration sans targeting reste soumise à la résolution normale. Toute capability, optionnelle ou requise, est résolue : une optionnelle résolue apparaît dans `satisfiedCapabilities`, tandis que seule son absence de résolution est silencieuse. Chaque capability satisfaite nomme séparément sa cible (`slot` ou `module-instance`) et la ressource source qui la fournit ; un repository utilise le source kind `repository`, et un identifiant de binding ou de candidate n'est jamais présenté comme un `instanceId`. Les routes, capabilities, candidats et findings sont triés par leurs identifiants contractuels ; aucun timestamp ni identifiant aléatoire n'est ajouté. `valid` vaut `true` seulement en l'absence de finding `error`.

`POST /v1/projects/{projectId}/validation-report` est strictement read-only : il ne remplace ni configuration ni bindings, ne change pas l'état du Project et ne crée aucune subscription. `POST /v1/projects/{projectId}/composition-choices` applique la même règle à une configuration sauvegardée ou proposée et dérive un inventaire Event/routage depuis les contrats et Manifests activés, sans stocker de draft ni de graphe. L'ancien `POST /v1/projects/{projectId}/validate` reste une projection fermée `{valid, issues}` pour les clients existants. Les codes stables incluent `project.request-orphaned`, `project.request-ambiguous`, `project.capability-unresolved`, `project.binding-missing`, `project.module-package-unavailable`, `project.instance-config-invalid` et `project.contract-incompatible`. Un package inconnu ou rejeté produit `project.module-package-unavailable` sur le champ `/moduleId`, jamais un faux finding de configuration sous `/configuration/moduleId`.

Le rapport vérifie :

- JSON Schema du projet ;
- packages et versions de modules présents ;
- schémas de configuration de chaque instance ;
- compatibilité event type/version/kind, sans utiliser `schemaRef` comme identité alternative ;
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
