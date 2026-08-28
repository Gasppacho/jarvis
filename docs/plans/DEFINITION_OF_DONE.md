# Definition of Done

Un ticket est Done lorsque :

- [ ] Tous ses critères d'acceptation sont démontrés au seam indiqué.
- [ ] Le test a été observé en échec avant l'implémentation lorsque le changement le permet.
- [ ] Typecheck, tests ciblés et suite complète passent.
- [ ] Les erreurs, cancellation et cas idempotents pertinents sont couverts.
- [ ] Les événements, schemas, manifests, OpenAPI et exemples modifiés restent synchronisés.
- [ ] Les invariants DDD et imports autorisés passent en CI.
- [ ] Les logs et fixtures ne contiennent aucun secret ou chemin personnel réel.
- [ ] La documentation source de vérité est mise à jour sans duplication.
- [ ] Toute nouvelle décision difficile à inverser possède un ADR.
- [ ] `/code-review` a été exécuté et les constats bloquants sont corrigés.
- [ ] Le changement est commité sur une branche nommée selon le projet.
- [ ] Le ticket peut être démontré indépendamment des tickets suivants.
