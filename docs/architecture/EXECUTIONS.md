# Executions and Agentic Loops

## Execution

Une **Execution** est une invocation durable d'un handler d'une instance de module pour un événement d'entrée. Elle sert à l'observabilité, au contrôle et aux retries ; elle n'est pas un workflow global.

```text
Delivery claimed
    ↓
Execution created
    ↓
Handler / local loop
    ↓
Outbox events recorded
    ↓
Execution completed
```

## Finite work invariant

Une exécution doit atteindre un état terminal sans attendre un futur événement externe. Elle peut attendre :

- un processus enfant qu'elle a lancé ;
- un appel réseau qu'elle effectue ;
- une commande locale ;
- une validation ou un timeout local.

Elle ne reste pas `waiting_for_ci`, `waiting_for_review` ou `waiting_for_webhook`. Ces faits créent de nouvelles executions dans les modules abonnés.

## States

```text
queued
running
cancelling
completed
failed
cancelled
timed_out
```

Les retries créent une nouvelle `attempt` liée à la même delivery logique, pas une nouvelle chaîne métier. L'Execution Ledger garde les deux.

## Local loop

Une loop est une implémentation privée au module. Exemple Development :

```text
Load work item context
Allocate workspace
Create branch
Invoke agent
Run validation commands
Ask agent to repair failures (bounded)
Commit
Push
Publish outputs
Cleanup according to policy
```

Le Kernel observe les étapes par `ExecutionProgress`, mais ne les interprète pas comme un workflow global.

## Execution context

Le Module SDK fournit un contexte immutable :

- `projectId`, `repositoryId`, `moduleInstanceId` ;
- input event ;
- clock et IDs ;
- scoped logger ;
- scoped artifact store ;
- Outbox publisher ;
- capabilities résolues ;
- cancellation signal ;
- execution metadata.

Aucune connexion globale non bindée n'est accessible.

## Progress

Les modules peuvent publier des progrès éphémères vers l'UI et des checkpoints structurés durables :

```text
workspace.allocated
agent.started
agent.message
validation.started
validation.failed
commit.created
branch.pushed
```

Ces progrès ne sont pas des événements intermodules sauf s'ils représentent un fait d'intégration déclaré. Le flux temps réel peut être perdu sans compromettre la vérité durable.

## Cancellation

- Le shell demande l'annulation par API.
- Le Kernel marque `cancelling` et déclenche `AbortSignal`.
- L'adapter agent envoie d'abord une interruption gracieuse, puis termine après délai.
- Le module décide si le worktree est conservé.
- Aucun output success n'est publié après annulation.
- Un fact métier `development.implementation.cancelled` peut être produit s'il est contractuel.

## Timeouts and budgets

Chaque module/instance peut définir :

- temps total ;
- temps sans output ;
- nombre de cycles de réparation ;
- budget de tokens/coût si exposé ;
- taille de logs ;
- nombre de commandes ;
- nombre de fichiers modifiables selon politique future.

Le timeout est borné par une limite système supérieure.

## Development execution success

Une exécution Development est `completed` seulement si :

1. le worktree existe et cible la bonne base ;
2. l'agent a produit un changement ;
3. les commandes requises passent ;
4. un commit non vide est créé ;
5. la branche est poussée au remote configuré ;
6. l'Outbox contient `development.implementation.completed` et `scm.change-request.creation-requested` dans la transaction terminale.

La création effective de la Pull Request n'affecte pas cet état.

## Failure model

Les erreurs sont classées :

- `configuration` : projet ou binding invalide ;
- `input` : événement ou ticket non exploitable ;
- `workspace` : Git/worktree ;
- `agent` : runtime indisponible ou sortie invalide ;
- `validation` : tests/build restent rouges après budget ;
- `external` : push ou provider ;
- `cancelled` ;
- `internal`.

Chaque erreur possède code stable, message utilisateur, détails techniques nettoyés et retryability.

## No hidden continuation

Un identifiant d'exécution ne doit jamais être placé dans un webhook pour « reprendre » une loop. Les liens valides sont `correlationId`, `causationId`, `subject` et les références métier. Cette règle garantit que chaque module reste autonome et remplaçable.
