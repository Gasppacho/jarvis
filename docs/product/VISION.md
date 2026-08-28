# Vision produit

## Proposition

**Jarvis est un système d'exploitation local pour automatisations agentiques modulaires, présenté comme une application native macOS.**

L'utilisateur assemble des modules autonomes qui consomment et publient des événements. Le workflow global émerge de cette composition comme un jeu de Lego : ajouter ou retirer un module ajoute ou retire un comportement sans modifier les autres blocs.

## Problème

Les workflows agentiques de développement sont souvent :

- enfermés dans un script monolithique ;
- couplés à un provider précis ;
- difficiles à observer et à reprendre après une erreur ;
- configurés globalement alors que chaque projet possède son propre écosystème ;
- dépendants d'une infrastructure séparée ou de commandes de démarrage multiples ;
- opaques sur la responsabilité de chaque side effect.

## Expérience cible

L'utilisateur installe `Jarvis.app`, l'ouvre, importe un repository et configure ce projet :

- provider de code source et de tickets ;
- connexions et MCP autorisés ;
- runtime agentique ;
- commandes de build, test, lint et typecheck ;
- modules actifs ;
- règles transformant les faits en travail demandé.

Après activation, le projet peut réagir à ses événements sans que l'utilisateur lance manuellement chaque loop. L'application affiche le graphe émergent, les exécutions, les événements, les logs et les erreurs.

## Principes produit

### Local-first

Les fonctions principales tournent sur le même Mac que l'interface. Les repositories, worktrees, événements, exécutions et artefacts restent locaux sauf side effect explicite vers un service connecté.

### Un seul produit à démarrer

Un double-clic démarre l'interface et le moteur embarqué. Aucun conteneur, serveur distant ou runtime système installé manuellement n'est nécessaire pour le fonctionnement du produit livré.

### Composition par projet

Chaque projet choisit ses modules et ressources. Une connexion peut être enregistrée une fois globalement, mais elle n'est accessible à un projet qu'après binding explicite.

### Bounded contexts exécutables

Un module peut contenir une loop, plusieurs agents, des tools, des prompts, un modèle de domaine et des adapters. Le mot « module » désigne la frontière de comportement et de propriété.

### Chorégraphie, pas orchestration centrale

Le Kernel transporte et trace les événements ; il ne connaît pas le workflow métier. Une suite existe seulement parce que les modules actifs produisent et consomment des contrats compatibles.

### Side effects explicites

Une intention et un fait accompli sont distincts. Le provider n'agit qu'après une request. L'absence de module décisionnel signifie l'absence d'action correspondante.

### Provider-agnostic aux frontières

Les autres modules manipulent `WorkItem` et `ChangeRequest`, pas `GitHub Issue`, `Pull Request` ou `Merge Request`. Les traductions restent dans les providers.

## Vision long terme

Le développement logiciel est le premier domaine, pas la limite du produit. Les mêmes primitives peuvent accueillir des modules pour incidents, communication, recherche, support, opérations ou contenu, tant que chaque comportement respecte les contrats événementiels et l'isolation par projet.
