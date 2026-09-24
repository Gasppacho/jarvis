# Plan — UI native macOS et Liquid Glass

Date : 24 septembre 2026. Statut : lots UI-01 à UI-05 implémentés ; UI-06 partielle,
recette visuelle native bloquée par l'absence de fenêtre observable dans la session de validation.

## Résultat attendu

Faire évoluer toutes les interfaces de Jarvis vers la direction présentée dans
la maquette : navigation macOS familière, hiérarchie lisible, contenu calme,
commandes explicites et Liquid Glass utilisé aux endroits prévus par Apple.
L'utilisateur doit comprendre quel projet il regarde, ce qui se passe et quelle
action est utile, y compris lorsque les données manquent ou qu'une opération échoue.

La maquette de conversation est une référence visuelle avec des données fictives.
Les comportements de référence restent ceux de [UX.md](../../product/UX.md), des
modèles de présentation et des réponses du moteur.

## Point de départ vérifié

- `RootView` utilise déjà `NavigationSplitView`, une liste native de projets et
  une bibliothèque. Réutiliser cette structure et le sélecteur de dossier existant.
- `ProjectDetailView` propose déjà Configurer, Superviser, Suivre et Diagnostics.
  La sélection d'exécution est effacée au changement de projet.
- `ProjectOnboardingView` porte déjà les trois écrans de configuration, également
  utilisés par les projets actifs. Les étapes ont encore un style personnalisé.
- `ProjectExecutionDetailView` dispose déjà d'une disposition adaptative, des
  messages d'agent, des erreurs, de la Pull Request et de détails repliables.
- Les règles et actions sont portées par `JarvisCore` et le moteur ; les vues les
  présentent. Cette séparation permet une migration principalement dans `JarvisApp`.
- La cible de déploiement est **macOS 15+**. Le poste inspecté dispose de
  **Xcode 27.0 / SDK macOS 27.0** ; cela ne prouve ni compilation de la refonte,
  ni compatibilité d'exécution sur les versions précédentes.
- Le package SwiftPM contient des tests de `JarvisCore`, sans cible XCUITest.
  Les tests de présentation existants ne constituent pas une validation visuelle.

L'inspection de cette préparation est statique. La revue des écrans dans
l'application en cours reste une activité du premier lot.

## Principes de réalisation

1. **Conserver macOS 15+.** Adopter Liquid Glass sur macOS 26 et versions suivantes ;
   garder les composants et matériaux natifs disponibles sur macOS 15.
   Distinguer disponibilité du SDK de compilation et disponibilité à l'exécution.
   Les usages explicites d'API récentes demandent une garde de disponibilité.
2. **Laisser le système dessiner ses contrôles.** SwiftUI/AppKit, couleurs
   sémantiques, typographie système, SF Symbols, fenêtres, feuilles et alertes
   natives. Les détails Apple vérifiés sont dans [APPLE-NOTES.md](APPLE-NOTES.md).
3. **Réserver le verre à la navigation et aux commandes.** Contenu, formulaires,
   listes, messages d'agent et diagnostics gardent des fonds lisibles. Aucun effet
   CSS, WebView ou imitation personnalisée du matériau Apple.
4. **Une hiérarchie commune.** Projet et dépôt dans l'en-tête ; navigation du projet
   au même endroit ; une action principale par contexte ; détails techniques
   repliés ; états exprimés par du texte et une icône.
5. **Petite couche visuelle partagée.** Réutiliser d'abord les vues existantes.
   Extraire seulement les répétitions réelles : ligne d'état, section et disposition
   des actions, si plusieurs écrans en ont besoin. Aucun moteur de thèmes,
   routeur générique ou dépendance UI supplémentaire.
6. **Des écrans complets à chaque lot.** Chaque lot remplace ses vues et reste
   démontrable. Conserver les modèles et identifiants d'accessibilité existants
   quand leur rôle demeure identique ; supprimer les variantes devenues inutiles.

## Comportements à préserver

- Import confirmé → brouillon local ; Annuler ne crée rien ; dépôt déjà connu →
  ouvrir ce projet. Le choix du dossier reste un vrai sélecteur macOS.
- Workflow → Paramétrage → Vérification restent accessibles directement.
  Zéro, un ou deux modules sont valides ; le canvas est une projection en lecture
  seule des événements, jamais un éditeur de routage.
- Un candidat unique de compte ou de CLI évite un choix inutile ; plusieurs
  candidats restent un choix explicite. Les ressources demeurent liées au projet.
- Paramétrage limité au compte GitHub, au label et à la CLI. Retirer un module
  efface ses valeurs. Aucun réglage de branche, commandes ou stratégie interne.
- Enregistrer conserve le brouillon. Vérifier demande un brouillon enregistré et
  ne teste que les dépendances externes sélectionnées. Aucun agent n'est lancé.
- Une modification du workflow, du compte ou de la CLI invalide la vérification ;
  une modification du label ne l'invalide pas. Application/activation explicite.
- La configuration active continue de fonctionner jusqu'à l'application réussie
  du brouillon. Le projet sélectionné garde son identité après l'action.
- Pause empêche de nouveaux départs ; l'exécution en cours reste suivie.
  Annuler une exécution est une action distincte.
- Les états, causes de blocage, étapes et liens de PR viennent des données réelles.
  Ne pas déduire l'éligibilité dans Swift ni créer une progression fictive.
- Suppression confirmée : configuration locale et historique supprimés après
  succès ; fichiers du dépôt conservés ; travail non terminal bloquant la suppression.
- Diagnostics, historique, reprise des erreurs et état du moteur restent accessibles.

Ces règles remplacent les raccourcis interactifs de la maquette, notamment ses
boutons simulés et son message optimiste « Le travail avance » : ce titre ne doit
apparaître que lorsqu'il décrit effectivement l'état reçu.

## Séquence de livraison

Six lots assez larges pour livrer un parcours cohérent. Les identifiants ci-dessous
sont locaux au plan, pas des numéros d'issues GitHub.

| Lot | Résultat démontrable | Dépendances |
| --- | --- | --- |
| UI-01 | Fenêtre native, navigation et premier lancement | Aucune |
| UI-02 | Import et configuration complets | UI-01 |
| UI-03 | Supervision claire d'un projet | UI-02 |
| UI-04 | Suivi d'une issue jusqu'à la Pull Request | UI-03 |
| UI-05 | Bibliothèque, diagnostics et erreurs homogènes | UI-04 |
| UI-06 | Recette native et livraison intégrée | UI-01 à UI-05 |

### UI-01 — Fenêtre, navigation et écran de référence

**Travail**

- Relever les écrans actuels dans l'application en cours, leur taille, navigation,
  densité et actions ; conserver des captures avant modification.
- Fixer les règles visuelles courtes dans `docs/product/UX.md` : en-têtes,
  espacement, largeur de lecture, place des commandes, états et usage du verre.
- Adapter la sidebar, la barre d'outils, le sélecteur de parcours et le premier
  lancement. Privilégier les contrôles standard ; supprimer les fonds/overlays qui
  empêchent leur rendu natif quand ils ne servent aucune information.
- Garder les boutons de fenêtre fournis par macOS. L'apparence suit les réglages
  système ; le sélecteur clair/sombre de la maquette est un outil de présentation.
- Vérifier le premier écran sur macOS 26+ et le repli sur macOS 15 avant de
  reproduire le traitement sur les autres vues.

**Acceptation** : navigation utilisable au clavier, projet sélectionné identifiable,
un seul en-tête principal, aucune seconde sidebar vide, aucun contrôle recouvert
par le verre, écran sans projet avec action Ajouter un projet.

**Point de contrôle** : une capture native de cet écran fixe la direction visuelle
de référence avant les lots suivants.

### UI-02 — Import et configuration

**Travail**

- Harmoniser inspection du dépôt, résumé modifiable, dépôt déjà connu et erreurs
  d'accès dans la feuille d'import existante.
- Appliquer la nouvelle hiérarchie aux trois écrans, pour brouillon et projet actif.
  Utiliser un contrôle natif pour les étapes ; éviter deux navigations visuellement
  concurrentes entre parcours du projet et étapes de configuration.
- Sélection des modules claire ; canvas compréhensible avec zéro, un ou deux modules.
- Formulaire avec libellés permanents et disponibilité des ressources ; conserver
  l'aller-retour vers Comptes et connexions sans perdre le brouillon.
- Vérification par dépendance, erreur localisée et explication de la prochaine
  action ; pas de bouton Corriger ni d'ajout de contrôles métier.
- Placer Enregistrer et Supprimer de façon stable ; rendre visible pourquoi
  Vérifier ou Créer/Appliquer est indisponible. Préserver la confirmation native.

**Acceptation** : effectuer réellement import → configuration → enregistrement →
vérification → activation. Rejouer une modification d'un projet actif sans altérer
sa configuration opérationnelle avant application. Couvrir workflow vide, compte
absent, plusieurs comptes, CLI indisponible, vérification périmée et suppression
bloquée par du travail en cours.

### UI-03 — Supervision

**Travail**

- Hiérarchiser état du projet, travail courant, workflow et issues suivies.
- Réutiliser les raisons d'admission/blocage du moteur, les filtres et les liens
  utiles ; afficher les dépendances ouvertes et le label de prise en charge.
- Positionner Pause/Reprendre et l'accès au suivi au même endroit à chaque état.
- Conserver le dernier résultat avec son âge lorsqu'une actualisation échoue ;
  distinguer surveillance active, reconnexion, erreur et pause.

**Acceptation** : un utilisateur repère sans ouvrir les diagnostics ce qui avance,
ce qui attend, pourquoi une issue est bloquée et comment ouvrir son suivi. Aucune
phrase de succès pour un projet vide, en pause, déconnecté ou dégradé. Pause ne
prétend pas arrêter l'agent en cours.

### UI-04 — Suivi d'une exécution

**Travail**

- Mettre en avant issue, étape réelle, durée, fraîcheur et dernier message d'agent.
- Réutiliser la disposition adaptative existante : progression et contexte côte
  à côte quand la place suffit, empilés dans une petite fenêtre.
- Présenter succès, échec, annulation, reprise disponible et données anciennes.
  Respecter le contrat Développeur : agent → commit → push, puis demande de PR.
- Afficher la PR seulement lorsque les données la confirment ; ouvrir/copier son
  lien et conserver la relecture/fusion manuelle.
- Garder messages précédents, fichiers, exécutions liées et détails techniques
  accessibles progressivement ; conserver le retour vers la vue d'origine.

**Acceptation** : suivre une issue de Superviser à la PR, inspecter un échec et
revenir à l'historique. Changer de projet ne montre jamais l'exécution précédente.
Un flux silencieux ou coupé ne produit ni faux progrès ni écran vide trompeur.

### UI-05 — Bibliothèque et surfaces secondaires

**Travail**

- Harmoniser Comptes et connexions : découverte, ajout des références prises en
  charge, validation, erreurs et absence de compte, sans exposer de secret.
- Harmoniser le catalogue des modules et ses états de chargement/indisponibilité.
- Traiter schéma d'événements, historique et livraisons en échec avec la même
  typographie, navigation et hiérarchie ; préserver leurs actions existantes.
- Traiter démarrage du moteur, erreur de démarrage et récupération, ainsi que
  les feuilles, confirmations et messages globaux. Inventorier les surfaces
  encore accessibles pour éviter un écran ancien oublié.

**Acceptation** : toutes les destinations atteignables depuis la fenêtre principale
suivent la même grammaire visuelle. Une erreur moteur expose une action disponible
et son résultat. Les fonctions de bibliothèque et de diagnostic restent utilisables.

### UI-06 — Recette native et intégration

**Travail**

- Rejouer les parcours complets dans le bundle réellement construit, avec les
  dépendances de production, puis enregistrer les résultats de chaque scénario.
- Corriger les problèmes de contraste, taille, focus, défilement, contenu long,
  doubles actions et messages contradictoires ; supprimer les anciennes vues
  remplacées et les styles devenus inutiles.
- Exécuter les contrôles du dépôt, la revue standards/spec et actualiser les
  preuves. Rafraîchir Graft après les modifications importantes du code.
- Mettre à jour les documents source de vérité et l'état des lots ; livrer des
  changements revus, intégrés et démontrables.

**Acceptation** : aucune interface prévue au périmètre n'est laissée à l'ancien
traitement ; tous les scénarios ci-dessous ont une preuve ou une limite explicite.
Ne pas confondre tests automatisés, captures natives et exécution réelle GitHub/agent.

**État au 24 septembre 2026** : `rtk pnpm verify` passe, y compris les suites
TypeScript (61 suites unitaires, 52 suites d'intégration), les 208 tests Swift et
l'assemblage Release du bundle de production. Les revues standards et spécification
ont été effectuées ; voir [la recette native](evidence/NATIVE-UI.md) pour les
limites de validation visuelle. UI-06 reste ouverte jusqu'à une recette dans une
fenêtre macOS effectivement présentée.

## Carte de travail

Chemins vérifiés lors de la préparation ; relire leurs dépendances avec Graft
avant toute modification. Ce tableau est un point d'entrée, pas une obligation
de créer ou de découper de nouveaux fichiers.

| Lot | Vues principales existantes | Modèles et tests à réutiliser |
| --- | --- | --- |
| UI-01 | `RootView`, `ContentView`, `ProjectDetailView`, `FirstLaunchView` dans `ProjectOnboardingView` | `ProjectSelectionReconciliationPolicy`, présentation d'onboarding |
| UI-02 | `ProjectImportSheet`, `ProjectOnboardingView`, `ProjectWorkflowView`, `WorkflowCanvasView` | `ProjectConfigurationModel`, tests Import, Configuration, OnboardingPresentation, Preflight, Activation et WorkflowCanvasPresentation |
| UI-03 | `ProjectOverviewView` | `ProjectOverviewModel`, `ProjectOverviewPresentation`, `ProjectOverviewTests` |
| UI-04 | `ProjectExecutionDetailView`, `ProjectTimelineView` | modèles et tests ExecutionDetail, Timeline et TimelineLive ; fixtures `ExecutionDetailSnapshots.json` |
| UI-05 | `ConnectionsView`, `ModuleCatalogView`, `EngineHealthView`, `ProjectGraphView`, `ProjectDeadLettersView` | tests ConnectionsModel, ModuleCatalog, GraphModel, DeadLettersModel et EngineSupervisor |

Les vues sont dans `apps/macos/JarvisApp/Features/` et son sous-dossier `Projects/` ;
les modèles dans `apps/macos/JarvisCore/`, les tests dans `apps/macos/JarvisAppTests/`.

## Stratégie de validation

**Pendant chaque lot** : réutiliser le seam modèle de présentation/API existant
pour les comportements effectivement touchés. Ajouter seulement un test de
régression pertinent si le comportement change ; les couleurs, marges et matériaux
demandent une observation native. Aucun nouveau framework de snapshots nécessaire.

**Matrice native**

| Axe | Cas obligatoires |
| --- | --- |
| Système | macOS 26+ pour Liquid Glass ; macOS 15 pour la compatibilité annoncée |
| Fenêtre | 1100 × 800 et 1512 × 949 ; redimensionnement continu entre les deux |
| Apparence | Clair, sombre ; couleur d'accent système |
| Lisibilité | Réduire la transparence, augmenter le contraste, réduire les animations |
| Navigation | Clavier, focus visible, ⌘N et ⌘S ; aucune activation par Entrée globale |
| Contenu | Noms longs, messages multilignes, beaucoup d'issues, aucune donnée |
| Asynchronisme | Chargement, erreur, dernière donnée conservée, reconnexion, action en cours |

Les bases d'accessibilité sont incluses dès UI-01. La recette VoiceOver complète
reste une passe distincte, précédemment différée ; ne pas déclarer cette validation
acquise sur la seule base des labels et identifiants AX.

**Parcours de recette**

1. Premier lancement → import annulé, import valide, dépôt déjà connu.
2. Brouillon → zéro/un/deux modules → enregistrement → vérification → activation.
3. Projet actif → modification sauvegardée → vérification → application explicite.
4. Compte absent/CLI indisponible → modification des paramètres → réussite.
5. Issue prête → exécution → commit/push → PR visible ; aucune fusion automatique.
6. Issue bloquée, projet en pause, exécution annulée ou échouée, flux interrompu.
7. Changement de projet, redémarrage, retour au brouillon et à ses valeurs sauvegardées.
8. Suppression annulée, bloquée, puis réussie lorsque le travail est terminal.

**Contrôles du dépôt au moment de l'implémentation** : tests Swift pertinents après
construction du moteur, puis `rtk pnpm verify` avant la livraison intégrée.
`rtk pnpm build:app` utilise déjà le profil moteur de production pour assembler
le bundle. Une suite verte ne remplace pas la recette dans ce bundle.

Conserver les captures et le compte rendu dans un sous-dossier `evidence/` de ce
plan, en indiquant OS, build, dimensions, état réel ou fixture et scénario joué.
Si une version de macOS ou une interaction native est inaccessible, marquer la
ligne non vérifiée ; ne pas déduire son résultat d'un autre environnement.

## Périmètre et risques

- Le travail porte sur le macOS Shell. Aucun nouveau contrat API ou schéma SQLite
  n'est prévu. Une lacune réelle de données doit être décrite et traitée séparément
  avant de produire une information inventée dans l'interface.
- Les ombres, arrondis et espacements de la maquette seront adaptés aux contrôles
  macOS : la fidélité recherchée est la hiérarchie et la clarté, pas le pixel HTML.
- L'adoption native peut être masquée par des fonds ou styles personnalisés existants :
  valider l'écran de référence avant de généraliser les modifications.
- L'accès à un environnement macOS 15 est une dépendance de recette. La disponibilité
  d'un SDK récent seule ne démontre pas cette compatibilité.
- Pas de changement de modèle de configuration, de workflow métier, de cible minimale
  ou de pipeline de packaging dans cette refonte. Une telle décision demanderait
  une proposition explicite et, si durable, un ADR.
- Ce plan n'ajoute pas de dashboard global, d'éditeur de workflow ou de réglage
  d'apparence propre à Jarvis. Ces fonctions ne sont pas nécessaires à la direction validée.

## Sources

- [UX macOS](../../product/UX.md) et [MVP](../../product/MVP_SPEC.md).
- [Architecture macOS](../../architecture/MACOS_APP.md), [contexte macOS](../../../apps/macos/CONTEXT.md).
- [ADR 0013 — SwiftPM](../../adr/0013-swiftpm-package-and-assembly-script.md),
  [ADR 0020 — configuration locale](../../adr/0020-local-project-configuration.md),
  [ADR 0021 — validations du Développeur](../../adr/0021-development-does-not-orchestrate-validation.md).
- [Definition of Done](../DEFINITION_OF_DONE.md).
- [Recherche Apple et compatibilité](APPLE-NOTES.md).
