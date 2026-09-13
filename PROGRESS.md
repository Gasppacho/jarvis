# Fiabilité et UX Jarvis — progression

Plan autorisé : [L01–L10](docs/plans/jarvis-ux-audit-2026-09-13/PLAN.md).
Worktree : `/Users/quentin/02_Code/jarvis-ux-reliability-20260913`.
Branche : `codex/ux-reliability-20260913` ; base : `64eb2945b04755590ac7534ad0c7d939084953da`.

## État de reprise

L01 implémentée et relue ; contrôles ciblés réussis. Commit en préparation.
L02 est la prochaine tranche : reproduire séparément les deux échecs du
validateur Development et le `listen EPERM` du Codex enfant.
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
| L01 | Implémentée, tests et double relecture ; visuel en attente | En préparation |
| L02 | Prochaine — environnement des validations | — |
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
