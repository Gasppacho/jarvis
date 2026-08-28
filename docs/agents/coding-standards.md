# Coding standards

## TypeScript

- Mode `strict` sans exception globale.
- `unknown` aux frontières, validation runtime avant conversion vers le domaine.
- Pas de `any` sauf adapter externe isolé, commenté et couvert par un test contractuel.
- ESM, exports explicites, aucun barrel cross-context masquant une dépendance interdite.
- Erreurs métier typées ; les exceptions brutes restent dans les adapters.
- Temps, UUID, filesystem, processus et réseau injectés derrière des ports testables.
- Les transactions SQLite appartiennent à l'application service qui garantit l'invariant.
- Les handlers d'événements restent minces : charger, appeler le domaine/application, publier via Outbox.

## Swift

- SwiftUI pour la composition d'écran ; AppKit uniquement pour les intégrations macOS qui l'exigent.
- Structured concurrency avec `async/await`; pas de callbacks imbriqués ni de threads manuels dans la UI.
- L'état d'écran dérive de modèles observables et de réponses typées de l'API locale.
- Aucun accès direct à SQLite ou aux modules depuis l'application native.
- Le client HTTP est généré depuis l'OpenAPI lorsque l'opération est contractuelle.
- Les erreurs utilisateur sont actionnables : cause, impact, prochaine action.

## DDD modulaire

- Aucun import entre implémentations de modules.
- Chaque module possède ses tables logiques, son vocabulaire et ses migrations applicatives si nécessaire.
- Les types d'intégration vivent dans les contrats, pas dans un module fournisseur.
- `GitHubPullRequest` reste dans le context GitHub ; `ChangeRequest` est le terme canonique intermodules.
- Le Kernel ne contient pas de règle métier propre à GitHub, au développement ou à la review.

## Tests

- Commencer au seam le plus haut qui peut exprimer le comportement.
- Utiliser de vrais fichiers temporaires, vrais repositories Git locaux et vraie SQLite lorsque cela reste rapide et déterministe.
- Réserver les mocks aux processus, réseau et services externes.
- Toute correction d'un défaut inclut un test qui échoue avant la correction.
