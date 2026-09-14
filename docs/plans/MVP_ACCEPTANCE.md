# MVP Acceptance

## Product acceptance

- [ ] Un utilisateur installe une DMG notariée, déplace `Jarvis.app` dans Applications et démarre le produit par double-clic. Preuve manquante : le poste ne possède ni identité Developer ID ni accès de notarisation ; cette ligne se ferme après installation d'une DMG notariée sur un compte propre.
- [x] Aucun Node.js, broker, conteneur ou base externe n'est requis ([`scripts/smoke-bundle.sh`](../../scripts/smoke-bundle.sh), `bash scripts/smoke-bundle.sh --step launch` : Node embarqué, PATH minimal, health/database ready et arrêt propre).
- [ ] Le shell affiche un moteur prêt ou une erreur actionnable. Le smoke local prouve le handshake et la santé du moteur, pas le démarrage UI du shell macOS.
- [x] Un repository local peut être importé, configuré et réouvert après redémarrage ([`scripts/smoke-bundle.sh`](../../scripts/smoke-bundle.sh), `--step import` puis `--step recovery` : import Git, rejet d'un dossier non-Git, relance sur le même root et Project conservé).
- [ ] Les connexions et runtimes sont bindés par projet, pas imposés globalement.
- [x] Les modules actifs et leur graphe événementiel sont visibles dans l'onglet Graph de Project Detail ([ProjectGraphView](../../apps/macos/JarvisApp/Features/Projects/ProjectGraphView.swift), [ProjectGraphModelTests](../../apps/macos/JarvisAppTests/ProjectGraphModelTests.swift)).

## Guided reliability delivery (2026-09-13)

The detailed evidence is in [PROGRESS.md](../../PROGRESS.md); do not infer closure
of older issue criteria from these observations.

- [x] Four-step native guide, saved draft reopening, scoped account/runtime choices,
  workflow commands and truthful empty preflight observed in isolated data (L03–L07).
- [x] Failed work remains linked after label removal and restart (L08 Harness);
  packaged app shows the retained failure at 1100×800 (Harness data).
- [x] Complete keyboard configuration and activation observed on the real L10 run.
- [ ] Complete VoiceOver error reading: names, values and card activation observed;
  full error reading remains unproven (L09–L10).
- [x] One real bounded issue [#205](https://github.com/Gasppacho/jarvis/issues/205),
  real Codex, successful second validation and one [PR #206](https://github.com/Gasppacho/jarvis/pull/206)
  created by the GitHub module, followed by pause without merge (L10).
- [x] Final clean-worktree `rtk pnpm verify` on `f53a234` (366 unit, 389 integration,
  196 Swift) and identified packaged build, reopened paused at 1100×800 (L10).
- [ ] L15 final receipt: [rapport exécuté](./issue-235-verification.md) ; le
  `rtk pnpm verify` exact est vérifié sur `fd753dc` (**372/372 unit, 400/400
  integration, build app release, 202/202 Swift**, génération/contrats/lint/
  typecheck/architecture passés). Les captures natives et le dogfood GitHub/Codex
  autorisé restent bloqués.

## Reference workflow acceptance

Sur un repository sandbox GitHub et un ticket de fonctionnalité simple :

La preuve manuelle complémentaire est enregistrée dans [l’issue #150](https://github.com/Gasppacho/jarvis/issues/150#issuecomment-5633535201). Les autres lignes citent le test Application Harness qui les démontre.

- [x] Q01 parcourt une issue de `blocked_by` ouvert à une seule PR avec le fake GitHub, le FakeRuntime, SQLite, Git et le Local API ([rapport exécuté](./issue-201-verification.md), [`reference-workflow-first-run.integration.test.ts`](../../apps/engine/test/reference-workflow-first-run.integration.test.ts)).
- [ ] Q01 smoke visuel de l’application SwiftUI assemblée avec captures et VoiceOver ([rapport](./issue-201-verification.md) : preuve manuelle interactive non observée).

- [x] Ajouter `agent:ready` produit exactement un fact `scm.work-item.tag-added` logique ([pushed branch](../../apps/engine/test/reference-workflow-pushed-branch.integration.test.ts)).
- [x] Automation Rules produit une seule request `development.implementation.requested` ([correlation](../../apps/engine/test/reference-workflow-correlation.integration.test.ts)).
- [x] Development alloue un worktree distinct et crée une branche conforme au pattern ([pushed branch](../../apps/engine/test/reference-workflow-pushed-branch.integration.test.ts), [naming](../../apps/engine/test/reference-workflow-naming.integration.test.ts)).
- [x] Le runtime agentique implémente le ticket dans ce worktree ([pushed branch](../../apps/engine/test/reference-workflow-pushed-branch.integration.test.ts)).
- [x] Les commandes requises du projet passent ([pushed branch](../../apps/engine/test/reference-workflow-pushed-branch.integration.test.ts)).
- [x] Development crée un commit non vide et pousse la branche ([pushed branch](../../apps/engine/test/reference-workflow-pushed-branch.integration.test.ts)).
- [x] Development termine sans attendre la Pull Request ([pushed branch](../../apps/engine/test/reference-workflow-pushed-branch.integration.test.ts), [pull request](../../apps/engine/test/reference-workflow-pull-request.integration.test.ts)).
- [x] Development publie `scm.change-request.creation-requested` avec une idempotency key stable ([pull request](../../apps/engine/test/reference-workflow-pull-request.integration.test.ts), [redelivery](../../apps/engine/test/reference-workflow-redelivery.integration.test.ts)).
- [x] GitHub crée une Pull Request depuis la branche existante ([pull request](../../apps/engine/test/reference-workflow-pull-request.integration.test.ts)).
- [x] GitHub publie `scm.change-request.created` avec URL et numéro ([pull request](../../apps/engine/test/reference-workflow-pull-request.integration.test.ts)).
- [x] Une redélivrance ne crée pas une seconde Pull Request ([redelivery](../../apps/engine/test/reference-workflow-redelivery.integration.test.ts)).
- [x] La timeline relie tous les événements/exécutions par correlation/causation ([correlation](../../apps/engine/test/reference-workflow-correlation.integration.test.ts)).

## Reliability acceptance

- [x] Un crash après commit Outbox et avant dispatch ne perd pas l'événement ([durability](../../apps/engine/test/durability.integration.test.ts), `acceptance criteria 1+2: a failpoint deterministically stops the engine after the Outbox commit and before dispatch; after restart the pending row is dispatched, journaled once, the Delivery is created and the handler's side effect happens exactly once`).
- [x] Un crash après side effect GitHub et avant fact local récupère le mapping sans dupliquer ([GitHub Change Request](../../apps/engine/test/github-change-request.integration.test.ts), `recovers a durable mapping after the fact boundary crashes` et `adopts a pull request after creation crashes before mapping`).
- [x] Les deliveries retryables suivent un backoff borné ([policy](../../packages/eventing/src/retry-policy.test.ts) — `grows the delay exponentially by attempt`, `pins the jitter bounds for an attempt`, `never exceeds the hard maximum delay`, `reports exhaustion against the default and caller-selected bounds` ; [delivery](../../apps/engine/src/executions/delivery-consumer.test.ts) — `does not re-offer a retryable Delivery before due and succeeds on its next attempt`).
- [x] Les erreurs permanentes arrivent en dead letter avec replay explicite ([consumer](../../apps/engine/src/executions/delivery-consumer.test.ts) — `a permanent handler failure creates one dead letter and records no Inbox row`, `replays a dead letter with the same event and a marked next attempt` ; [Local API](../../apps/engine/test/dead-letters.integration.test.ts) — `replays a listed Dead Letter through the authenticated Local API`).
- [x] Un redémarrage ne crée pas deux moteurs actifs ni deux workers sur le même lease ([claim](../../apps/engine/test/engine-claim.integration.test.ts) — `rejects a second process on the same root while the first keeps serving` ; [crash boundaries](../../apps/engine/test/durability.integration.test.ts) — `acceptance criteria 1+2` ; [external mapping and Delivery lease recovery](../../apps/engine/test/github-change-request.integration.test.ts) — `recovers a durable mapping after the fact boundary crashes` et `reclaims a leased retry after restart without repeating the attempt or external resource`).
- [x] Une annulation termine le process agent et conserve/nettoie le workspace selon politique ([development cancellation](../../apps/engine/test/development.integration.test.ts) — `cancels the real runtime child, drains it, and retains the cancelled workspace`).

> Limite de preuve #163 : le harness de processus redémarré n'injecte pas d'horloge contrôlée. La fenêtre de lease est donc vérifiée avec l'horloge système, une lease de 3 s et deux ticks observés pendant 400 ms ; cela prouve le fencing SQL et l'absence d'une seconde Execution, mais laisse la déterminisation temporelle complète comme durcissement de test.


## Security acceptance

- [ ] Aucun secret n'est présent dans la base exportée, les événements, logs, prompts ou diagnostics standard.
- [ ] Un projet ne peut pas résoudre un binding appartenant uniquement à un autre projet.
- [ ] Un module ne peut pas publier un type absent de son manifeste.
- [ ] Une request de merge ne peut pas être émise par les modules du MVP.
- [ ] Les commandes provenant du ticket ne sont jamais exécutées comme configuration.
- [ ] L'API refuse les requêtes sans token ou avec Host non autorisé.

## Engineering acceptance

- [ ] Tous les JSON Schema valident les exemples.
- [ ] L'OpenAPI génère les clients attendus sans diff non commité.
- [ ] Les tests d'architecture interdisent les imports module-à-module.
- [ ] Le test Application Harness complet est déterministe.
- [ ] Les suites TypeScript et Swift passent.
- [ ] Le bundle signé passe le smoke test sur une machine propre. Preuve manquante : la validation actuelle est ad hoc sur ce poste ; cette ligne se ferme avec une DMG notariée, un compte/machine propre et le smoke `launch|import|recovery` après installation.
