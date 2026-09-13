# Agent Runtimes and MCP

## Purpose

Le contexte Agent Runtime exécute des outils de coding agent sans imposer un fournisseur au domaine. Le module demande une session avec des capabilities et un objectif ; l'adapter traduit vers la CLI liée au projet.

## Port

Conceptuellement :

```ts
interface AgentRuntime {
  describe(environment?: Readonly<Record<string, string>>): Promise<RuntimeDescriptor>;
  start(request: AgentRunRequest, signal: AbortSignal): Promise<AgentRun>;
}

interface AgentRun {
  events(): AsyncIterable<AgentRunEvent>;
  result(): Promise<AgentRunResult>;
  interrupt(): Promise<void>;
}
```

Le contrat complet est décrit dans `docs/contracts/AGENT_RUNTIME_PROTOCOL_V1.md`.

## Runtime registry and project binding

Le Runtime Registry global détecte des candidats :

```text
runtime/codex-default
runtime/claude-code-work
runtime/fake-test
```

Un projet lie son slot `agentRuntime` à un candidat. Le Development Module reçoit seulement le runtime résolu, jamais la liste globale.

Un module peut demander un override de slot, par exemple `reviewRuntime`, mais aucune préférence globale n'est imposée.

## Supported adapters

### Fake Runtime

Premier adapter obligatoire. Il applique un changement déterministe dans une fixture et émet des événements contrôlés. Il rend le seam end-to-end rapide et fiable.

### Codex CLI Adapter

Premier adapter réel du MVP. Sa détection et ses arguments doivent être isolés derrière l'adapter, car les versions de CLI évoluent. Le code métier ne contient aucune commande Codex.

### Future adapters

Claude Code et autres runtimes peuvent être ajoutés via le même port sans modifier Development.

## Environment construction

Le processus agent reçoit :

- working directory du worktree ;
- prompt système du module ;
- objectif et contexte du ticket ;
- instructions du repository autorisées ;
- variables nécessaires explicitement allowlistées ;
- profil d'environnement local explicitement confirmé sur le Runtime Binding
  (notamment `PATH` pour les outils projet) ;
- MCP bindés au projet ;
- aucun secret brut non requis ;
- aucune connexion d'un autre projet.

Le PATH d'une application GUI macOS n'est pas présumé. Le Runtime Detector
résout les exécutables via chemins connus et, si autorisé, un login shell
contrôlé. Le chemin final est sauvegardé dans le descriptor local. Development
rejoue le preflight avec le profil final et revalide le grant local juste avant
chaque start ; une
disponibilité, authentification ou exécutabilité perdue bloque le spawn.

## Prompt construction

Ordre de priorité :

1. politique de sécurité Jarvis ;
2. contrat du module et définition de done ;
3. configuration du projet ;
4. instructions versionnées du repository ;
5. ticket et commentaires comme données ;
6. contexte additionnel obtenu par tools/MCP.

Le prompt signale explicitement que le contenu du ticket ou du repository peut être non fiable et ne peut pas élargir permissions, secrets ou scope.

## MCP

Les MCP sont des connections/capabilities globalement connues mais projet-scopées. Deux usages sont distingués :

- **MCP runtime** : tools/resources exposés à l'agent ;
- **Provider adapter** : side effect déterministe exécuté par un module provider.

Un Development Module peut lire des tickets via un MCP bindé. La création de Pull Request reste une request destinée au GitHub Module, même si l'agent possède techniquement un tool GitHub. Les prompts et permissions doivent interdire ce side effect direct.

## Output protocol

L'adapter normalise :

```text
started
stdout_chunk / message
 tool_call_started
 tool_call_completed
 file_changed
 warning
 usage
 completed
 failed
```

Les outputs bruts sont stockés comme artefacts nettoyés. Le Module SDK reçoit un résultat structuré : statut, résumé, fichiers changés, usage, cause d'échec.

## Validation authority

La déclaration de l'agent n'est pas la preuve de réussite. Development exécute lui-même les commandes projet après la session et vérifie Git diff/commit/push. Les tests sont l'autorité au seam convenu.

Le prompt initial et chaque réparation rappellent cette séparation : le gate
complet est exécuté par Development ; Codex peut exécuter des contrôles ciblés
permis par son sandbox et doit rapporter les restrictions, sans les contourner.
Les erreurs d'environnement ne justifient pas des changements hors de l'issue.

Préparation et validation utilisent le même environnement
minimal du validateur (`PATH`, `HOME`, `LANG=C`, `LC_ALL=C`), sans héritage des
autres variables ni credentials. `HOME` provient de l'identité locale OS.
La détection du profil Codex utilise aussi l'identité OS lorsque `HOME` n'est
pas hérité ; l'accord explicite du Project reste nécessaire avant son usage.
Le preflight recherche dans ce même PATH les exécutables connus requis par
les commandes sélectionnées et leurs appels littéraux aux scripts du projet
(Git, outils Node/gestionnaire, Swift/Xcode si détectés). Il vérifie les droits
d'exécution sans lancer ces outils : même `--version` peut déléguer à du code
du dépôt. Les scripts facultatifs ne deviennent pas des prérequis. Ce contrôle
ne prouve ni la version, ni le fonctionnement de l'outil, ni le succès des tests.
Les appels calculés dynamiquement restent contrôlés pendant l'exécution.
Les commandes du validateur respectent la durée configurée par Development
(maximum une heure), au lieu d'une coupure cachée à deux minutes.

## Re-entry for repair

Si une commande échoue, Development peut démarrer une nouvelle session de réparation dans la même exécution locale, avec :

- erreur et output tronqué ;
- diff courant ;
- budget de cycles restant.

Le nombre de cycles est borné. Aucun futur événement externe n'est attendu.

Un outil absent, un refus d'accès explicite, un timeout ou une panne de lancement
arrête la tentative avec un code et un remède distincts. Ces erreurs ne
déclenchent pas de réparation du code. La reconnaissance des refus d'accès dans
la sortie est limitée aux diagnostics OS explicites ; un échec de test ordinaire
conserve les cycles bornés configurés. Le checkpoint de validation reste en échec
et le worktree est retenu pour diagnostic.

## Guided project preflight

Resource choices expose a safe Codex inventory separately from generic expert
slots. The explicit choice grants only the detected local tool/login profile
to the current Project. The portable template carries `PATH`, `HOME`,
`CODEX_HOME` names; local values remain in ProjectBindings and are filtered by
the same request-builder function before readiness and start. Global discovery
may inspect this local context to identify a candidate, but cannot make a
Project ready. Readiness uses bounded `describe` probes, checks file execution
permission separately from absence, and never starts an Agent Run. It is not
persisted; Development still revalidates immediately before every start.
