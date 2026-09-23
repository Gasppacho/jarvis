# UX macOS

## Parcours canonique

Décision du 19 septembre 2026 : l'import d'un dépôt crée immédiatement un Project
en brouillon. **Configurer** contient exactement trois écrans accessibles directement :

1. **Workflow** sélectionne les Modules dans le Catalogue et construit leur canvas ;
2. **Paramétrage** expose les seuls champs du compte GitHub, du label et de la CLI ;
3. **Vérification** teste uniquement les dépendances externes des Modules sélectionnés.

Il n'existe aucun réglage avancé de configuration. Après activation, **Configurer**
réutilise les mêmes trois écrans. Une modification sauvegardée reste un brouillon
tant que l'utilisateur ne l'a pas appliquée ; la configuration active continue de
fonctionner jusque-là.
Le plan et les preuves de livraison sont suivis dans
[`PROGRESS.md`](../../PROGRESS.md) ; les captures de la maquette d'audit représentent
des données fictives, pas des résultats exécutés.

La sidebar native privilégie **Projets**, avec **Ajouter un projet**, puis la
**Bibliothèque** (Comptes et connexions, Catalogue des modules). Le détail d'un
projet contient un en-tête avec nom et dépôt. Le contenu reste aligné à gauche, avec une
largeur de lecture limitée et un défilement vertical. Aucune seconde sidebar vide.

**Enregistrer** et **Supprimer** restent visibles dans le parcours. Enregistrer conserve
le brouillon sans vérifier, activer ni démarrer de travail. **Créer le projet** reste
grisé avant une vérification réussie ; après activation, **Appliquer la configuration**
joue le même rôle. Les trois écrans restent accessibles même si le brouillon est vide.

Le détail opérationnel présente trois parcours : **Configurer**, **Superviser** et
**Suivre**. Configurer ouvre les trois écrans, y compris pour un projet
déjà activé. Superviser affiche le workflow, le travail courant et toutes les
**Issues suivies**, filtrables, avec leur situation et l’explication fournie par
l’Engine. Suivre ouvre le travail sélectionné, sinon le dernier travail connu, ou
l’historique pour en choisir un.
Le menu **Diagnostics** conserve le schéma, les événements et les livraisons en
échec. Changer de projet efface la sélection d’exécution.
Le suivi présente l’avancement à côté du contexte et du
dernier message réel de l’agent ; les colonnes s’empilent dans une petite fenêtre.

Les raccourcis **⌘N** (ajouter un projet) et **⌘S** (enregistrer le brouillon)
complètent les contrôles natifs. L’activation reste une action explicite, sans
raccourci Entrée global. La navigation clavier et VoiceOver font l’objet d’une
preuve native distincte ; les noms AX seuls ne prouvent pas le parcours.

Les champs ont des libellés permanents. Toute action critique possède un nom
d'accessibilité et fonctionne au clavier. Un état combine icône et texte ; aucune
signification ne dépend uniquement de la couleur. Les couleurs système suivent
l'apparence claire ou sombre. Les identifiants, contrats, chemins internes et
documents JSON sont repliés dans **Détails techniques**.

## Import du dépôt

Le premier lancement explique le résultat : développer une issue prête, vérifier
le travail puis proposer une Pull Request. **Ajouter un projet** ouvre le sélecteur
de dossier macOS. L'inspection est en lecture seule : Git, remote, branche de base,
manifestes, gestionnaire de paquets, commandes et instructions du dépôt.

Le résumé propose le nom modifiable et le dépôt détecté. Annuler ne crée aucun projet.
Un dossier inaccessible conserve son erreur et propose d'en choisir un autre. Un dépôt
déjà connu propose **Ouvrir ce projet**. Après confirmation, le brouillon local est
sélectionné immédiatement. Jarvis ne lit ni n'écrit `.jarvis/project.yaml` ; réimporter
un dépôt supprimé commence avec un workflow vide.

Lors de l'adoption de ce modèle, les Projects existants conservent leur accès au dépôt
mais reviennent à un brouillon vide. Leur ancienne composition n'est ni migrée ni restaurée.
Un Project avec une exécution ou une livraison non terminale reste inchangé jusqu'à la
fin de ce travail ; il peut ensuite être supprimé puis réimporté pour repartir vide.

## Workflow

Le Catalogue contient exactement les deux Modules embarqués **GitHub** et
**Développeur**. Chaque card sélectionne ou retire une unique instance. Un workflow
vide, GitHub seul, Développeur seul ou les deux Modules sont tous enregistrables,
vérifiables et activables, même lorsque la composition ne produira aucun travail.

Le canvas read-only se reconstruit à chaque sélection depuis les événements déclarés
par les Modules :

```text
GitHub → observation des issues → Développement
GitHub ← demande de Pull Request ← Développement
```

Swift ne recalcule aucun routage. Les libellés sont métier, sans identifiants de
contrats. Un événement sans destinataire se termine par **Non connecté**, dans un
état neutre et non bloquant. Retirer un Module efface immédiatement son paramétrage ;
le réajouter repart de ses valeurs initiales.

## Paramétrage des Modules

**GitHub** propose uniquement le compte à utiliser et affiche séparément **Dépôt Git
initialisé** et **Dépôt GitHub identifié**. Le compte vient de **Comptes et connexions** ;
si la liste est vide, **Configurer un compte GitHub** ouvre cette bibliothèque puis
revient au brouillon.

**Développeur** propose uniquement le label d'issue et la CLI d'agent. Le label peut
être vide. Toutes les CLI prises en charge sont visibles avec leur disponibilité ;
une CLI absente reste sélectionnable afin que la vérification explique le problème.

Le nom de branche, la concurrence, les commandes, les validations, les worktrees et
la stratégie d'exécution appartiennent au Module Développeur. Ils ne sont ni des
champs du workflow ni des réglages avancés. Un comportement différent demande un
autre Module ou une modification de ce Module.

## Vérification

L'écran contient une ligne par dépendance du workflow sélectionné :

- **GitHub** vérifie que le dépôt local est initialisé, qu'un dépôt GitHub est identifié
  et que le compte choisi peut y accéder ;
- **Développeur** vérifie que la CLI choisie est installée, prise en charge et exécutable.

Aucun Module sélectionné réussit immédiatement. La vérification ne contrôle ni le
label, ni les issues, ni leurs dépendances, ni les commandes, ni les tests, ni la
compatibilité des événements. Elle ne lance aucun agent. Un échec reste sur cet écran ;
l'utilisateur navigue directement vers **Workflow** ou **Paramétrage** pour modifier
une valeur, sans bouton **Corriger**.

Une réussite est persistée pour la combinaison workflow, compte GitHub et CLI. Elle
survit à l'enregistrement et au redémarrage. Modifier l'une de ces trois valeurs
l'invalide et grise le bouton final. Modifier le label ne l'invalide pas.

## Inventaire des états

| État observé | Présentation | Action utile |
| --- | --- | --- |
| Aucun projet | Résultat attendu, aucun travail lancé | Ajouter un projet |
| Brouillon | Valeurs locales conservées | Enregistrer ou configurer |
| Configuration vérifiée | Dépendances externes accessibles | Créer le projet ou appliquer |
| Vérification en cours | Progression nommée, activation indisponible | Attendre le résultat |
| Exécution en cours | Issue, étape réelle, durée et dernière mise à jour | Ouvrir, mettre en pause les départs ou annuler l'exécution |
| Échec de vérification | Dépendance inaccessible et raison lisible | Modifier Workflow ou Paramétrage |
| Déconnecté / données anciennes | Dernier résultat conservé, âge et état de connexion | Réessayer |
| Vérification invalidée | Workflow, compte ou CLI modifié | Vérifier à nouveau |
| Projet en pause | Aucun nouveau départ ; l'actif reste suivi | Reprendre après vérification de portée |

Le rendu se vérifie à 1100×800 et 1512×949, en clair et sombre. Les preuves
Harness, fixtures de présentation, captures natives et session réelle restent
identifiées séparément. Un test de libellés ou une image rendue hors interaction
ne prouve pas le parcours utilisateur complet.

## Overview projet

Après l'activation, l'utilisateur arrive sur une Overview opérationnelle du Project
sélectionné. Elle affiche :

- le nom du Project et son statut `Draft`, `Ready`, `Running`, `Paused` ou `Degraded` ;
- l'action cohérente avec ce statut (`Activate`, `Pause`, `Resume` ou `Refresh`) ;
- le canvas des Modules sélectionnés et de leurs événements connectés ou non ;
- les issues GitHub pertinentes, avec numéro, titre, statut (`Eligible`, `En attente`,
  `Déjà en cours`, `Bloquée par des dépendances`, `Non éligible` ou `Impossible de
  vérifier`) et explication lisible ;
- le nombre et les liens des dépendances ouvertes signalées par GitHub via
  `blocked_by`. Aucun label de blocage local n'est interprété comme une dépendance ;
- le dernier polling, son état (`live`, `reconnecting`, `failed`, `paused`) et une
  action de nouvelle tentative. Une erreur conserve le dernier snapshot d'issues ;
- l'aide indiquant le label de readiness configuré (`ready-to-dev` par défaut) ;
- les exécutions actives et l'action `Pause`, qui bloque les nouveaux claims tout en
  laissant l'exécution active sous surveillance. `Resume` réactive polling et claims.

Les cartes utilisent les contrôles natifs macOS, une icône accompagnée d'un texte pour
chaque état, des libellés accessibles et une représentation textuelle complète. Le
contraste clair/sombre, le clavier et VoiceOver ne dépendent donc pas de la couleur ni
du tronquage visuel.

Cette surface reste limitée pour le statut global, la dernière activité et les dead letters, qui relèvent encore de #6. En revanche, #18 livre la visibilité runtime de Project Detail dans les onglets Graph et Timeline, avec l'annulation d'une Execution depuis la Timeline. #52 ne l'invente pas partiellement ; la seconde surface qu'il livre est décrite dans « Graphe émergent » → « Sélection et deuxième surface ».

## Suppression d'un projet

**Supprimer** ouvre une confirmation native qui nomme le Project. Après confirmation,
Jarvis met automatiquement le Project en pause puis supprime toute sa configuration
locale, son historique project-scoped et son Repository Grant. Aucun fichier du dépôt
n'est modifié. Si une exécution travaille encore, la suppression reste bloquée et
**Superviser** permet de l'arrêter ou d'attendre sa fin.

## Graphe émergent — diagnostic avancé

Cette section décrit la projection technique et l'historique des prototypes.
Le canvas de configuration reste la version métier minimale de cette projection.

Le graphe est dérivé des manifests et instances actives. Il n'est pas un éditeur de workflow impératif. La vue runtime livrée par #18 est l'onglet **Graph** de Project Detail : après activation, il lit `GET /v1/projects/{projectId}/graph` et affiche les Module Instances et contrats effectivement actifs. L'onglet **Timeline** expose les Executions et leur action d'annulation par la même Local API.

```text
[GitHub]
    └─ scm.work-item.observed
           ↓
[Development]
    └─ development.implementation.requested
           ↓
    └─ scm.change-request.creation-requested
           ↓
[GitHub]
    └─ scm.change-request.created
```

États visuels, chacun distingué par une icône et un texte plutôt que par la seule couleur :

- chemin valide (icône de succès, « Resolved → \<consumer\> » pour une Request routée ou « Broadcast → \<consumer\> » pour un Fact diffusé) ;
- request orpheline (icône d'avertissement, « Orphaned — no consumer ») ;
- plusieurs consommateurs illégaux (icône d'ambiguïté, « Ambiguous — \<candidats\> ») ;
- module désactivé (badge « Disabled ») ;
- contrat incompatible ;
- capability ou Slot non résolue (icône d'avertissement, état `bound`/`unresolved`/`unbound` nommé en toutes lettres sur le rail).

### Représentation retenue

Cette décision vient d'une comparaison de trois prototypes SwiftUI structurellement différents, tous alimentés par les mêmes fixtures `jarvis.dev/project-composition-graph/v1` capturées depuis le harness Engine (composition valide, Request orpheline, Request ambiguë) :

- **Flow map** : cartes de Module Instance de gauche à droite, liste des Events avec leur contrat et leur statut de routage, rail de capability/Slot en bande secondaire — la grammaire que #28 propose de battre ;
- **Hierarchical outline** : chaque Module Instance en ligne parente, ses contrats produits et consommés ainsi que ses capabilities requises en lignes filles, le statut de routage porté par la ligne fille ;
- **Routing table** : une ligne par contrat Request nommant son producer, son consumer résolu ou son échec, la version du contrat et le finding applicable.

| Prototype | Structure | Lisibilité du routage | Comportement en densité | Clavier, VoiceOver et coût de l'équivalent texte/liste |
|---|---|---|---|---|
| Flow map | Cartes de Module Instance, liste d'edges séparée, rail de capability en bande | Le statut de routage exige un aller-retour entre la carte et la ligne d'edge correspondante ; aucun trait ne relie visuellement les cartes | Cartes, edges et rail défilent chacun sur un axe différent ; sans connexion dessinée entre les cartes, la mise en page dégénère en trois listes non reliées dès que la composition grossit | Trois zones de défilement d'orientations différentes rendent l'ordre clavier et VoiceOver imprévisible ; structure la plus éloignée de la liste texte que #51 doit de toute façon construire |
| Hierarchical outline | Module Instance en ligne parente, Events produits/consommés et capabilities en lignes filles | Le statut de routage est porté directement par la ligne fille concernée, sans recherche croisée | Liste native qui défile verticalement ; une identité de ligne non unique par Module Instance a provoqué un doublon d'affichage sur la fixture Ambiguous, corrigé en qualifiant chaque ligne par Module Instance, rôle et index | Ordre clavier et VoiceOver strictement descendant, identique à la liste des réglages avancés ; le contenu affiché est déjà la représentation texte/liste |
| Routing table | Une ligne par contrat Request : producer, consumer résolu ou échec, version, finding | Statut de routage directement lisible par ligne, la plus compacte des trois | `Table` native, la plus robuste à la densité, mais les Facts diffusés ne figurent dans aucune ligne : la table ne montre qu'une partie du graphe de composition | Ordre clavier et VoiceOver natif ligne/colonne ; coût texte/liste nul, mais au prix de rendre invisibles les événements diffusés |

Le deuxième prototype est retenu : il montre l'intégralité du graphe de composition — Module Instances, Requests routées, Facts diffusés et capabilities — sans recherche croisée pour lire un statut, avec un ordre clavier/VoiceOver descendant dans les réglages avancés, et son contenu constitue déjà la représentation texte/liste que #51 doit fournir. Le flow map ne dessine aucune connexion réelle entre les cartes une fois construit sur le read model : il dégénère en trois listes non reliées, moins lisibles et plus coûteuses à faire correspondre à la liste texte. Le routing table reste le plus compact pour les seules Requests, mais omet entièrement les Facts diffusés du graphe de composition, ce qui ne convient pas à une prévisualisation qui doit rester complète. Les statuts `resolved`, `broadcast`, `orphaned` et `ambiguous` ainsi que les états `bound`/`unresolved`/`unbound` du rail viennent tels quels de la réponse `POST /v1/projects/{projectId}/composition-graph` ; pour le runtime activé, les nœuds, contrats et statuts viennent de `GET /v1/projects/{projectId}/graph`. Swift ne recalcule ni consumer ni compatibilité.

En mode `fixed-modules`, la même projection est également affichée dans un canvas natif read-only : les coordonnées cycliques appartiennent au shell, tandis que les nœuds, arêtes, contrats et routes restent ceux du `ProjectCompositionGraph`. Les arêtes request et fact ont des tracés distincts ; les demandes orphelines ou ambiguës restent sans cible et sont expliquées dans la liste accessible. Sélectionner un module révèle ses réglages ; sélectionner un lien révèle sa compatibilité de contrat et sa condition de déclenchement, sans affordance d'édition.

Les trois prototypes ont été comparés depuis le build empaqueté (`pnpm build:app`, captures `screencapture` sur les fixtures Orphaned et Ambiguous), puis supprimés avec leur point d'entrée temporaire une fois la comparaison faite ; aucune `View` prototype ne devient une surface de production.

### Sélection et deuxième surface

Pour ce diagnostic avancé, #52 termine l’outline retenue par #50. Cette décision concerne le graphe détaillé des contrats, désormais replié derrière le canvas fixe. Sélectionner une ligne — Module Instance, contrat produit, contrat consommé, capability requise ou entrée de rail — révèle son détail : identifiants stables, version de contrat, statut de routage et findings applicables. Ce détail est une projection pure de `ProjectCompositionGraph`, indexée par l'id déjà qualifié par Module Instance, rôle et index ; il ne recalcule ni consumer, ni compatibilité, ni routage, et un id inconnu ou périmé ne révèle rien plutôt que de planter. La sélection est un `Button` natif : atteignable au clavier, annoncée par VoiceOver, distinguée par un glyphe de divulgation et par le mot « Selected » dans son libellé d'accessibilité — jamais par la seule couleur ni par le survol.

La seconde surface que #28 demandait (Wizard preview et Project Overview) se réduit, tant que #18 et #6 ne livrent pas l'état runtime, à l'état lecture seule de Project Detail : un Project sauvegardé, sans Draft ouvert (`ProjectConfigurationState.isDraftSaved == true`). Cet état affiche la même Composition, construite par le même `ProjectCompositionOutline` à partir du même `ProjectCompositionGraph`, que l'état d'édition du Wizard ; aucune des deux surfaces ne reconstruit de règle métier Engine. La liste retenue par #51 reste disponible et équivalente pour la même composition.

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

Depuis une issue active de l'Overview ou une ligne d'exécution de la Timeline, l'utilisateur
ouvre la fiche corrélée. Elle regroupe les exécutions finies et en cours autour de
l’événement d’entrée : réception de l’issue, éligibilité, préparation du worktree,
agent, commit et push, création de la Pull Request. Les étapes suivent
les résultats et tentatives réellement enregistrés par l’Engine.

Chaque étape distingue **Pas encore commencé**, **En cours**, **Réussi**, **Échoué** et
**Annulé**. **Information indisponible** signifie que les
données ne permettent réellement pas de conclure. Un checkpoint de démarrage ne
prouve pas un succès. Les anciennes exécutions conservent leur historique de
vérifications, sans que Development n'en produise de nouvelles.

La fiche distingue `Live`, `Reconnecting…` et `Snapshot précédent` sans effacer le dernier
snapshot. Pour les anciennes exécutions, elle montre les checks avec leur nom, durée et
résultat. Elle montre les extraits agentiques
bornés avec leur timestamp, puis le diagnostic, l'impact et l'action possible en cas d'échec,
de dépassement de délai ou d'annulation. Une Pull Request créée expose son numéro, titre et
lien; le message rappelle qu'une revue manuelle est requise. Les identifiants techniques,
la corrélation, la causalité, les événements et les détails du workspace sont repliés dans
`Détails techniques`; aucun contrôle de fusion ou d'auto-fusion n'est présent.

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
