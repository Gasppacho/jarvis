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

- [ ] Ajouter `agent:ready` produit exactement un fact `scm.work-item.tag-added` logique.
- [ ] Automation Rules produit une seule request `development.implementation.requested`.
- [ ] Development alloue un worktree distinct et crée une branche conforme au pattern.
- [ ] Le runtime agentique implémente le ticket dans ce worktree.
- [ ] Les commandes requises du projet passent.
- [ ] Development crée un commit non vide et pousse la branche.
- [ ] Development termine sans attendre la Pull Request.
- [ ] Development publie `scm.change-request.creation-requested` avec une idempotency key stable.
- [ ] GitHub crée une Pull Request depuis la branche existante.
- [ ] GitHub publie `scm.change-request.created` avec URL et numéro.
- [ ] Une redélivrance ne crée pas une seconde Pull Request.
- [ ] La timeline relie tous les événements/exécutions par correlation/causation.

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
