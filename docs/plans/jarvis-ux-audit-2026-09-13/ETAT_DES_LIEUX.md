# Audit réel de Jarvis — 13 septembre 2026

## Verdict

Jarvis sait détecter une issue GitHub réelle, produire la demande de développement, préparer un worktree et lancer Codex. Son expérience de configuration reste celle d'un outil de développeur. Le parcours guidé masque les réglages nécessaires derrière Advanced, ses étapes ne reflètent pas la progression réelle, et certains états de suivi peuvent suggérer un succès alors qu'un contrôle a échoué.

La priorité est la confiance dans l'état affiché, puis un parcours graphique complet qui ne demande aucune connaissance des modules, événements, slots ou bindings. Il faut réutiliser les capacités existantes, pas reconstruire le moteur.

## Méthode et limites

- Checkout audité : `64eb2945b04755590ac7534ad0c7d939084953da`, dernier commit « test(workflow): prove first run (#201) ».
- Application réellement ouverte : `dist/Jarvis.app`. Son manifeste annonce le même commit, Engine 0.1.0, API v1, schéma 0032 et Node 24.16.0.
- Une fenêtre native a été observée et pilotée avec l'accessibilité macOS et des clics. Captures réelles dans `.scratch/ux-audit-2026-09-13/evidence/`.
- Projet local existant `jarvis` initialement Draft, avec dépôt et commandes détectés, aucun module et aucun slot. Ce brouillon a servi au test. Le sélecteur de dossier et la prévisualisation d'import ont également été exercés, puis annulés pour ne pas créer un doublon.
- Configuration effectuée dans l'interface. SQLite a été consulté en lecture seule pour corroborer les faits ; aucune configuration injectée dans la base et aucun faux événement émis pour faire réussir le scénario.
- Vrai compte GitHub Gasppacho, vrai dépôt Gasppacho/jarvis et vrai Codex CLI 0.154.0. Une issue de test créée avec l'autorisation de l'utilisateur : [#204](https://github.com/Gasppacho/jarvis/issues/204).
- Maquette précédente ouverte dans un navigateur : `docs/plans/jarvis-product-readiness/maquette.html`, écrans Configurer, Superviser et Suivre. Il s'agit de données fictives, pas de l'application. Seule erreur console observée : favicon absent.
- Pas de modification du code de l'application pendant l'audit. Les changements locaux préexistants à `.gitignore`, `AGENTS.md`, `.claude/`, `.mcp.json`, `opencode.json` et aux missions ont été préservés.
- Ceci n'est pas une certification de sécurité, un test de tous les modules, une preuve VoiceOver complète, ni une installation sur compte vierge. Les limites ne sont pas transformées en succès.

## Parcours réellement réalisé

| Étape | Observation | Preuve |
| --- | --- | --- |
| Ouvrir Jarvis | Fenêtre native exploitable, projet Draft visible | Manifeste et capture 01 |
| Examiner l'import | Git, remote SSH Gasppacho/jarvis, branche main et pnpm détectés ; nom proposé, commandes sous Advanced | Capture 21 |
| Configurer Workflow | L'étape affiche une phrase et un seul bouton Advanced ; aucun choix de workflow | Capture 02 ; `ProjectOnboardingView.swift:89` |
| Trouver le modèle | Advanced ouvre Overview ; il faut ensuite choisir Composition | Captures 03–04 |
| Choisir GitHub Development | Trois modules, trois slots, label ready-for-agent, concurrence 1 et règle scm.work-item.ready créés | Configuration durable inspectée après sauvegarde |
| Confirmer les commandes | Choisir préparation « Run the install command above », sélectionner verify, descendre tout en bas et Save Draft locally | Captures 05–07 |
| Revenir au guide | Passage par Connections global puis retour au projet pour récupérer l'assistant | Capture 09 |
| Autoriser GitHub | Gasppacho choisi explicitement pour ce projet | Capture 10 |
| Autoriser Codex | Le candidat passe de « Version incompatible » avant le template à sélectionnable après ; contrôle final « Prêt » | Captures 01, 09 et 11 |
| Vérifier | Préflight vert ; compte, label, dépôt, runtime et routage contrôlés | Capture 13 |
| Limiter l'essai | Issue #204 éligible ; clic « Essayer avec cette issue uniquement », nouveau préflight, activation explicite | Captures 14–16 |
| Exécuter | GitHub publie scm.work-item.ready, Rules publie development.implementation.requested ; préparation et Codex réels | Captures 17–20 et checkpoints SQLite |
| Observer les validations | Des contrôles réels échouent ; la frise affiche malgré cela « Checks — Confirmed » en vert | Captures 19–20 ; checkpoint validation.failed |

Le parcours a nécessité un passage dans la composition technique et plusieurs allers-retours. Une durée novice n'est pas calculable à partir de cette session : inspection du code, captures et instrumentation ont interrompu les interactions.

## Constats classés

### F01 — P0 : la frise confond preuve d'exécution et succès

Une entrée `validation.failed` a été enregistrée à 11:24:40, tandis que la frise montrait les Checks confirmés en vert. La section Checks plus bas indiquait même « Information indisponible ». La présence d'une preuve et le résultat du contrôle sont deux choses distinctes.

Le code `apps/engine/src/projects/execution-detail.ts:268-325` attribue `proved` dès qu'une evidence existe, sauf si la failure globale cible cette étape. Le bloc Checks à `:377-389` s'appuie sur la présence du contrôle et ses dates. La représentation doit porter le résultat réel, y compris pendant une réparation et pour plusieurs validations successives. Un vert ne doit jamais signifier seulement « une tentative est enregistrée ».

### F02 — P0 : les contrôles du workflow échouent dans les environnements réels

Deux frontières distinctes ont été observées :

1. Dans le Codex enfant, son propre `rtk pnpm verify` échoue sur `listen EPERM: operation not permitted 127.0.0.1`. Son premier compte rendu mentionne 13 tests unitaires, puis 12 lors d'une nouvelle tentative. Le runtime lance Codex en `workspace-write` et ignore sa configuration utilisateur (`packages/agent-runtime/src/codex-runtime.ts:28-38`). Ce n'est pas une preuve que les tests sont mauvais : leurs besoins et le sandbox sont incompatibles dans ce chemin.
2. Dans la validation ensuite lancée par Development, le gate passe formatage et tests unitaires puis atteint l'intégration. Le premier échec enregistré concerne `execution-detail.integration.test.ts:70` (`<path>` dans la réponse publique) et `project-runtime-bindings.integration.test.ts:111` (`access-denied` reçu au lieu de `ready`). La cause exacte de ces deux échecs reste à isoler dans le même environnement avant correction.

La copie du premier journal est `evidence/runtime-validation-failed.txt`. Distinguer le retour du Codex enfant, les vérifications de Development et le gate du checkout principal. Ne pas supprimer les assertions ni désactiver le sandbox pour obtenir artificiellement un vert.

### F03 — P1 : le parcours guidé ne configure pas le workflow

`ProjectOnboardingView.swift:89-109` ne propose que Advanced pour Workflow. Le choix GitHub Development, le label et les commandes sont dans la page technique. L'utilisateur débutant ne peut pas accomplir l'objectif annoncé dans le guide. Advanced doit redevenir optionnel ; les contrôles déjà disponibles doivent être présentés au bon endroit.

### F04 — P1 : étapes et diagnostics donnent des indications contradictoires

`ProjectOnboardingPresentation.swift:58-73` fixe Repository à Terminé, Workflow à En cours, Connections à À compléter et Review à Prêt à revoir, indépendamment du contenu. Connections reste À compléter même lorsque le runtime est prêt et le préflight vert.

Avant la sélection du template, Codex est annoncé « Version incompatible » alors que le problème est l'absence de consommateur de runtime. `runtime-readiness.ts:44-53` regroupe cette absence avec l'incompatibilité ; `ProjectRuntimePresentation.swift:53-63` la nomme incompatibilité de version. Le même binaire a ensuite passé le contrôle réel.

### F05 — P1 : navigation fragmentée et espace mal utilisé

Le split view imbriqué crée deux sidebars et une large bande vide avant le contenu. Le détail débute loin à droite alors qu'une grande partie de la fenêtre est vide. Advanced mène vers Overview plutôt que vers le réglage demandé. Aucun retour explicite au guide n'est présenté ; la sélection du même projet ne suffit pas toujours et le détour par un autre écran a été nécessaire.

La page Composition cumule configuration, commandes, slots, modules, règles, ressources, review et activation sur un long défilement. La sauvegarde est tout en bas. Le bouton d'import est caché derrière le débordement `»`, même dans la fenêtre large observée. `RootView.swift:96-108,120-177` et `Projects/ProjectDetailView.swift` sont les points d'entrée.

### F06 — P1 : autorisations et état des choix insuffisamment explicites

Après avoir choisi Gasppacho, la carte affiche encore « Disponible », « Prêt à être accordé » et le bouton « Utiliser pour ce projet ». Une ligne technique confirme seulement le binding. Le candidat Codex choisi conserve également son bouton Choisir et une explication de découverte non vérifiée, alors que le contrôle global est Prêt.

Le consentement explicite par projet est une bonne base à conserver. Il manque un résultat immédiatement lisible : compte sélectionné, dépôt effectivement accessible, agent choisi, vérification récente, action Modifier.

### F07 — P1 : la vérification explique des réparations même après succès

Les lignes cochées affichent « Réglez la concurrence du projet à 1 », « Choisissez un remote GitHub accessible » ou « Corrigez les permissions puis relancez le préflight », alors que les contrôles sont verts. Cela pousse à chercher un problème inexistant. Les succès doivent décrire ce qui a été vérifié ; les actions correctives appartiennent aux échecs.

Le terme préflight, les URI github://, les identifiants de règles, Request et consumer sont exposés dans le parcours normal. Le bouton d'essai mono-issue est utile, mais sa sélection recharge le panneau et déplace le contenu ; le périmètre sélectionné doit rester visible au moment de démarrer.

### F08 — P1 : supervision mal hiérarchisée et rafraîchissement peu lisible

Après activation, la première vue annonce Ready, Waiting, GitHub Unavailable et Not connected avant le premier snapshot. Elle ne distingue pas une première lecture en cours d'une connexion absente. Un Refresh manuel a permis d'obtenir Running et Live ; le délai automatique exact n'a pas été mesuré.

Les issues apparaissent dans l'ordre de leur numéro. Six issues sans label ready-for-agent précèdent #204 en cours. Il faut défiler pour accéder à Open execution. L'essai limité à #204 ne ressort pas dans le bandeau général ; d'autres tickets sont affichés comme Waiting. Un utilisateur peut les croire engagés dans son essai.

Le résultat terminal a ajouté un défaut confirmé : après échec, l’Overview redevient Ready et #204 passe à Not eligible (« déjà admise »), sans bouton pour rouvrir son résultat. Le refus de réadmission protège des doublons, mais ne doit pas masquer un échec à traiter. Voir RESULTAT_TEST.md et les captures 22–23.

### F09 — P1 : détail d'exécution trop technique, états intermédiaires peu explicites

UUID de corrélation, URI internes, identifiants d'exécution et numéro de tentative occupent le haut de la fiche. Les explications décrivent des checkpoints plutôt que le travail. Les étapes futures sont « Information indisponible », ce qui ressemble à un manque de données, plutôt qu'à « Pas encore commencé ». Le libellé Agent en cours couvre mal le passage à la validation et aux réparations. Les journaux sont tronqués sans toujours rendre la cause immédiatement exploitable.

### F10 — P1 : vocabulaire, langue et accessibilité à uniformiser

Les écrans mélangent français et anglais dans une même phrase : « Continuer vers Review », « Activate workflow autorise le polling et l'admission », « Checks — Confirmed ». Les champs de commandes remplis n'ont pas toujours de libellé visible permanent. De nombreux boutons ont un nom manquant et une description générique dans l'arbre AX interrogé ; cela doit être vérifié avec VoiceOver et des identifiants stables, pas extrapolé en certification d'inaccessibilité.

Les captures montrent surtout du texte, peu de hiérarchie visuelle et des contenus longs. Le schéma de l'Overview est un début utile ; il manque au moment où l'utilisateur doit comprendre et choisir son workflow.

### F11 — P2 : import amélioré, mais continuité incomplète

La détection du dépôt et la séparation Advanced sont utiles. La prévisualisation observée ne propose pas d'ouvrir le projet déjà existant et ne permet pas de changer son nom. Le bouton « Save as draft project » ne décrit pas la suite du parcours. Aucune création de doublon n'a été tentée : son comportement n'est pas établi par cet audit.

### F12 — P1 : documentation et preuves produit ne sont pas alignées

Le README présente toujours le dépôt comme une baseline prête à coder et dessine `agent:ready → scm.work-item.tag-added`. Le nouveau workflow guidé réellement utilisé surveille `ready-for-agent → scm.work-item.ready`. La compatibilité des anciens projets ne justifie pas de présenter l'ancien chemin comme le chemin recommandé.

`docs/product/UX.md` juxtapose un wizard en cinq étapes, quatre étapes d'onboarding et cinq sections de composition. Plusieurs exigences annoncées ne sont pas accessibles dans le guide actuel. Le rapport #201 distingue correctement fake providers et vraie UI ; sa limitation « aucune fenêtre » est historique et a été levée dans cette session, pas lors de son test initial.

Les issues #188 à #201 n'apparaissaient plus dans les issues ouvertes au début de cet audit. #187, #202 et #203 restent ouvertes. Leur état ne prouve pas que l'expérience utilisateur est terminée.

## Ce qu'il faut conserver

- Produit natif local et Engine embarqué correspondant au commit audité.
- Configuration et autorisations par projet, GitHub détecté sans copie de token dans la configuration portable.
- Template canonique existant ; règle événementielle ; aucune logique de routage recalculée dans Swift.
- Contrôle préalable réel, invalidation après édition, sélection d'une seule issue avant activation.
- Worktree isolé, préparation install explicite, validations avant publication, journal et corrélations.
- Arrêt à la PR, relecture et merge humains.

## Tests et force des preuves

| Contrôle exécuté | Résultat | Portée |
| --- | --- | --- |
| `rtk pnpm verify` dans le checkout principal | Échec à lint ; contrats et génération passent | Ne valide pas les étapes suivantes |
| `rtk pnpm lint` après correction du seul JSON créé par l'audit | Échec sur 5 fichiers préexistants : `.claude/helpers/graft-hooks.cjs`, `.claude/helpers/graft-statusline.cjs`, `.claude/settings.json`, `.mcp.json`, `opencode.json` | Ces fichiers ont été préservés |
| `rtk pnpm exec vitest run --project integration apps/engine/test/reference-workflow-first-run.integration.test.ts` | 1/1 réussi, environ 6 s | Vrai Engine avec faux GitHub et FakeRuntime ; ne prouve pas Codex réel |
| Contrôle runtime dans l'application | Prêt | Découverte et profil, pas réussite de toutes les commandes |
| Issue réelle #204 | Préparation et Codex exécutés ; échecs de validation observés | Bilan terminal à lire dans RESULTAT_TEST.md |

## Écart avec la maquette

La maquette précédente donne une meilleure direction : une sidebar orientée projets, quatre étapes courtes, un schéma Issue → Développement → Vérifications → PR, du vocabulaire français, les réglages avancés repliés et une action principale visible. Elle doit servir de référence de hiérarchie et de contenu, pas être transposée mécaniquement en HTML dans l'app.

Elle reste incomplète : données fictives, peu d'erreurs interactives, pas de preuve des accès, pas de sauvegarde réelle ni de validation de toutes les tailles et de VoiceOver. La nouvelle implémentation doit ajouter ces états et conserver les invariants du moteur. Le plan détaillé est dans PLAN.md.
