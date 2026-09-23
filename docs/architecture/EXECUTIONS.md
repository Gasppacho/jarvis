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

Une nouvelle tentative automatique conserve le même `inputEventId` et porte
`replayed = false`. Un replay explicite conserve aussi cet Event et son
idempotency key, incrémente `attempt` et porte `replayed = true`. Une tentative
permanente ou la dernière tentative après épuisement reste dans le Ledger comme
`failed` et sa Dead Letter pointe vers cette dernière Execution lorsqu'elle
existe ; aucune Inbox n'est créée pour ces échecs tant qu'un essai ne termine
pas avec succès.

## Local loop

Une loop est une implémentation privée au module. Exemple Development :

```text
Load work item context
Allocate workspace
Create branch
Invoke agent
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
preparation.started
preparation.completed
preparation.failed
agent.started
agent.message
commit.created
branch.pushed
```

Les anciens journaux peuvent encore contenir `agent.repair-started` et les
checkpoints `validation.*`; ils restent lisibles mais ne sont plus produits.

Ces progrès ne sont pas des événements intermodules sauf s'ils représentent un fait d'intégration déclaré. Le flux temps réel peut être perdu sans compromettre la vérité durable.
Une préparation `install` possède des checkpoints durables : une reprise ne la
relance jamais après son démarrage incomplet ; l'exécution reste retenue pour
confirmation explicite.

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

## Development admission

Une Request Development qui ne peut pas encore obtenir sa capacité reste une Delivery durable non consommée. Son identité est la Delivery existante : elle ne consomme ni tentative de retry, ni budget de réparation, ni Dead Letter. L'admission est ordonnée par l'arrivée durable puis l'identifiant de Delivery, est limitée par projet, et revérifie l'issue provider avant l'allocation du Workspace. La suspension d'admission est durable et interdit les nouveaux départs sans annuler une Execution déjà active.

Les claims Development réservent la capacité avant même l'allocation du
Workspace. Les handlers actifs renouvellent leur Delivery lease avec son
propriétaire ; les ticks continuent de traiter les faits, les autres projets
et les créations de PR. Une PR à relire ne retient aucune capacité Development.

La revérification et la lecture complète du Work Item précèdent l'allocation.
Une dépendance ouverte ou une observation impossible diffère la Delivery sans
budget d'échec ; elle ne bloque pas une candidate suivante vérifiable. Une issue
fermée ou délabellisée termine son admission avec une raison `ineligible` : sa
Delivery est consommée sans exécution échouée ni Dead Letter. Suspendre/reprendre
ou rouvrir l'issue ne rejoue pas cette admission terminale.

`GET /v1/projects/{projectId}/development-admission` expose les candidates en
attente et les admissions retirées avec leur raison, en excluant les travaux
qui possèdent déjà un Workspace actif. Les commandes `suspend` et `resume`
portent uniquement sur le projet ; reprendre réévalue les admissions différées
sans raccourcir le backoff d'un véritable échec. Une admission différée ne
supprime jamais les checkpoints d'une Execution récupérée.

Les anciennes Requests v1 sans `tag` réutilisent le label de leur Fact causal
durable, avec le même projet, repository et Work Item. Si cette provenance
manque, l'admission reste `impossible` (`ready-label-unknown`) ; aucun label par
défaut n'est inventé. Une observation inéligible pendant une récupération déjà
checkpointée conserve l'Execution et sa Delivery sous
`work-item-recovery-required`, sans supprimer son progrès ni la déclarer terminée.

## Recovery after a Development push

Before pushing, Development persists `commit.created` with the expected branch
and SHA and the sanitized Work Item title. No raw command environment or remote
credentials are added to this snapshot. This additive checkpoint payload uses
the existing Execution Ledger; it is not a new workflow journal or event contract.

Recovery reads checkpoints for the original input Event, Project and Module
Instance, including earlier failed attempts. It runs before allocation, work-item
readiness or Agent Runtime invocation. It checks the original lease, local branch
SHA, retained worktree HEAD/cleanliness and exact remote ref/SHA. An unambiguous
match finalizes the existing pushed change and publishes the normal completed
Fact and Change Request creation Request in the existing terminal Outbox
transaction. Correlation, causation and the PR idempotency key remain unchanged.
After cleanup but before that transaction, another crash can recover through
the released lease and retained repository branch.

Local changes or remote divergence stop recovery for operator inspection. An unavailable remote/branch follows the
existing bounded Delivery retries; exhaustion allows explicit Dead Letter replay
once access/evidence is restored. No recovery path calls the agent, pushes,
resets, or creates a worktree. Failure messages remain visible through the
Execution timeline, failure Fact and Dead Letter diagnostics.

Startup retains workspaces with commit/push evidence, even beyond ordinary
failure retention. A live foreign owner prevents recovery and release. If its
directory is temporarily inaccessible, project cleanup/pruning waits too.
Successful recovery releases the original lease; failure preserves its work.

## Correlated execution detail

The Project Service exposes `GET /v1/projects/{projectId}/executions/{executionId}/detail`
as a read projection owned by the API boundary. It resolves the anchor Execution and its
input Event through project-scoped repositories, then joins only the Event journal, Ledger,
Execution checkpoints, workspace lease and Dead Letter read APIs. It does not open another
module's database or create a second workflow journal. The seven UI steps and Pull Request
result are derived from durable facts; future steps are not-started, and missing proof is unavailable. Check outcomes and repair starts are durable checkpoints; failed attempts remain in the bounded check history after a successful repair.

The projection keeps the existing finite Execution model: cancellation records a terminal
result, while a retry replays an existing Dead Letter and starts the normal delivery path.
The live badge is supplied by the existing SSE Timeline stream; REST remains the snapshot
source after reconnect. Technical event payloads are bounded and redacted before leaving
the Engine, and no merge request is emitted by the read path.
