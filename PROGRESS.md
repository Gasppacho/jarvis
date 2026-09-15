# Fiabilité et UX Jarvis — progression

## Audit #220 / réception #235 — 2026-09-15

[Rapport et reprise](docs/plans/issue-220-audit-2026-09-14.md).
Baseline publiée vérifiée : 372 unitaires, 400 intégration, 202 Swift.
Gate final exact `rtk pnpm verify` réussi à 07:37:44 CEST : 372 unitaires,
406 intégration, 202 Swift, contrats/types/architecture et build macOS release.
Écarts Engine/UI corrigés dans le worktree isolé `codex/issue-220-audit-20260914`.
Essai réel autorisé sur Jarvis : [#236](https://github.com/Gasppacho/jarvis/issues/236)
→ Codex → commit `45d580d` → [PR #237](https://github.com/Gasppacho/jarvis/pull/237),
deux lignes graphiques/test modifiées, vérification réussie, projets en pause.
Aucune fusion. Réception native terminée en clair/sombre, aux deux tailles,
avec VoiceOver (liens, erreur complète et correction), import, retrait,
réenregistrement et reprise. Huit captures sont jointes au rapport.
Préflight réel : 23 observations disponibles en 6,1 secondes ; configuration
incomplète toujours bloquée. #220 et #235 restent ouvertes pour la relecture
et la fusion manuelles des PR #238 et #237.

## Historique L01–L10

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
L03 implémentée et relue, commit `ceb3759`. L04 implémentée, relue et vérifiée nativement, commit `9289c1f`. L05 implémentée, relue et vérifiée nativement ; L06 implémentée, relue et vérifiée nativement, commit `86821da` ; L07 implémentée et relue, L08 implémentée et relue ; L09–L10 restent à exécuter dans l’ordre. Aucun push, test GitHub ou merge effectué.
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
| L07 | Implémentée, relue ; Swift 24/24, API 11/11, erreur/reprise/liste vide natifs | `81a5e8d` |
| L08 | Implémentée, relue ; API 5/5, Swift 15/15, échec et retour natifs | Ce commit |
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


## L08 — supervision et résultat durable (en cours)

Base 81a5e8d. Reproduction API rouge : vrai validateur exit7 dans Harness,
retrait du label → executionId null / ready-label-missing. Le journal sélectionne
maintenant le dernier request Development/PR par sujet (100), le Ledger sa dernière
tentative ; aucune lecture croisée de tables. L’issue garde executionId, statut et
dates après échec/retrait/restart. Trois tests API verts ; attente du fait d’échec
après terminaison du ledger (outbox asynchrone), sans changer l’assertion de cause.
Contrat additif et Swift mis à jour ; typecheck/contrats réussis.

Supervision : focus actif ou dernier travail, état/étape/activité/durée, ouverture,
pause des nouveaux départs ; issues prêtes puis autres repliées/filtrables.
Détail : retour à l’origine, erreur/PR en tête, étapes compactes, sorties repliées,
UUID et copies de travail sous détails, lien PR copiable depuis l’URL Engine.
Swift 15/15 avant corrections de relecture. Relecture : préserver avertissement
stale pendant retry, remonter reconnexion/date GitHub et tous les cas unavailable
au groupe Actions requises. Correctifs faits ; tests et visuel en cours.


L08 : tests API Overview 3/3, détail 2/2 (lien terminal succès aussi vérifié),
Swift 15/15, typecheck, contrats, architecture et build empaqueté réussis.
Relectures finales Spec/Standards sans finding après corrections.
Capture optionnelle `JARVIS_OVERVIEW_CAPTURE_DIR` copie uniquement les données
Harness après pause et arrêt de l’Engine. Aucun événement injecté ni DB modifiée :
le fournisseur de test et le runtime de test ont produit le cycle, la commande réelle
exit7 a échoué. Ce n’est pas une preuve GitHub/Codex réelle.

Visuel app production base81a5e8d + L08 :
`/tmp/jarvis-ux-reliability-evidence/l08/{build-manifest-reviewed-wip.json,01-failed-work-small.png,02-failure-detail-small.png,03-return-overview.png}`.
Captures vues : échec/étape/activité/ouverture visibles à1100×800, détail checks
rouges et commit/PR non commencés, retour réel à la supervision. Confirme aussi
le rendu échec L01, pas encore réparation/succès natifs. Données de test restent
pausées et app fermée. Aucun retry/activation déclenché dans cette copie.
Textes anglais résiduels du moteur/onglets repérés et à harmoniser en L09.
Préparation/agent/validation/PR réels restent à prouver en L10, et copie PR non
revendiquée avant ce contrôle. #202 n’est pas déclarée terminée.


## L09 — cohérence, accessibilité et documentation (13 septembre, en cours de clôture)

Base8f377ef. Les actions courantes, états d’exécution, Connexions et Catalogue
emploient le langage du guide. Catalogue replie les contrats ; les descriptions
connues sont traduites en présentation, sans routage Swift. CmdN ouvre le sélecteur,
CmdS enregistre le brouillon. Champs critiques avec noms AX explicites ; les cartes
interactives de connexion conservent leurs enfants accessibles. Badge sélectionné
avec couleur système, lisible avec sélection active bleue et inactive grise.

Régression API reproduite : le fait terminal git.validation-failed masquait la
commande échouée par un message générique. La projection conserve le code et la
possibilité de relance, mais présente le contrôle réel et demande de corriger sa
cause. Test RED puis GREEN 3/3 :
`rtk pnpm exec vitest run --project integration apps/engine/test/project-overview.integration.test.ts`.
Typecheck et deux builds empaquetés réussis. Swift ciblé24/24 avant derniers
libellés, dernier passage24/24 réussi. Liens locaux des cinq docs :64 vérifiés,0 absent.

Preuves natives isolées sous `/tmp/jarvis-ux-reliability-evidence/l09/` :
01 sombre1100×800 ;02 contraste défectueux (ne pas présenter comme résultat final),
03 CmdN sélecteur ;07 VoiceOver nomme Workflow et son état ;08 VO-Espace ouvre
Workflow et nomme la carte Issue prête ;09 valeur du label lue mais nom absent,
corrigé ensuite par accessibilityLabel. Sur second build, AX retourne bien
« Label des issues à développer » et ready-for-agent. CmdS a gardé le focus sur
ce champ.10/11 contraste corrigé gris/bleu ;12 Catalogue ;14 comptes après fin
découverte réseau.13 est seulement l’état de recherche.06 déborde sur un terminal,
à exclure des preuves partagées. Manifestes WIP dans le même dossier.

VoiceOver a réellement été activé (accueil Utiliser VoiceOver), navigué par
CtrlOption-flèches et actionné par CtrlOption-Espace. Les sous-titres de VoiceOver
ont été observés ; aucune écoute humaine de la synthèse vocale n’est revendiquée.
VoiceOver a été désactivé, thème sombre restauré, app quittée. Le parcours clavier
complet jusqu’à activation et la lecture VO des erreurs restent à établir avec
l’essai L10 borné ; ces points ne sont pas cochés dans MVP_ACCEPTANCE.
README/UX/workflow/local/checklist distinguent recommandé ready-for-agent,
historique agent:ready, préflight et validations exécutées, preuves Harness/natif/réel.
Relecture Spec finale0 ; Standards initiale0 avec risque contraste identifié puis
corrigé nativement ; Standards finale0. Aucun projet de fixture activé.


## L10 — gate candidat et préparation du test réel

Candidat537f86d, arbre propre : `rtk pnpm verify` lancé et arrêté sur une attente
historique de projects.integration.test.ts:2021.366 unitaires verts ;388/389
intégrations. Le test importait un projet sans workflow et exigeait Codex absent ;
L06 exige correctement unchecked/choisir workflow. Attente complète mise à jour,
sans retrait des assertions de bindings, grant ni validation de schéma.
Log : `/tmp/jarvis-ux-reliability-evidence/l10/verify-candidate.log`.

Audit préalable : #204 ouverte, needs-triage seulement, aucune issue ready-for-agent.
Projet réel jarvis toujours paused et scope exact#204 (copie en lecture des fichiers
SQLite pour inspection, aucune écriture dans les données réelles). Son worktree
retient seulement le fichier non suivi SELF_HOSTING_SMOKE.md. Préparation du corps
d’une nouvelle issue bornée PAUSE_AND_CANCEL.md sous l10/issue-body.md, pas encore publiée.

Le même test comporte aussi l’état après choix du workflow mais avant toute
découverte : attente historique absent remplacée par unchecked/Recherchez Codex,
conformément au cas items vides L06. La vraie absence reste portée par un descripteur
découvert indisponible. Aucune assertion n’est retirée.

Test ciblé1/1 réussi ; relectures Spec/Standards finales0. Nouveau gate complet à lancer sur le commit corrigé.


47d6fbd : gate complet propre réussi (verify-candidate-3.log),366 unitaires,
389 intégrations,196 Swift, contrats/lint/types/architecture/build. La tentative2
avait seulement trouvé le formatage d’une attente, corrigé par47d6fbd. Branche
poussée sans force ; relectures finales Spec/Standards0.

Issue réelle205 créée, une page PAUSE_AND_CANCEL.md ; aucune PR ouverte avant
l’essai, aucun bloqueur205. App production du commit47d6fbd lancée avec root
`/tmp/jarvis-ux-reliability-evidence/l10/data`, PID91252. Import du worktree de cette
branche, nom Jarvis essai205, base codex/ux-reliability-20260913. Installation gelée,
verifyseul, compteGasppacho etCodex0.154 explicitement choisis depuisle guide.
Configuration et activation au clavier (Tab/Espace, CmdN/CmdS, Entrée sélecteur),
mode navigation macOS temporairement0→2 viaCtrlF7, à restaurer0 à lafin.

Activation15:59:27 Europe/Paris, scope exactgithub://Gasppacho/jarvis/issues/205.
Passagecontinu depuislancement15:54:14 :313s, captures et reprisescomprises,
objectif<5min nonatteint. Captures01–11 l10vues ;11 : préparationréussie,
Codexencours, validations/commit/PR noncommencés. Aucun Advanced utilisé. Le projet
historique reste pausé. Exécutionréelle en cours, succèsnonencore revendiqué.


16:00:47 : première validationréelleéchouée après19,47s surle testunitaire
CodexRuntime/timeoutgrandchild : PIDmarkerpasécrit (deadline du run500ms).
Sortie nettoyée conservée l10/validation-failed-1.log. L’appmontrel’échecrouge,
réparationorange(capture12), puisverifytentative2encours(capture13), historique1
conservé. Une request Development seulement ; secondrunCodexderéparation, aucun
fichierdecode/testmodifiédansleworktree, seulementPAUSE_AND_CANCEL.md.
Secondevalidationcommencée16:01:25 ; diagnosticdetemporisationàcontinueraprèsfin,
pasdetestsVitestconcurrentsaveccegate.


## L10 — essai réel terminé, 13 septembre 2026

Build app et Engine : `47d6fbdffd4da6df5591ee0ef47fad4ceafa2b1e`,
Node embarqué 24.16.0, schéma 0033. Issue [#205](https://github.com/Gasppacho/jarvis/issues/205)
→ PR [#206](https://github.com/Gasppacho/jarvis/pull/206), créée par le module GitHub.
Un seul Development, deux passages Codex (initial puis réparation), une branche,
un commit `1e6f80c98efee524c647c1ad45eead8cc56545e5`, un fichier documentaire de 45 lignes.
La PR vise la branche candidate ; aucun merge. Les issues historiques restent ouvertes.

Heures UTC : préparation 13:59:33.679–34.636 ; Codex 13:59:34.658 ;
validation 1 14:00:27.943–47.411 (échec) ; réparation 14:00:47.411 ;
validation 2 14:01:25.954–14:05:56.575 (succès, 270621 ms) ;
commit 14:05:56.656 ; push 14:05:59.925 ; Development terminé 14:06:00.999 ;
GitHub terminé 14:06:02.406. `real-chain.json` contient les événements durables
ready → implementation.requested → implementation.completed → creation-requested
→ created. Le tag-added observé en parallèle ne crée aucun second Development.

Capture native 16 : PR réelle et deux tentatives, la première reste rouge ;
17 : projet en pause, dernier travail réussi accessible. Le bouton Copier le lien
retourne exactement l’URL #206 ; le lien Ouvrir la PR a reçu AXPress.
La lecture du contenu distant et le compte de commits/fichiers sont confirmés par
`rtk gh pr view 206 --repo Gasppacho/jarvis --json commits,files,headRefOid`.
Projet isolé confirmé `paused` par lecture SQLite ; app quittée. VoiceOver désactivé,
navigation clavier macOS restaurée à 0, apparence sombre conservée.

### Diagnostic complémentaire du test intermittent

Le timeout de 500 ms inclut le démarrage du faux exécutable Node. Un retard injecté
temporairement de 650 ms avant son initialisation reproduit exactement le marqueur
PID absent. À 2000 ms, la même reproduction passe. Le délai de cette seule fixture
est porté à 2000 ms ; toute instrumentation temporaire est retirée. Aucun code de
production ni assertion de timeout, SIGTERM, drainage ou disparition du groupe ne change.
Le retard reproduit le mécanisme ; aucune trace système ne permet d’attribuer la
latence originale à un composant précis du système hôte.

Preuves : `l10/timeout-startup-red.log`, `timeout-startup-green.log`, puis
`runtime-final.log` : 26/26 tests CodexRuntime. Relectures complémentaires :
Spec 0 défaut, Standards 0 défaut. Le vrai agent n’a modifié aucun test pour obtenir
la PR. Dernier gate complet à exécuter sur le commit de ce diagnostic, app fermée :
`rtk pnpm verify`, journal `l10/verify-final.log`.

### Limites de la preuve

Le passage de configuration dure 313 secondes, reprises et captures incluses :
cible de moins de cinq minutes manquée de 13 secondes. Vingt et une actions métier
comptées (ajout, choix du dossier, nom, création, navigation, choix et confirmations,
vérifications, portée et activation), hors frappes de texte et navigation interne
au sélecteur. Le passage inclut une navigation erronée vers Accès et un retour à
Workflow. Aucun Advanced, JSON ni identifiant technique saisi dans le guide.

La configuration et l’activation complètes sont faites au clavier. Les noms et
valeurs ont été observés avec AX et sous-titres VoiceOver, dont une activation de
carte par VO-Espace. La lecture VoiceOver de l’erreur complète n’a pas été établie ;
aucune écoute humaine ni audit exhaustif d’accessibilité n’est revendiqué.
Les scénarios coûteux de blocage/libération, concurrence, reprise, annulation,
réponse périmée et custom restent des preuves Harness/Swift, pas des runs GitHub réels.
Notarisation et Gatekeeper sur machine propre restent hors preuve.


## État de livraison final

`rtk pnpm verify` a réussi sur l’arbre propre du commit
`f53a23421a425cda8961fe885449b502405cc70f`, terminé le 13/09/2026 à 16:16:34
Europe/Paris : 366 tests unitaires, 389 intégrations, 196 tests Swift ; contrats,
lint, types, architecture et build réussis. Journal :
`/tmp/jarvis-ux-reliability-evidence/l10/verify-final.log`.
Le commit suivant ne contient que cette consignation documentaire.

Le build final a été rouvert sur les données réelles isolées : capture 19 à
1100×800, projet toujours en pause, scope #205 et dernier travail/PR conservés.
App quittée ensuite. Capture 18 : page #206 effectivement chargée après ouverture
depuis Jarvis ; elle contient des titres d’autres onglets et reste une preuve locale,
à ne pas publier telle quelle. Les captures natives 12, 13, 16, 17 et 19 sont les
preuves de l’échec, réparation, succès, pause et réouverture.

L01–L10 implémentés et contrôlés avec les limites ci-dessus. La PR d’implémentation
est publiée depuis cette branche vers main, distincte de la PR de preuve #206.
Aucune fusion, fermeture d’issue historique, suppression de données réelles ou
modification de configuration globale Codex. Les preuves sources restent locales
sous `/tmp/jarvis-ux-reliability-evidence/` ; ne pas effacer ce dossier avant archivage.

## L15 — réception finale de la base #234 (14 septembre 2026)

Le rapport détaillé est dans [issue-235-verification.md](docs/plans/issue-235-verification.md).
La matrice Harness réutilisée passe en séquentiel (**12 fichiers, 58/58 tests**)
et la suite intégration complète post-correction passe (**52 fichiers, 400/400**).

Le défaut de la preuve PR venait de l’intervalle de polling Harness à 25 ms :
le scheduler lance un tick immédiat puis répète les observations, et une
observation supplémentaire pouvait être consommée pendant la chaîne PR. Cela
produisait une troisième exécution `development`, sans créer de seconde
admission ou Pull Request. `bb1cbf7`, intégré dans `fd753dc`, isole ce scénario
avec un polling de fond à 60 s et un rafraîchissement explicite après le seed ;
l’assertion exacte de trois exécutions est conservée. Le test ciblé passe **2/2**
et le stress séquentiel passe **20/20**.

Le coordinateur a exécuté `rtk pnpm verify` exactement sur `fd753dc` avec succès :
**372/372 unitaires, 400/400 intégrations, build de l’app release, 202/202 Swift** ;
génération, contrats, lint, typecheck et architecture passent également.

L’app assemblée a démarré sur un data root vierge et a créé sa SQLite, mais la
preuve native finale a ensuite été observée par le coordinateur sur l’app
empaquetée du checkout d’intégration au commit `3dbd0e3`, avec le data root
`/tmp/jarvis-issue-235-native-final-20260914-1035`. Le parcours local observé
est `Add Project` → dialogue Open → `/private/tmp/jarvis-issue-220-integration-v3`
→ import sheet → `Create draft` → `Workflow` → `Add GitHub` → `Access and agent`
→ `Verification`. Aucun dépôt GitHub externe n’a été muté.

Le dossier final contient les 13 captures consignées dans
[le rapport détaillé](docs/plans/issue-235-verification.md), avec fenêtres
1100×800 et 1512×949 en sombre et clair, PNG Retina 2x, apparence sombre
restaurée et fenêtre finale 1100×800 logique en `0,33`. System Events a exposé
les libellés AX de l’import, du workflow, de l’accès et de la vérification,
notamment `Brouillon · Workflow`, `Brouillon · Accès et agent`, les comptes
`Gasppacho` et `QServicesEntreprise` avec `Disponible`, l’autorisation projet,
`Non vérifié`, les commandes de recherche Codex et la vérification désactivée
avant sauvegarde du draft. Le contrôle Workflow a reçu le focus ; Space a fait
passer l’affichage d’Access and agent à Workflow, avec anneau de focus sur
Verification. AXPress n’a servi qu’à la navigation locale finale Verification.

L’ancien essai avec console verrouillée (`IOConsoleLocked = Yes`) et capture
noire reste un artefact invalide ; il n’est pas compté contre cette preuve
native finale. Aucun repository sandbox, budget ou binding Codex n’étant
explicitement autorisé, aucun dogfood GitHub/Codex n’a été lancé ou muté. L15
reste **ouvert / needs-info** pour ce dogfood ; il faut fournir un dépôt sandbox,
un compte, une issue bénigne dédiée, un budget et un binding runtime Codex
explicitement autorisés.
