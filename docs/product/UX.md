# UX macOS

## Parcours canonique

Décision du 13 septembre 2026 : **Dépôt → Workflow → Accès et agent → Vérification**
est l'unique parcours recommandé. Il remplace les anciens assistants à cinq étapes
et le second panneau de navigation. Les réglages de composition restent accessibles
dans **Réglages avancés**, avec un retour explicite au guide du même projet.
Le plan et les preuves de livraison sont suivis dans
[`PROGRESS.md`](../../PROGRESS.md) ; les captures de la maquette d'audit représentent
des données fictives, pas des résultats exécutés.

La sidebar native privilégie **Projets**, avec **Ajouter un projet**, puis la
**Bibliothèque** (Comptes et connexions, Catalogue des modules). Le détail d'un
projet contient un en-tête avec nom, dépôt, état et prochaine action. Les quatre
étapes sont des boutons dans le contenu, sur une rangée quand la largeur le permet
et dans une liste verticale sinon. Le contenu reste aligné à gauche, avec une
largeur de lecture limitée et un défilement vertical. Aucune seconde sidebar vide.

Chaque étape reste accessible, même si le brouillon est incomplet. Une seule action
principale fait avancer l'étape ; les actions de correction sont contextuelles.
La sauvegarde reste visible en bas, avec **Modifications à enregistrer**,
**Enregistrement…**, **Enregistré** ou **Échec — Réessayer**. Sauvegarder ne démarre
aucun travail. Changer d'étape ou ouvrir les réglages avancés conserve le brouillon.
Une réouverture retrouve les valeurs enregistrées et l'étape du projet.

Les champs ont des libellés permanents. Toute action critique possède un nom
d'accessibilité et fonctionne au clavier. Un état combine icône et texte ; aucune
signification ne dépend uniquement de la couleur. Les couleurs système suivent
l'apparence claire ou sombre. Les identifiants, contrats, chemins internes et
documents JSON sont repliés dans **Détails techniques**.

## Dépôt

Le premier lancement explique le résultat : développer une issue prête, vérifier
le travail puis proposer une Pull Request. **Ajouter un projet** ouvre le sélecteur
de dossier macOS. L'inspection est en lecture seule : Git, remote, branche de base,
manifestes, gestionnaire de paquets, commandes et instructions du dépôt.

Le résumé propose le nom modifiable, le dépôt GitHub et la branche de base. Annuler
ne crée aucun projet. Un dossier non Git ou inaccessible conserve son erreur et
propose de choisir un autre dossier. Un dépôt déjà connu propose **Ouvrir ce projet**.
Après confirmation, le nouveau brouillon est sélectionné immédiatement. L'accès au
dossier reste local à ce Mac et peut être réautorisé depuis cette étape.

## Workflow

La carte **Développer une issue GitHub** applique la proposition existante de
l'Engine. Elle n'accorde aucune ressource locale. Le schéma explicatif présente :

```text
Issue prête → Développement → Vérifications → Pull Request
```

Chaque carte révèle son explication et les réglages usuels. À petite largeur,
l'ordre devient vertical. Le schéma projette la composition canonique et les
événements déclarés par l'Engine ; il ne stocke pas un second graphe et Swift ne
recalcule aucun routage. Une composition personnalisée conserve ses valeurs.
Remplacer une composition par le modèle demande une confirmation qui nomme les
valeurs remplacées : modules, règles et exigences de ressources ; nom et commandes
du projet sont conservés. Le modèle déjà présent ne devient pas un choix à refaire.

Le parcours recommandé utilise une issue ouverte portant **ready-for-agent**, sans
bloqueur GitHub natif ouvert. GitHub produit `scm.work-item.ready`, Automation Rules
produit `development.implementation.requested`, puis Development prépare le
worktree, exécute l'agent et les validations confirmées, commit et pousse. GitHub
crée la PR après `scm.change-request.creation-requested`. **Une issue à la fois** ;
**relecture et merge humains**. Les projets historiques conservent `agent:ready`
et leur règle historique tant qu'un remplacement explicite n'est pas demandé.

**Préparer et vérifier le projet** présente les commandes détectées comme des
propositions non encore exécutées. L'utilisateur confirme la préparation, y compris
l'absence de préparation, puis choisit explicitement les validations. Pour Jarvis,
proposer l'installation avec lockfile gelé et `pnpm verify` une fois, sans sélectionner
aussi les commandes qu'il contient. Modifier une commande révoque sa confirmation.
Un brouillon incomplet reste enregistrable. **Workflow configuré** décrit uniquement
la configuration ; ce libellé ne prouve jamais la réussite des commandes.

## Accès et agent

Deux cartes : **Compte GitHub** et **Agent de développement**. Un candidat peut être
préselectionné visuellement, mais seul un choix explicite autorise ce projet à
l'utiliser. Une ressource globale n'est jamais un accord implicite aux projets.

Après le choix du compte, afficher **Utilisé par ce projet**, le résultat du contrôle
d'accès au dépôt, sa date et **Modifier**. Plusieurs comptes restent distinguables.
Aucun compte, connexion expirée ou accès refusé conserve une action de réparation.

Pour l'agent, distinguer : choisir d'abord un workflow, Codex absent, connexion
requise, version incompatible, outil manquant, vérification en cours, prêt et erreur
du moteur. Un Codex valide sans workflow n'est pas une version incompatible.
Présenter le modèle effectivement choisi ou **Modèle par défaut de Codex** lorsque
le runner utilise son défaut. Ne pas déduire un modèle d'une configuration globale
ignorée par le runner. Les délais et permissions détaillés restent dans les réglages
avancés. Aucun secret ni valeur d'environnement n'entre dans la configuration portable.

La vérification du runtime et des outils ne démarre pas Development et ne garantit
pas le succès des tests. Elle utilise les accès effectivement accordés au projet.
Une édition ou réouverture demande un contrôle courant ; un accord conservé ne
constitue pas à lui seul une preuve de disponibilité actuelle.

## Vérification

**Vérifier la configuration** résume accès, commandes confirmées, déclencheur et
sortie attendue. Les contrôles proviennent du preflight Engine. Un échec présente
son impact et **Corriger**, qui ouvre la bonne étape. Le fingerprint, les références
de contrats et les routes restent dans les détails techniques.

**Configuration prête** ne signifie ni tests réussis ni issue disponible. Une liste
vide d'issues est normale ; une erreur GitHub ou des dépendances inconnues bloque
l'éligibilité et ne ressemble pas à une liste vide. Toute modification invalide le
rapport ; une réponse périmée ou d'un autre projet ne devient jamais courante.

La carte **Première exécution** distingue **Tester avec cette issue** et
**Surveiller les issues prêtes**. Le choix mono-issue ajoute le filtre exact à la
règle canonique et conserve les autres valeurs ; sa portée reste visible après
vérification. Le bouton final reprend l'intention et le numéro de l'issue.
Élargir à toutes les issues retire uniquement le filtre posé par l'essai, exige
un nouveau rapport puis une activation explicite. Une issue déjà admise ne redémarre
pas. Sans rapport courant, fingerprint exact et ressources requises disponibles,
aucune activation n'est permise, y compris depuis les réglages avancés.

## Inventaire des états

| État observé | Présentation | Action utile |
| --- | --- | --- |
| Aucun projet | Résultat attendu, aucun travail lancé | Ajouter un projet |
| Brouillon incomplet | Valeurs conservées, étapes à compléter | Enregistrer ou compléter |
| Configuration prête | Contrôles de configuration courants, tests non encore exécutés | Choisir la portée et démarrer |
| Vérification en cours | Progression nommée, activation indisponible | Attendre le résultat |
| Exécution en cours | Issue, étape réelle, durée et dernière mise à jour | Ouvrir, mettre en pause les départs ou annuler l'exécution |
| Échec | Cause, tentative et contrôle concernés avant les détails | Corriger ou reprendre selon le remède Engine |
| Déconnecté / données anciennes | Dernier résultat conservé, âge et état de connexion | Réessayer |
| Rapport périmé | Ancien rapport explicitement marqué | Vérifier à nouveau |
| Projet en pause | Aucun nouveau départ ; l'actif reste suivi | Reprendre après vérification de portée |

Le rendu se vérifie à 1100×800 et 1512×949, en clair et sombre. Les preuves
Harness, fixtures de présentation, captures natives et session réelle restent
identifiées séparément. Un test de libellés ou une image rendue hors interaction
ne prouve pas le parcours utilisateur complet.

## Réglages avancés de composition

Les formulaires existants de modules, règles, ressources et configuration structurée
restent le chemin d'édition des compositions personnalisées. Leur navigation interne
ne constitue pas un autre assistant de premier usage. Les ressources éligibles,
capabilities, compatibilités et destinations viennent de l'Engine. Les valeurs
inconnues sont conservées et réparables ; le shell n'invente ni ressource ni contrat.
Le choix d'une ressource écrit les Local Bindings, jamais la Portable Configuration.
La sauvegarde conserve ces deux documents canoniques, sans lignes de présentation.

### Automation Rules

Une instance Automation Rules présente chaque Rule comme une phrase répétable :
`When <Fact> matches <bounded match>, emit <Request> to <resolved consumer>`. Le Rule
Set canonique reste stocké dans Module Configuration; aucune connexion ou sélection
propre à l'UI n'est persistée.

Les sélecteurs sont recherchables et montrent le libellé humain, le kind, la version,
les producers/consumers compatibles et l'explication de routage renvoyée par l'Engine.
Le chemin normal ne propose que les Facts consommables et Requests productibles par
l'instance. `Advanced custom value` permet de préserver une valeur inconnue pour la
réparer, la signale explicitement et bloque l'état Ready-to-validate jusqu'à ce que le
contrat du Module Package la valide. Modifier ou supprimer une Rule ne remplace jamais
les autres Rules ni les autres champs du Draft.

### Module Configuration structurée

Chaque Module Configuration embarquée est éditée récursivement depuis son JSON Schema :
contrôles scalaires, enums, objets, collections et valeurs répétables. Le contrôle montre
le `title`, la `description`, les exemples, l'état requis ou optionnel, le défaut et les
bornes appartenant au schema. Le JSON brut reste sous `Advanced` pour la réparation et
n'est jamais le chemin principal.

Changer de Module Package conserve en mémoire les entrées valides ou invalides du package
précédent, indique comment les réparer ou les retrouver, et restaure ces valeurs si
l'utilisateur revient au package. Le wizard ne déduit aucune sémantique du nom d'une
propriété et ne crée ni nom de Slot ni capability factice : le nom reste saisi, tandis que
la capability est offerte depuis le Module Catalog ou explicitement saisie sous `Advanced`.
La sauvegarde sérialise uniquement la Module Configuration canonique, sans état de contrôle
propre au shell.

Le contrôle de binding d'une Module Instance propose de même les noms déclarés par
`ModulePackage.requires[].binding` du Module Package sélectionné (ticket 48) — jamais une
liste inventée par le shell — avec un nom saisi explicitement sous `Advanced`.

## Overview projet

Après l'activation, l'utilisateur arrive sur une Overview opérationnelle du Project
sélectionné. Elle affiche :

- le nom du Project et son statut `Draft`, `Ready`, `Running`, `Paused` ou `Degraded` ;
- l'action cohérente avec ce statut (`Activate`, `Pause`, `Resume` ou `Refresh`) ;
- le parcours `GitHub → Rules → Development → Pull Request` et la prochaine étape attendue ;
- les issues GitHub pertinentes, avec numéro, titre, statut (`Eligible`, `En attente`,
  `Déjà en cours`, `Bloquée par des dépendances`, `Non éligible` ou `Impossible de
  vérifier`) et explication lisible ;
- le nombre et les liens des dépendances ouvertes signalées par GitHub via
  `blocked_by`. Aucun label de blocage local n'est interprété comme une dépendance ;
- le dernier polling, son état (`live`, `reconnecting`, `failed`, `paused`) et une
  action de nouvelle tentative. Une erreur conserve le dernier snapshot d'issues ;
- l'aide indiquant le label de readiness configuré (`ready-for-agent` dans le nouveau
  template, `agent:ready` conservé pour les Projects existants) ;
- les exécutions actives et l'action `Pause`, qui bloque les nouveaux claims tout en
  laissant l'exécution active sous surveillance. `Resume` réactive polling et claims.

Les cartes utilisent les contrôles natifs macOS, une icône accompagnée d'un texte pour
chaque état, des libellés accessibles et une représentation textuelle complète. Le
contraste clair/sombre, le clavier et VoiceOver ne dépendent donc pas de la couleur ni
du tronquage visuel.

Cette surface reste limitée pour le statut global, la dernière activité et les dead letters, qui relèvent encore de #6. En revanche, #18 livre la visibilité runtime de Project Detail dans les onglets Graph et Timeline, avec l'annulation d'une Execution depuis la Timeline. #52 ne l'invente pas partiellement ; la seconde surface qu'il livre est décrite dans « Graphe émergent » → « Sélection et deuxième surface ».

## Suppression d'un projet

Project Detail expose l'action destructive `Delete Project…`. Elle ouvre une confirmation native qui nomme le Project et explique que l'état Jarvis local, les Local Bindings et le Repository Grant seront retirés, tandis que tous les fichiers du repository — dont `.jarvis/project.yaml` — resteront intacts.

`Cancel` ne déclenche aucune opération. Après confirmation, la sidebar et sa sélection ne sont effacées qu'une fois la suppression moteur réussie. Un échec API conserve le Project et son Repository Grant ; un échec de nettoyage du grant après suppression moteur est signalé comme résultat partiel. Un Project actif doit d'abord être pausé.

## Graphe émergent — diagnostic avancé

Cette section décrit l’inspection technique des compositions personnalisées.
Elle reste distincte du schéma métier à quatre cartes du guide recommandé.

Le graphe est dérivé des manifests et instances actives. Il n'est pas un éditeur de workflow impératif. La vue runtime livrée par #18 est l'onglet **Graph** de Project Detail : après activation, il lit `GET /v1/projects/{projectId}/graph` et affiche les Module Instances et contrats effectivement actifs. L'onglet **Timeline** expose les Executions et leur action d'annulation par la même Local API.

```text
[GitHub]
    └─ scm.work-item.ready
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

Les trois prototypes ont été comparés depuis le build empaqueté (`pnpm build:app`, captures `screencapture` sur les fixtures Orphaned et Ambiguous), puis supprimés avec leur point d'entrée temporaire une fois la comparaison faite ; aucune `View` prototype ne devient une surface de production.

### Sélection et deuxième surface

Pour ce diagnostic avancé, #52 termine l’outline retenue par #50. Cette décision concerne le graphe détaillé des contrats ; elle n’interdit pas les quatre cartes explicatives du guide métier. Sélectionner une ligne — Module Instance, contrat produit, contrat consommé, capability requise ou entrée de rail — révèle son détail : identifiants stables, version de contrat, statut de routage et findings applicables. Ce détail est une projection pure de `ProjectCompositionGraph`, indexée par l'id déjà qualifié par Module Instance, rôle et index ; il ne recalcule ni consumer, ni compatibilité, ni routage, et un id inconnu ou périmé ne révèle rien plutôt que de planter. La sélection est un `Button` natif : atteignable au clavier, annoncée par VoiceOver, distinguée par un glyphe de divulgation et par le mot « Selected » dans son libellé d'accessibilité — jamais par la seule couleur ni par le survol.

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
agent, validations, commit et push, création de la Pull Request. Les étapes suivent
les résultats et tentatives réellement enregistrés par l’Engine.

Chaque étape distingue **Pas encore commencé**, **En cours**, **Réussi**, **Échoué**,
**Réparation en cours** et **Annulé**. **Information indisponible** signifie que les
données ne permettent réellement pas de conclure. Un checkpoint de démarrage ne
prouve pas un succès. Pendant une réparation, le contrôle échoué reste visible ;
une tentative réussie remplace l’alerte active et conserve l’historique. L’agent
possède ses propres dates de fin, distinctes de celles des validations suivantes.

La fiche distingue `Live`, `Reconnecting…` et `Snapshot précédent` sans effacer le dernier
snapshot. Elle montre les checks avec leur nom, durée et résultat, les extraits agentiques
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
