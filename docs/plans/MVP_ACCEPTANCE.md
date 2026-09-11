# MVP Acceptance

## Product acceptance

- [ ] Un utilisateur installe une DMG notariée, déplace `Jarvis.app` dans Applications et démarre le produit par double-clic.
- [ ] Aucun Node.js, broker, conteneur ou base externe n'est requis.
- [ ] Le shell affiche un moteur prêt ou une erreur actionnable.
- [ ] Un repository local peut être importé, configuré et réouvert après redémarrage.
- [ ] Les connexions et runtimes sont bindés par projet, pas imposés globalement.
- [ ] Les modules actifs et leur graphe événementiel sont visibles.

## Reference workflow acceptance

Sur un repository sandbox GitHub et un ticket de fonctionnalité simple :

La preuve manuelle complémentaire est enregistrée dans [l’issue #150](https://github.com/Gasppacho/jarvis/issues/150#issuecomment-5633535201). Les autres lignes citent le test Application Harness qui les démontre.

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

- [ ] Un crash après commit Outbox et avant dispatch ne perd pas l'événement.
- [ ] Un crash après side effect GitHub et avant fact local récupère le mapping sans dupliquer.
- [ ] Les deliveries retryables suivent un backoff borné.
- [ ] Les erreurs permanentes arrivent en dead letter avec replay explicite.
- [ ] Un redémarrage ne crée pas deux moteurs actifs ni deux workers sur le même lease.
- [ ] Une annulation termine le process agent et conserve/nettoie le workspace selon politique.

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
- [ ] Le bundle signé passe le smoke test sur une machine propre.
