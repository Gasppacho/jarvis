# Agent Runtimes and MCP

## Purpose

Le contexte Agent Runtime exécute des outils de coding agent sans imposer un fournisseur au domaine. Le module demande une session avec des capabilities et un objectif ; l'adapter traduit vers la CLI liée au projet.

## Port

Conceptuellement :

```ts
interface AgentRuntime {
  describe(): Promise<RuntimeDescriptor>;
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
- MCP bindés au projet ;
- aucun secret brut non requis ;
- aucune connexion d'un autre projet.

Le PATH d'une application GUI macOS n'est pas présumé. Le Runtime Detector résout les exécutables via chemins connus et, si autorisé, un login shell contrôlé. Le chemin final est sauvegardé dans le descriptor local.

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

## Re-entry for repair

Si une commande échoue, Development peut démarrer une nouvelle session de réparation dans la même exécution locale, avec :

- erreur et output tronqué ;
- diff courant ;
- budget de cycles restant.

Le nombre de cycles est borné. Aucun futur événement externe n'est attendu.
