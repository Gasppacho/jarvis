# Spécification MVP — Du ticket prêt à la Pull Request

## Problem Statement

Un développeur souhaite déléguer l'implémentation de tickets simples à un agent sans construire une automation spécifique pour chaque repository, sans démarrer plusieurs services et sans coupler le workflow à une séquence monolithique. Les projets n'utilisent pas tous le même provider, les mêmes commandes, les mêmes connexions ou le même runtime agentique. Le développeur a besoin d'un produit local, observable et modulaire qui transforme un ticket explicitement marqué comme prêt en une branche testée, commitée, poussée et proposée en Pull Request.

## Solution

Livrer une application native macOS autonome qui :

1. importe un repository local comme projet Jarvis ;
2. détecte son écosystème et demande une configuration propre au projet ;
3. active des instances de modules isolées pour ce projet ;
4. observe GitHub pour un label `agent:ready` ;
5. traduit ce fait en `development.implementation.requested` via un module de règles ;
6. exécute le module Development dans un Git worktree ;
7. utilise le runtime agentique lié au projet ;
8. lance les validations configurées, commit et push ;
9. publie `scm.change-request.creation-requested` ;
10. demande au module GitHub de créer la Pull Request ;
11. publie et affiche `scm.change-request.created` ;
12. conserve une timeline durable reliant toutes les exécutions par corrélation.

## User Stories

1. En tant qu'utilisateur, je veux installer Jarvis comme une application macOS afin de ne pas administrer une infrastructure séparée.
2. En tant qu'utilisateur, je veux ouvrir Jarvis par double-clic afin que l'interface et le moteur local démarrent ensemble.
3. En tant qu'utilisateur, je veux voir un état « prêt » ou une erreur actionnable afin de savoir si le moteur fonctionne.
4. En tant qu'utilisateur, je veux importer un repository local afin de créer un projet Jarvis.
5. En tant qu'utilisateur, je veux que Jarvis détecte Git, le remote, la branche par défaut, le package manager et les commandes probables afin de réduire le setup.
6. En tant qu'utilisateur, je veux confirmer ou corriger les valeurs détectées afin de garder le contrôle.
7. En tant qu'utilisateur, je veux enregistrer plusieurs connexions globales afin de les réutiliser sans recopier leurs secrets.
8. En tant qu'utilisateur, je veux lier explicitement une connexion à un projet afin d'empêcher les accès interprojets accidentels.
9. En tant qu'utilisateur, je veux sélectionner un runtime agentique par projet afin d'adapter l'outil au contexte.
10. En tant qu'utilisateur, je veux pouvoir changer de runtime pour un module précis afin d'utiliser un spécialiste différent.
11. En tant qu'utilisateur, je veux activer ou désactiver des modules par projet afin de composer le comportement voulu.
12. En tant qu'utilisateur, je veux voir les événements consommés et produits par un module afin de comprendre sa place.
13. En tant qu'utilisateur, je veux valider la composition avant activation afin de détecter une request sans consommateur.
14. En tant qu'utilisateur, je veux que les événements d'un projet restent dans ce projet afin d'éviter toute fuite de travail.
15. En tant qu'utilisateur, je veux qu'un label `agent:ready` déclenche le workflow uniquement dans les projets configurés pour ce label.
16. En tant qu'utilisateur, je veux que le module GitHub publie un fait canonique plutôt que de lancer directement le développement afin de garder les modules découplés.
17. En tant qu'utilisateur, je veux que le module de règles transforme le fait en demande de développement afin de pouvoir changer la règle sans modifier GitHub ou Development.
18. En tant qu'utilisateur, je veux que le module Development reçoive le ticket et son contexte afin que l'agent comprenne le travail.
19. En tant qu'utilisateur, je veux que les commentaires de ticket soient traités comme données non fiables afin qu'ils ne puissent pas contourner les règles de Jarvis.
20. En tant qu'utilisateur, je veux que chaque exécution utilise un worktree distinct afin que deux travaux ne se contaminent pas.
21. En tant qu'utilisateur, je veux que la branche respecte un pattern propre au projet afin de conserver ses conventions.
22. En tant qu'utilisateur, je veux que le module Development modifie le code dans son worktree afin que le provider ne soit pas responsable du contenu.
23. En tant qu'utilisateur, je veux que les commandes de lint, typecheck, test et build du projet soient exécutées selon sa configuration afin de vérifier le changement.
24. En tant qu'utilisateur, je veux voir la sortie du runtime agentique en direct afin de suivre l'avancement.
25. En tant qu'utilisateur, je veux pouvoir annuler une exécution afin de reprendre la main.
26. En tant qu'utilisateur, je veux qu'une exécution échouée conserve les informations utiles et le worktree selon une politique configurée afin de diagnostiquer.
27. En tant qu'utilisateur, je veux que le module Development crée le commit et pousse la branche afin que la production du changement reste sa responsabilité.
28. En tant qu'utilisateur, je veux qu'après le push il publie une demande de création de Change Request afin que le provider exécute le side effect externe.
29. En tant qu'utilisateur, je veux que le module GitHub crée une Pull Request à partir de la branche déjà poussée afin de respecter les rôles.
30. En tant qu'utilisateur, je veux qu'une redélivrance de la demande ne crée pas deux Pull Requests afin de garantir l'idempotence.
31. En tant qu'utilisateur, je veux voir l'URL et le numéro de la Pull Request afin d'ouvrir le résultat.
32. En tant qu'utilisateur, je veux voir une timeline corrélée du label à la Pull Request afin de comprendre ce qui s'est produit.
33. En tant qu'utilisateur, je veux voir chaque request, son consommateur et son résultat afin de repérer une rupture du graphe.
34. En tant qu'utilisateur, je veux que l'application récupère après un redémarrage afin de ne pas perdre les événements durablement acceptés.
35. En tant qu'utilisateur, je veux que les retries soient visibles et bornés afin d'éviter une boucle silencieuse.
36. En tant qu'utilisateur, je veux qu'un message définitivement échoué arrive dans une dead-letter queue afin de pouvoir l'inspecter.
37. En tant qu'utilisateur, je veux exporter un diagnostic nettoyé des secrets afin de partager un problème.
38. En tant que développeur de module, je veux un manifeste versionné afin de déclarer les contrats, capabilities et configurations.
39. En tant que développeur de module, je veux tester un module avec un Event Bus et des adapters fake afin de vérifier son comportement sans l'application complète.
40. En tant que développeur de module, je veux qu'un import direct d'un autre module échoue en CI afin de préserver les bounded contexts.
41. En tant qu'utilisateur, je veux qu'aucun merge ne soit effectué dans le MVP afin que la création de PR soit la limite explicite du premier workflow.
42. En tant qu'utilisateur, je veux que l'ajout futur d'un module de review ne demande aucune modification à GitHub ou Development afin de valider le modèle Lego.

## Implementation Decisions

### Produit et processus

- Cible MVP : Apple Silicon, macOS 15 ou supérieur.
- Distribution directe par application signée et notariée ; pas de Mac App Store pour le MVP.
- `Jarvis.app` contient une interface SwiftUI/AppKit et lance un moteur TypeScript comme processus enfant supervisé.
- Le runtime Node.js LTS est embarqué ; l'utilisateur n'installe pas Node.js.
- Le moteur expose une API HTTP uniquement sur loopback et un flux SSE. L'application génère un token éphémère au démarrage.

### Architecture

- Modular monolith DDD, une seule base SQLite en mode WAL, propriété logique des tables par context.
- Projet = composition root et frontière de routage.
- Packages de modules officiels embarqués dans le MVP ; instances et configuration créées par projet.
- Communication intermodules exclusivement par événements versionnés.
- Livraison au moins une fois avec Inbox, Outbox, idempotency key, retry borné et dead-letter queue.
- Les facts peuvent avoir zéro à plusieurs consommateurs. Une request doit résoudre à exactement un consommateur actif dans son projet.
- Les gros contenus sont des artefacts référencés, pas des payloads d'événements.

### Git et agents

- Un projet possède un repository principal pour le MVP.
- Development alloue un Git worktree, crée la branche, lance l'agent, valide, commit et push.
- GitHub ne crée que la Pull Request à partir d'une branche distante existante.
- Le runtime agentique est un port. Le MVP livre d'abord un Fake Runtime déterministe puis un adapter Codex CLI réel.
- Les connexions, MCP et runtimes sont découverts globalement mais bindés au projet.

### Configuration

- `.jarvis/project.yaml`, commité, contient la configuration portable sans secret ni chemin absolu.
- Les chemins locaux, security-scoped bookmarks, IDs de connexions et IDs de runtimes sont stockés dans les bindings locaux.
- Les contrats JSON Schema et OpenAPI sont versionnés dans le dépôt.

## Testing Decisions

Le seam principal du MVP est un **Application Harness local** qui démarre une vraie SQLite temporaire, le vrai Kernel, de vrais modules, un repository Git temporaire avec remote bare, un Fake Agent Runtime et un Fake GitHub Adapter. Il pilote le système par la même API locale que l'application macOS et observe les événements/exécutions via SSE ou requêtes.

Ce seam doit prouver :

1. import et activation d'un projet ;
2. réception d'un fait `scm.work-item.tag-added` ;
3. production de `development.implementation.requested` ;
4. création du worktree et de la branche ;
5. modification déterministe du fixture ;
6. validations, commit et push ;
7. publication de `scm.change-request.creation-requested` ;
8. création idempotente d'une Change Request fake ;
9. publication de `scm.change-request.created` ;
10. timeline corrélée et persistée après redémarrage.

Tests complémentaires :

- tests contractuels des JSON Schema et exemples ;
- tests d'architecture sur les imports ;
- tests de redélivrance et de crash entre transaction et dispatch ;
- XCTest du superviseur de processus et du client généré ;
- XCUITest minimal du setup et de la timeline ;
- test d'intégration réel GitHub désactivé par défaut, exécuté sur un repository sandbox.

## Out of Scope

- GitLab et autres providers.
- Auto-merge ou déploiement.
- Module de Change Request Review dans le chemin de sortie MVP.
- Marketplace et chargement de modules tiers non signés.
- Multi-repository par projet.
- Exécution multi-machine, cloud ou contrôle distant.
- Interface vocale ou modèle conversationnel local.
- Éditeur visuel imposant un workflow central.
- App Sandbox et distribution Mac App Store.
- Exécution automatique de commandes arbitraires provenant d'un ticket.

## Further Notes

- La première fixture de démonstration doit demander une fonctionnalité simple, par exemple un endpoint `GET /health` avec test.
- Le polling GitHub est accepté comme source d'événements entrante du MVP ; l'architecture conserve un port pour ajouter un adapter webhook plus tard.
- Le module de review est le premier module post-MVP recommandé pour démontrer l'extensibilité sans modifier le workflow existant.
