# Fiabilité et UX Jarvis — progression

Plan autorisé : [L01–L10](docs/plans/jarvis-ux-audit-2026-09-13/PLAN.md).
Worktree : `/Users/quentin/02_Code/jarvis-ux-reliability-20260913`.
Branche : `codex/ux-reliability-20260913` ; base : `64eb2945b04755590ac7534ad0c7d939084953da`.

## État de reprise

L01 implémentée et relue ; commit `989b9b7`. Contrôles ciblés réussis,
y compris une dernière reproduction rouge/verte préservant les checks après
un échec ultérieur du commit (7/7 tests de projection).
L02 commitée (`cb35979`), gate complet en cours : les deux échecs du validateur Development sont reproduits
avec les assertions inchangées ; le `listen EPERM` est reproduit séparément.
L03–L10 restent à exécuter dans l'ordre. Aucun push, test GitHub ou merge effectué.
Le projet réel et le travail retenu de #204 restent intacts.

La session macOS est verrouillée (`IOConsoleLocked = Yes`, confirmé par `ioreg`).
Le déverrouillage a été demandé le 13 septembre ; continuer les travaux indépendants.
Les captures natives tentées en L01 sont inutilisables, donc ne prouvent aucun rendu.

## Contrôles et décisions

- Instructions du worktree, du checkout principal et RTK lues ; skills implement,
  tdd, diagnosing-bugs, ponytail et code-review appliqués.
- Seams : Harness Engine avec stockage réel et réponses API, modèles/navigation
  Swift, app native empaquetée, puis vrai run GitHub/Codex.
- `rtk pnpm install --frozen-lockfile` réussi dans ce worktree.
- État initial : seuls le dossier du plan et `graft/` étaient non suivis.
  L'index graft généré reste local, hors commits.
- Captures d'audit 19, 20 et 22 consultées. Les autres captures et la maquette
  restent à examiner pour L03 et les étapes suivantes.

## Tranches

| Tranche | Implémentation / preuve | Commit |
| --- | --- | --- |
| L01 | Implémentée, tests et double relecture ; visuel en attente | `989b9b7` |
| L02 | Implémentée et relue ; gate complet en cours | `cb35979` |
| L03 | À faire — contrat UX | — |
| L04 | À faire — import et navigation | — |
| L05 | À faire — workflow guidé | — |
| L06 | À faire — accès et agent | — |
| L07 | À faire — vérification et démarrage | — |
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
