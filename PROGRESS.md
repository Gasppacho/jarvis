# Fiabilité et UX Jarvis — progression

Plan autorisé : [L01–L10](docs/plans/jarvis-ux-audit-2026-09-13/PLAN.md).
Worktree : `/Users/quentin/02_Code/jarvis-ux-reliability-20260913`.
Branche : `codex/ux-reliability-20260913` ; base : `64eb2945b04755590ac7534ad0c7d939084953da`.

## État de reprise

L01 implémentée et relue ; commit `989b9b7`. Contrôles ciblés réussis,
y compris une dernière reproduction rouge/verte préservant les checks après
un échec ultérieur du commit (7/7 tests de projection).
L02 implémentée, relue et gate complet réussi au commit `5906e64` :
366 unitaires, 385 intégration et 187 Swift ; app empaquetée en 3 min 53 s.
Les deux échecs Development et le `listen EPERM` ont été reproduits séparément.
L03 implémentée et relue, commit `ceb3759`. L04 implémentée, relue et vérifiée nativement, commit `9289c1f`. L05 implémentée, relue et vérifiée nativement ; L06 implémentée, relue et vérifiée nativement, commit `86821da` ; L07 implémentée et relue, L08–L10 restent à exécuter dans l’ordre. Aucun push, test GitHub ou merge effectué.
Le projet réel et le travail retenu de #204 restent intacts.

La session macOS s'est déverrouillée pendant L04 puis reverrouillée pendant L05.
Après la demande « continue », `IOConsoleLocked = No` est confirmé par `ioreg`.
Les essais natifs reprennent dans la racine isolée.
Les captures natives tentées en L01 sont inutilisables, donc ne prouvent aucun rendu.

## Contrôles et décisions

- Instructions du worktree, du checkout principal et RTK lues ; skills implement,
  tdd, diagnosing-bugs, ponytail et code-review appliqués.
- Seams : Harness Engine avec stockage réel et réponses API, modèles/navigation
  Swift, app native empaquetée, puis vrai run GitHub/Codex.
- `rtk pnpm install --frozen-lockfile` réussi dans ce worktree.
- État initial : seuls le dossier du plan et `graft/` étaient non suivis.
  L'index graft généré reste local, hors commits.
- Captures d’audit 01, 02, 03, 11, 19, 20, 22, 23 et les trois captures
  maquette consultées. Leurs données et états ne sont pas des preuves du nouveau build.

## Tranches

| Tranche | Implémentation / preuve | Commit |
| --- | --- | --- |
| L01 | Implémentée, tests et double relecture ; visuel en attente | `989b9b7` |
| L02 | Implémentée, relue ; gate complet réussi, vrai run encore requis | `cb35979` → `5906e64` |
| L03 | Implémentée, relue ; cadre natif aux deux tailles et apparences en L04 | `ceb3759` |
| L04 | Implémentée, relue ; import, doublon, navigation et reprise natifs vérifiés | `9289c1f` |
| L05 | Implémentée, double relecture ; parcours natif et reprise vérifiés | `6238cc4` |
| L06 | Implémentée, relue ; compte réel, découverte et contrôle Codex natifs | `86821da` |
| L07 | Implémentée, relue ; Swift 24/24, API 11/11, erreur/reprise/liste vide natifs | Ce commit |
| L08 | À faire — supervision | — |
| L09 | À faire — accessibilité et documentation | — |
| L10 | À faire — gate complet, UI et issue réelle → PR | — |

## L01 — états d'exécution et historique

Cause reproduite à l'API : une validation bloquée sur un vrai processus était
présentée `proved` au lieu de `active`. La présence d'un checkpoint suffisait
à prouver l'étape ; une tentative suivante remplaçait le résultat précédent.

Correction : résultats durables par contrôle/tentative, réparation distincte,
annulation sans faux échec de validation, étapes futures non commencées,
dates réelles de fin, conservation des preuves malgré les messages agent,
rafraîchissement du détail visible sans dépendre d'un nouvel événement.
Migration 0033 avec sauvegarde préalable et conservation des anciennes lignes.
Contrat OpenAPI, types Engine/Swift et documentation mis à jour ensemble.

Fichiers d'entrée : `apps/engine/src/projects/execution-detail.ts`,
`apps/engine/src/executions/checkpoints.ts`,
`packages/modules/development/src/index.ts`,
`apps/macos/JarvisApp/Features/Projects/ProjectExecutionDetailView.swift`.

Preuves exécutées :

- Rouge : `rtk pnpm exec vitest run --project integration apps/engine/test/development.integration.test.ts -t 'keeps a running validation'`.
- Unitaires ciblés : 26/26 (projection, checkpoints, admission Development).
- Intégration : 34/34 (`development.integration`, `execution-detail.integration`, `data-root`).
- Après relecture : 6/6 ciblés sur validation, réparation, annulation et migration,
  y compris sauvegarde privée et historique antérieur préservé.
- `rtk pnpm generate`, `rtk pnpm typecheck` et `rtk pnpm contracts:check` réussis.
- `rtk proxy swift test --package-path apps/macos --filter ProjectExecutionDetailTests` : 10/10.
- Réponses réelles du Harness enregistrées dans
  `apps/macos/JarvisAppTests/Fixtures/ExecutionDetailSnapshots.json` ; consommation
  Swift d'échec → réparation → succès, annulation et conservation hors connexion.
  Il s'agit de fixtures API issues de tests, pas d'un run GitHub réel.
- Relectures Standards et Spec en agents distincts : sauvegarde de migration,
  plafonnement des messages, dates de fin, rafraîchissement et annulation corrigés.

Preuve native encore requise : trois états, âge de la donnée et reconnexion.
Les captures finales, clavier/AX/VoiceOver, clair/sombre et petite fenêtre
restent à exécuter. Aucun résultat visuel nouveau n'est revendiqué.

## L02 — corrections et preuves ciblées

Comparatif sur le même checkout `989b9b7` : 6/6 tests passent dans le terminal ;
4/6 passent dans l’environnement exact du module (`PATH`, `LANG=C`, `LC_ALL=C`).
`HOME` absent provoque `access-denied` chez le faux Codex contrôlé. Sans TMPDIR,
le chemin du worktree exposé par l’API commence par `/private/tmp` et viole
l’assertion existante. Le marqueur `<path>` observé dans le journal d’audit
remplaçait l’assertion et le résultat lors du nettoyage de la sortie.

Repro locale conservée : `/tmp/jarvis-ux-reliability-evidence/l02/filtered-before.log`.
Commande utile : les fichiers `execution-detail.integration.test.ts` et
`project-runtime-bindings.integration.test.ts` avec Vitest intégration et env filtré.

Probe Node loopback : succès sur hôte ; `EPERM` dans
`rtk proxy codex sandbox -c 'sandbox_mode="workspace-write"' -c 'sandbox_workspace_write.network_access=false' -- node ...`.
Journaux séparés `loopback-host.log` et `loopback-sandbox.log`. Aucun changement
de configuration globale. La CLI installée expose `codex sandbox` directement,
sans sous-commande `macos`.

Corrections implémentées : profil HOME détecté depuis l’identité OS si absent ;
validateur avec environnement minimal incluant HOME ; chemin relatif dans le
détail public ; diagnostics outils au preflight ; erreurs environnementales
sans cycle de réparation ; limite shell cohérente avec la durée configurée.
Garde-fous Codex inchangés, prompt explicite sur l’autorité de Development.

Relecture Standards : un gestionnaire peut exécuter du code du dépôt même
avec `--version`. Le preflight inspecte donc uniquement présence et droits des
exécutables dans le PATH du validateur. Il suit les scripts littéraux sélectionnés,
sans rendre les autres scripts obligatoires. Version et fonctionnement restent
explicitement non prouvés. Le test API avec faux pnpm/bun qui écriraient un
marqueur passe sans exécuter ces fichiers ni démarrer l’agent.
La relecture finale a reproduit un plantage sur un nom de script hérité
(`toString`) ; propriété propre et valeur string sont désormais requises,
avec ce cas ajouté au même test API. Aucun constat Standards ou Spec ouvert
après ces correctifs ; la preuve native reste distincte et en attente.

Relecture Spec : `pnpm exec` peut retourner 1 pour un outil absent. Son diagnostic
explicite est désormais classifié comme indisponibilité d’outil, sans réparation,
au même titre que le code shell 127. Les erreurs d’accès, timeout et panne du
runner ont chacune un code et une action distincts.

Contrôles exécutés :
- intégration Development, détail, bindings runtime et preflight : 45/45 ;
- après les correctifs de relecture : 9/9 ciblés (32 autres ignorés par filtre),
  dont outils absents, shims non exécutés et états validation/réparation/annulation ;
- tests unitaires ciblés : 43/43 ; contrat de prompt recontrôlé : 14/14 ;
- assertions originales des deux fichiers en échec conservées : 6/6 avec
  environnement filtré corrigé, puis 6/6 via le vrai helper `runProjectCommand` ;
- six snapshots de détail recapturés depuis le harness avec chemins relatifs.
- Swift `ProjectExecutionDetailTests` : 10/10 après recapture ; typecheck et
  lint réussis. Contrats et frontières de modules contrôlés sans erreur.

Commande du validateur réel (helper de production bundlé, aucun faux résultat) :
`rtk proxy node /tmp/jarvis-ux-reliability-evidence/l02/validator/run.mjs`.
Le journal `product-validator.log` conserve sa sortie. Gate complet à exécuter
depuis ce même helper après commit, dans le worktree propre.

Sources de plateforme et limites :
`docs/plans/jarvis-ux-audit-2026-09-13/VALIDATION_ENVIRONMENT_SOURCES.md`.

Premier gate complet du commit `cb35979`, worktree propre : génération,
contrats, lint, typecheck, architecture et build Engine passent. Suite unitaire :
365/366 ; la sonde de version du test d’authentification dépasse 500 ms sous
la concurrence par défaut (18 processeurs disponibles). Le fichier seul passe
26/26 avec le même validateur ; la suite entière bornée à quatre workers passe
366/366 en 7,63 s (contre 9,51 s au premier passage). `vitest.config.ts` borne
donc les workers à quatre pour ces tests qui lancent eux-mêmes de vrais processus.
Les assertions, les 500 ms et les délais du produit restent inchangés.
Preuve rouge : `l02/product-verify-unit-failure.log` dans le dossier temporaire.

Gate du commit `1ebec61` : 366/366 unitaires ; 384/385 intégration. Le test
`github-change-request.integration.test.ts` retirait ses fausses pannes avant
les retries de 500–1000 ms ; sous charge, une autre issue créait alors sa PR
avant les assertions prévues pour la seule relance manuelle. Repro déterministe
par attente de 1200 ms : deux événements de PR au lieu d'un, assertions intactes.
Le test fixe désormais l'horloge de persistence via le seam `Clock` existant.
Ce réglage est limité au bundle Harness et absent de l'artefact de production ;
la politique de retry reste inchangée. Preuve du gate :
`l02/product-verify-integration-failure.log` dans le dossier temporaire.
Correction contrôlée : 6/6 tests (création/récupération PR et absence des hooks
dans le bundle produit), typecheck réussi. Gate complet à reprendre au commit
suivant ; aucune PR GitHub réelle créée pendant ces contrôles Harness.

Le gate suivant (`cb2be5e`) retrouve le timeout de sonde malgré quatre workers :
la borne de concurrence ne suffisait pas. Instrumentation temporaire ciblée :
le premier lancement du faux exécutable met 245–344 ms avant toute sortie,
avec seulement 0–3 ms de retard de boucle Node. Après un appel de version
préalable, la sonde réelle du test reçoit sa sortie en 3,1 ms. Le test établit
donc ce prérequis avant de chronométrer l'authentification bloquée ; la sonde
de 500 ms et l'assertion totale de 2 s sont conservées. Aucun changement du
runtime produit. La suite complète unitaire passe 366/366 après cet ajustement.
Instrumentation retirée. Mesures : `l02/probe-instrumented-*.log` et
`l02/probe-warm-prerequisite.log` dans le dossier temporaire.

Gate complet final L02 au commit `5906e64`, worktree propre : **366/366 unitaires,
385/385 intégration, 187/187 Swift**, génération, contrats, lint, typecheck,
architecture, build Engine et app macOS empaquetée. Durée : **233 193 ms**.
Commande : `rtk proxy node /tmp/jarvis-ux-reliability-evidence/l02/validator/run.mjs 'pnpm verify'`.
Le helper appelle le même `runProjectCommand` que Development.
Journal : `/tmp/jarvis-ux-reliability-evidence/l02/product-verify-passed.log`.
Ce gate prouve le validateur ; les interactions natives et la nouvelle issue
GitHub réelle restent à exécuter en L10.

## L03 — contrat du guide et états

Rouge Swift : le test `ProjectOnboardingPresentationTests` échoue sur les
états de sauvegarde absents, la langue et les étapes statiques. Le guide lit
désormais le brouillon et le preflight courant ; aucun contrôle non exécuté
n’est déclaré réussi. Le contenu comporte une seule navigation projet et
quatre boutons d’étape, une largeur limitée et un pied de page de sauvegarde.
Le contrat UX canonique remplace les descriptions contradictoires.

Fichiers : `docs/product/UX.md`, `ProjectOnboardingView.swift`, `RootView.swift`,
`ProjectOnboardingPresentation.swift`, `ProjectConfigurationModel.swift`.
Contrôle ciblé Swift : 4/4, dont sauvegarde via API réelle et invalidation après
édition. Commande : `rtk proxy swift test --package-path apps/macos --filter 'ProjectOnboardingPresentationTests|ProjectConfigurationTests/testReviewUsesEngineReadinessAndKeepsIncompleteDraftSaveable'`.
Prettier des deux documents réussi. Double relecture en cours.
Visuel natif toujours en attente
du déverrouillage macOS ; dernier contrôle `ioreg` : session verrouillée.

Relecture L03 : faux succès du dépôt sans lecture, chargement permanent après
échec et erreur d’association interprétée comme erreur de sauvegarde reproduits
et corrigés. Un état `saveFailed` propre à l’opération évite cette confusion.
Le contrôle API reproduit aussi une édition pendant la sauvegarde : le nouveau
texte était annoncé « Enregistré » alors que seul l’ancien texte avait été écrit.
La réponse de sauvegarde ne certifie plus un brouillon modifié entre-temps.
Le graphe détaillé est explicitement avancé ; les états d’exécution du contrat
UX correspondent à L01. Les relecteurs vérifient ces corrections.

Dernier cas Spec : lecture positive puis moteur arrêté reproduit « Terminé »
sur le snapshot conservé. L’échec de lecture est désormais identifié séparément :
le dépôt reste visible avec « À revérifier » et une action de rechargement.
Test utilisé : le même parcours API, suivi d’un vrai arrêt Engine et d’une lecture.

Le refresh invalide aussi le preflight avant de vérifier la présence du client
Engine. Repro complémentaire : un rapport valide restait courant après perte
du client ; le test de preflight contrôle désormais le badge périmé et
l’activation indisponible. Le seam existant et `markValidationStale` sont réutilisés.

Contrôle final L03 : **12/12 Swift** (onboarding, preflight, vraie sauvegarde
et configuration refusée). Commande : `rtk proxy swift test --package-path apps/macos --filter 'ProjectOnboardingPresentationTests|ProjectPreflightTests|ProjectConfigurationTests/testReviewUsesEngineReadinessAndKeepsIncompleteDraftSaveable|ProjectConfigurationTests/testInvalidBundledPackageConfigurationIsActionableAndDoesNotReplaceTheDraft'`.
Prettier réussi ; relectures Standards et Spec sans constat restant.
Les captures aux deux tailles et apparences restent à produire, session verrouillée.

## L04 — import et navigation

Rouges : nom saisi ignoré à l’import (HTTP 201 au lieu de refuser un nom invalide),
nom d’une configuration existante remplacé par la simple détection du dossier,
absence d’ouverture explicite d’un doublon. POST accepte désormais un nom
optionnel, validé puis enregistré atomiquement sans autre changement de configuration.
L’inspection reprend le nom et les branches de la configuration existante.
Les deux scénarios Engine passent ; Swift confirme nom et doublon sur vraie API.

L’ancien test UI attendait une erreur pour un doublon. Ses assertions de conflit
`project.already-imported` et de message restent contrôlées sur un vrai POST API ;
la nouvelle surface propose explicitement le projet existant avant toute écriture.
La sélection après import vise le résultat retourné, et les réglages avancés
possedent un retour vers le guide. Le sélecteur de réautorisation est partagé.

Un point de lancement isolé est en préparation : l’application supprimait
JARVIS_DATA_ROOT hérité et aurait ouvert les données réelles. Aucun essai natif
avec ce mécanisme ignoré n’a été lancé.

L04 : 15/15 Swift import/lancement isolé, 2/2 intégration import ciblés,
typecheck réussi. La session macOS a été observée déverrouillée (`ioreg`,
13 septembre vers 13:27). Préparer le build puis exécuter les preuves natives.
Lancement `--data-root` : Engine et bookmarks isolés ; les clés de navigation et
de portée d’essai sont également préfixées par cette racine. C’est nécessaire
car le dépôt Jarvis garde le même identifiant de projet dans chaque racine.
Aucune dépendance ajoutée ; namespace de clés natif, sans nouveau stockage.


Relecture L04 close sans constat restant après correction de quatre causes :
nom trop long conservé et corrigible inline ; destination guide explicite ;
publication de l’étape Workflow avant celle du nouveau projet ; remote du guide
résolu depuis la configuration Engine sauvegardée. Le dernier projet et son
étape sont conservés dans le namespace de la racine isolée. Un refresh tardif
ne réécrit plus une sélection plus récente.

Preuves finales de code L04 : 41/41 Swift sur import/configuration/navigation/
preflight/lancement ; 144 scénarios Engine exécutés, deux attentes de contrat
complétées pour le nouveau champ remoteUrl, puis les trois cas concernés verts.
Typecheck, génération et contracts:check réussis. `rtk pnpm build:app` réussi.
Le champ additif `bindingStatus[].remoteUrl` évite de relire le choix dans un YAML
modifié après import ; une régression API couvre ce changement et la redaction.

Essais natifs sur build de travail relu (HEAD ceb3759 + delta L04), manifeste
`/tmp/jarvis-ux-reliability-evidence/l04/build-manifest-reviewed-wip.json`.
Capture 04 reproduit l’ancien problème de destination ; capture 08 confirme la
correction. Capture 07 : saisie clavier de 121 caractères, erreur inline et
création désactivée ; correction du nom puis import du second dépôt par le vrai
sélecteur. Capture 09 : édition non sauvegardée conservée après Catalogue puis
retour au projet. Capture 10 : mode avancé ; retour actionné par AX.
Captures 11–13 : guide à 1100×800 sombre/clair, puis 1512×949 clair ; capture 08
couvre 1512×949 sombre. Apparence macOS initiale sombre rétablie après l’essai.
Les contrôles de workflow restent la tranche L05, ces images ne les certifient pas.
L09 : contraste du badge Brouillon sur la ligne sélectionnée claire à améliorer.

Captures 14–16 : doublon explicitement proposé, ouverture du bon projet,
sélection de Vérification, fermeture Cmd+Q puis relancement. Le même projet
(deuxième dans la liste) et la même étape sont restaurés ; le nom sauvegardé
de l’autre brouillon reste visible. La racine réelle n’a pas été activée.
Racine de preuve : `/tmp/jarvis-ux-reliability-evidence/l04/data`.
Commande de reprise native :
`rtk proxy dist/Jarvis.app/Contents/MacOS/Jarvis --data-root /tmp/jarvis-ux-reliability-evidence/l04/data`.
Deux dépôts factices ont uniquement servi à l’import et à la navigation ;
aucune issue, exécution Development ou PR n’a été produite par cet essai.


## L05 — configuration graphique du workflow

Base : `9289c1f` (L04). Rouge puis vert au seam Swift → vraie API : changer
verify supprimait aussi test ; resoumettre la même commande install effaçait sa
confirmation. `setCommand` invalide maintenant seulement le choix concerné et
ignore une valeur inchangée. Le test sauvegarde et recharge préparation install
et la seule validation verify, avec conservation du label et des éditions.
Commande : `rtk proxy swift test --package-path apps/macos --filter 'ProjectConfigurationTests|ProjectOnboardingPresentationTests|AutomationRuleConfigurationTests'`.
21/21 réussis après la correction.

`ProjectWorkflowView` remplace les contrôles dupliqués du mode avancé et sert au
guide : proposition Engine, quatre cartes explicatives, label, installation,
confirmation des validations, résumé de PR. Aucun graphe n’est sauvegardé ;
les destinations sont lues dans la réponse composition-review. Les autres
commandes restent sous Autres vérifications, hors Advanced. Relecture et preuve
native de cette surface encore requise.

Relecture : le catalogue de contrats ne prouvait pas le lien réel d'une règle
historique. Ajout additif de `githubDevelopmentFlow` au seul read model local,
calculé par l'Engine depuis `workflowRule` et les routes validées. Ce signal
décrit la configuration, sans certifier les accès ni les commandes. Faux ou
absent : dessin présenté comme référence non confirmée, explications conditionnelles.
Contrat source, types et documentation mis à jour. Labels permanents et
passage du dessin horizontal à une liste verticale quand les quatre cartes
ne tiennent pas, sans grille sur plusieurs rangées.

Test réel API ajouté : rouge (champ absent), puis 4/4 verts avec règle historique,
label désaccordé, cible absente, identité statique, concurrence 2 et source
supplémentaire. Aucun de ces cas ne confirme la chaîne guidée. La proposition
ne remplace pas le draft sauvegardé. Suite Swift après contrat : 21/21.
Typecheck corrigé pour l'absence possible de requestAttempts : réussi.
Commande : `rtk pnpm exec vitest run --project integration apps/engine/test/composition-review.integration.test.ts`.

La session verrouillée a empêché les premières captures L05. Les deux processus
Jarvis isolés ont été fermés proprement par le menu AX Quit Jarvis.
Ne pas considérer un Cmd+Q sans effet vérifié comme une fermeture.
Les preuves natives L04 restent valides ; aucune capture L05 n'est encore revendiquée.

Vérification native L05 désormais exécutée après déverrouillage, sur build relu
(base 9289c1f + delta L05), manifeste et captures dans
`/tmp/jarvis-ux-reliability-evidence/l05/` : 02 modèle, 03 schéma confirmé,
04 installation gelée proposée, 05 verify non coché, 06 choix verify seul
enregistré, 07 petite fenêtre sombre, 08 disposition verticale à 900×800,
09 petite fenêtre claire, 10 explication PR à 1512×949 claire, 11 label modifié
au clavier avec focus préservé après sauvegarde, 12 reprise du même projet,
label et commandes confirmées après fermeture/relaunch. Toutes vues avec view_image.
Le nominal a été configuré sans Advanced, ID ou JSON. Les commandes n'ont pas
été exécutées et aucun compte n'a été autorisé : il s'agit d'une preuve UI.
App fermée proprement, absence de processus Jarvis vérifiée, apparence sombre restaurée.

Relectures finales : Standards 0 finding, Spec 0 finding. Typecheck, contrats,
build empaqueté et dernier test API 4/4 réussis. Tests Swift 21/21 réussis.
Le fallback legacy est prouvé à l'API ; sa matrice visuelle complète reste L09.

## L06 — accès et agent

Base 6238cc4. Rouge API observé : sans workflow consommant un runtime, Codex
available était présenté incompatible. La compatibilité dépend maintenant du
descripteur et des capacités ; l'absence de workflow empêche séparément toute
sélection/autorisation. API 4/4 verts, dont rejet d'une association sans workflow,
profil explicite isolé entre deux projets, absence/authentification/version/probe.
Commande : `rtk pnpm exec vitest run --project integration apps/engine/test/project-runtime-bindings.integration.test.ts`.

Deux cartes présentent le compte choisi et l'agent, avec Modifier, diagnostic,
contrôle explicite, date de réception du rapport et réparation. L'accès au dépôt
n'est affirmé que depuis un check repository courant du preflight Engine.
Un compte expiré reste lié mais ne devient pas disponible. Une association
GitHub sauvegarde d'abord le draft comme l'association du runtime.

Le runner Codex local transmet --ignore-user-config et aucun --model : affichage
« Modèle par défaut de Codex », sans lecture de configuration globale. Aide
officielle contrôlée via Context7 /openai/codex et
https://developers.openai.com/codex/cli (redirige vers https://learn.chatgpt.com/docs/codex/cli).
Aucun outil installé ni configuration globale modifiée.

Relecture : la carte choisie masquait un diagnostic de découverte et empêchait
de réautoriser le même profil local. Correction : diagnostic conservé et bouton
Confirmer à nouveau les accès sous Modifier. Tests Swift successifs 25/25,
41/41, puis suite après correction. Build natif et preuve avec compte réel en cours.


L06 vérifié : Swift 42/42, API runtime 4/4, typecheck/lint et build empaqueté
réussis. Deux relectures finales sans finding, y compris correction incrémentale.
Preuves natives vues dans `/tmp/jarvis-ux-reliability-evidence/l06/` :
01 comptes non accordés, 02 découverte Codex 0.154.0, 03 autorisations explicites,
04 contrôle GitHub terminé « dépôt accessible », 05 réautorisation proposée,
06 réautorisation terminée (rapport dépôt correctement périmé), 07 second projet
sans workflow, sans accès accordé et sans fausse incompatibilité. Aucun projet activé.
Manifest base 6238cc4 + L06 ; le dernier delta Engine (inventaire vide non vérifié)
est prouvé par test API rouge puis vert et sera inclus au prochain build natif.
L'inventaire jamais recherché affichait à tort Codex non installé ; le diagnostic
est maintenant unchecked, les descripteurs réellement absents restent absent.
App fermée proprement. Réveil temporaire caffeinate lié au PID de Jarvis ; aucune
configuration globale modifiée. Les captures 00 ne sont pas des preuves Jarvis.
Matrice exhaustive des tailles, modes et erreurs maintenue en L09.


## L07 — vérification et intention de démarrage

Base 86821da. Surface Vérification : erreurs avec correction vers l’étape,
contrôles techniques repliés, commandes exactes encore à exécuter, accès confirmés
uniquement sur rapport courant. Première exécution avec numéro d’issue, nombre
d’issues prêtes, liste indisponible distincte d’une liste vide. Bouton final partagé
avec Advanced, fixé au pied du guide ; il reprend l’intention et le numéro choisi.
Le test mono-issue refuse une issue absente, bloquée ou non vérifiée ; la surveillance
reste disponible sans candidat sur rapport réussi. Fingerprint/routage Engine inchangés.
Tests Swift 24/24 après premier rouge sur nouvelle présentation ; API preflight 11/11,
dont A seule puis B après restauration explicite et restart. Premier build réussi.
Relecture Standards sans finding ; Spec a demandé le résumé accès/commandes désormais
ajouté, et suppression de l’URI brute dans la portée en attente. Vérification finale
et preuve native encore en cours.


L07 contrôle natif effectué sur build base 86821da + delta relu, manifeste et
captures vues dans `/tmp/jarvis-ux-reliability-evidence/l07/` : 02 accès réels
valides mais label absent (activation bloquée), 03 Corriger ouvre Workflow,
04 modification sauvegardée invalide le rapport, 05 vérification terminée après
correction UI vers ready-for-agent avec vraie liste vide, 06 même vue claire à
1100×800. Action finale fixe, résumé lisible, aucune activation effectuée.
Swift final 24/24, API 11/11, deux relectures sans finding après correction,
build final réussi. Cas natif avec une issue éligible et une bloquée encore à
compléter en L09/L10 ; leur portée et admission sont prouvées par Harness.
Projet fixture garde ready-for-agent, reste draft ; ne jamais l’activer.
App fermée et apparence sombre restaurée.
