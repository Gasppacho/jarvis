# UX macOS

## Navigation principale

La fenêtre principale utilise une sidebar native :

```text
Jarvis
├── Projects
│   ├── Token Warehouse
│   └── Client A
├── Connections
├── Agent Runtimes
├── Module Catalog
└── Settings
```

Lorsqu'un projet est sélectionné :

```text
Overview · Graph · Modules · Executions · Events · Artifacts · Settings
```

## Premier lancement

Le premier lancement ne demande aucune configuration métier globale. Il :

1. initialise le stockage ;
2. détecte Git, `gh` et les runtimes connus ;
3. affiche l'état du moteur ;
4. propose `Import a repository`.

Les connexions peuvent être créées pendant le wizard projet ou depuis l'écran global.

## Wizard projet

### Étape 1 — Repository

L'utilisateur choisit un dossier. Jarvis obtient un security-scoped bookmark et détecte :

- repository Git ;
- remote et provider probables ;
- branche par défaut ;
- manifests de package ;
- package manager ;
- scripts disponibles ;
- fichiers d'instructions agentiques.

### Étape 2 — Écosystème

Jarvis propose sans imposer :

- commandes install, lint, typecheck, test, build ;
- convention de branche ;
- remote de push ;
- nombre maximal d'exécutions concurrentes.

### Étape 3 — Ressources

L'utilisateur lie :

- slot `sourceControl` ;
- slot `tickets` ;
- slot `agentRuntime` ;
- MCP optionnels.

Une ressource globale n'est pas visible des agents du projet sans ce binding.

### Étape 4 — Modules

Un Project fraîchement importé commence par deux choix nommés : `GitHub Development`
ou `Custom composition`. Le premier remplit un Draft canonique; le second conserve les
valeurs détectées et laisse la composition vide. Aucun choix ne lie ni n'autorise une
ressource locale.

Pour le template GitHub Development :

```text
[✓] GitHub
[✓] Automation Rules
[✓] Development
[ ] Change Request Review
[ ] Auto Merge
```

Chaque carte mène par le nom et la description du Module Package. Elle affiche les
Events consommés et émis, les capabilities requises, la compatibilité et les ressources
manquantes provenant de la prévisualisation Engine. `Advanced` révèle seulement ensuite
l'Instance ID, le Package ID, la version et les détails contractuels. Ajouter, retirer,
activer, désactiver ou changer un package redemande immédiatement les choix au Local API;
une réponse devenue obsolète ne remplace jamais un Draft plus récent et les autres
valeurs saisies restent intactes.

### Étape 5 — Validation

Jarvis affiche :

- contrats compatibles ;
- requests résolues ;
- capabilities satisfaites ;
- accès au repository ;
- connexion au provider ;
- runtime disponible ;
- commandes valides.

Un projet invalide peut être sauvegardé mais pas activé.

### Grammaire de composition guidée

La grammaire retenue est un **parcours par étapes persistantes dans un split view natif** : `Starting point`, `Module Instances`, `Automation Rules`, `Resources`, puis `Review`. La liste d'étapes reste visible et signale les éléments complets, incomplets ou bloqués ; le panneau de détail édite une étape à la fois. L'utilisateur peut revenir à toute étape sans perdre les valeurs du Draft. La divulgation est progressive, mais `Review` reste toujours accessible et distingue un Draft sauvegardable de l'état de validation détenu par l'Engine.

Cette décision vient d'une comparaison de trois prototypes SwiftUI structurellement différents, tous alimentés par les mêmes quatre fixtures en mémoire, de forme `jarvis.dev/project-composition-choices/v1` :

- **Fresh** : aucun starting point, aucune Module Instance et aucun Event choisi ;
- **Valid** : GitHub Development, une Request résolue et une ressource éligible liée ;
- **Orphaned** : la phrase de Rule est conservée, mais l'Engine explique qu'aucun consumer actif n'est disponible et qu'aucune ressource éligible n'existe ;
- **Ambiguous** : deux consumers actifs sont présentés avec l'explication de routage de l'Engine.

| Prototype | Structure | Utilisabilité et divulgation | Préservation / états vides | Clavier, VoiceOver et texte accessible |
|---|---|---|---|---|
| Assistant modal linéaire | Une séquence `Back` / `Next` qui verrouille les étapes futures | Très clair pour Fresh, mais masque trop longtemps les conflits Orphaned/Ambiguous et rend la correction transversale lente | Les valeurs survivent à `Back`, mais la validation par page encourage à bloquer un Draft incomplet ; les états vides sont actionnables mais isolés | Ordre clavier simple ; VoiceOver perd le contexte global et annonce mal la relation entre erreur et étape masquée |
| Canevas de composition | Colonnes Module Instance → Event → consumer/resource, avec Review en panneau | Excellent pour lire Valid et Ambiguous, mais dense, peu progressif et trop proche d'un éditeur de graphe impératif | La phrase reste visible lors d'un conflit ; Fresh devient un grand canevas vide dont l'action initiale est peu évidente | Navigation bidimensionnelle coûteuse ; ordre VoiceOver et représentation texte/liste fragiles |
| Étapes persistantes en split view | Liste d'étapes avec état, détail de l'étape sélectionnée et Review toujours accessible | Bon point de départ pour Fresh, correction directe d'Orphaned/Ambiguous, et vue globale sans prétendre persister un graphe | Le même Draft alimente toutes les étapes ; chaque vide nomme l'indisponibilité, son impact et l'action de réparation | Ordre clavier stable liste puis détail ; chaque ligne expose label, valeur, état et hint ; le contenu possède une représentation textuelle/liste complète |

Le troisième prototype est retenu : il combine la progression du wizard avec la navigation de réparation nécessaire aux Drafts réouverts, respecte le split view macOS existant et ne transforme pas les Events en graphe éditable. Les prototypes et leurs assets ont été supprimés après comparaison ; aucun `View` prototype n'est une surface de production.

L'inventaire de présentation retenu est piloté par les données : cinq sections ordonnées, des lignes avec état et action, un ordre clavier stable, puis pour chaque ligne un rôle, un label, une valeur et un hint accessibles. Les phrases saisies sont distinctes des explications de routage. Les statuts `resolved`, `broadcast`, `orphaned` et `ambiguous` ainsi que leurs explications viennent de la réponse de l'Engine ; Swift ne recalcule ni consumer ni compatibilité.

La comparaison native utilise le build de l'app empaquetée pour vérifier structure, tailles et navigation, et XCTest vérifie l'inventaire observable sur les quatre fixtures. SwiftPM ne fournit pas de target XCUITest pour l'exécutable SwiftPM macOS ; l'automatisation UI/VoiceOver de bout en bout reste donc une vérification manuelle de l'app empaquetée, et non un test `swift test` prétendument équivalent.

## Overview projet

Affiche :

- statut actif/inactif/dégradé ;
- dernière activité ;
- exécutions en cours ;
- requests sans consommateur ;
- dead letters ;
- liens repository et provider ;
- actions `Pause`, `Validate`, `Run diagnostics`.

## Suppression d'un projet

Project Detail expose l'action destructive `Delete Project…`. Elle ouvre une confirmation native qui nomme le Project et explique que l'état Jarvis local, les Local Bindings et le Repository Grant seront retirés, tandis que tous les fichiers du repository — dont `.jarvis/project.yaml` — resteront intacts.

`Cancel` ne déclenche aucune opération. Après confirmation, la sidebar et sa sélection ne sont effacées qu'une fois la suppression moteur réussie. Un échec API conserve le Project et son Repository Grant ; un échec de nettoyage du grant après suppression moteur est signalé comme résultat partiel. Un Project actif doit d'abord être pausé.

## Graphe émergent

Le graphe est dérivé des manifests et instances actives. Il n'est pas un éditeur de workflow impératif.

```text
[GitHub]
    └─ scm.work-item.tag-added
           ↓
[Automation Rules]
    └─ development.implementation.requested
           ↓
[Development]
    └─ scm.change-request.creation-requested
           ↓
[GitHub]
    └─ scm.change-request.created
```

États visuels :

- chemin valide ;
- request orpheline ;
- plusieurs consommateurs illégaux ;
- module désactivé ;
- contrat incompatible.

## Executions

Liste filtrable par projet, module, statut et corrélation. Une fiche affiche :

- input event ;
- module instance ;
- début, durée et tentative ;
- étapes de loop ;
- sorties publiées ;
- logs structurés et flux agentique ;
- workspace et artefacts ;
- action d'annulation lorsque possible ;
- diagnostic de l'échec.

## Events

La timeline montre requests et facts avec une distinction visuelle claire. Chaque événement affiche :

- type/version/kind ;
- producer ;
- consumer(s) ;
- correlation/causation ;
- subject ;
- payload nettoyé ;
- état de livraison et retries.

## Menu bar

L'icône de menu bar expose :

- état du moteur ;
- nombre d'exécutions actives ;
- pause globale ;
- projets actifs ;
- ouverture de la fenêtre ;
- quitter Jarvis.

Fermer la fenêtre ne quitte pas le produit lorsque le mode menu bar est actif. `Quit Jarvis` arrête proprement les projets puis le moteur.

## Erreurs

Toute erreur visible doit répondre à trois questions :

1. Qu'est-ce qui est indisponible ?
2. Quel comportement est impacté ?
3. Quelle action précise peut corriger la situation ?

Exemple :

```text
Codex runtime unavailable
Development cannot start for Token Warehouse.
Reconnect the runtime or bind another runtime in Project Settings.
```
