# Résultat terminal du test réel #204

Date : 13 septembre 2026. Heures ci-dessous en Europe/Paris.

**Résultat : échec contrôlé, aucune Pull Request produite.** Le workflow n'est donc pas validé de bout en bout dans les conditions réelles auditées.

## Chronologie vérifiée

| Heure | Fait observé |
| --- | --- |
| 11:22:21 | `scm.work-item.ready` pour #204 puis `development.implementation.requested` |
| 11:22:23 | Préparation du worktree commencée |
| 11:22:24 | Installation terminée ; Codex démarré |
| 11:23:20 | Première validation `verify` par Development |
| 11:24:40 | Première validation échouée |
| 11:25:36 → 11:26:59 | Deuxième validation, même échec |
| 11:27:37 → 11:29:01 | Troisième validation, même échec |
| 11:29:01 | `development.implementation.failed`, exécution terminée en failed |

La demande de développement a duré environ 6 min 40 s. Ce temps ne mesure pas la durée du parcours de configuration.

Trois tentatives du validateur Development ont donné **365/365 tests unitaires réussis et 375/377 tests d'intégration réussis**. Les deux mêmes échecs se répètent :

- `apps/engine/test/execution-detail.integration.test.ts:70` : le texte public contient `<path>` alors que l'assertion l'interdit.
- `apps/engine/test/project-runtime-bindings.integration.test.ts:111` : readiness `access-denied` au lieu de `ready`.

Les étapes build app et tests Swift situées après l'intégration n'ont pas été exécutées par ce gate. Les rapports du Codex enfant sur ses propres vérifications mentionnent séparément les erreurs `listen EPERM`; ils ne sont pas les résultats du validateur Development.

## État conservé

- Projet `jarvis` configuré puis **mis en pause depuis l'application** après l'échec. Périmètre d'essai limité à #204.
- Issue [#204](https://github.com/Gasppacho/jarvis/issues/204) laissée ouverte comme trace ; label `ready-for-agent` retiré, donc elle ne doit plus déclencher de nouveau travail.
- Exécution Development : `exec_5bdc186c-feca-4d3b-bb9d-177f7a76dc6c`.
- Une branche locale et un worktree retenu pour diagnostic. Aucun nouveau commit, push ou événement de création de PR observé ; aucune PR ouverte au contrôle GitHub.
- Le seul fichier ajouté au worktree est `docs/engineering/SELF_HOSTING_SMOKE.md`. Le checkout principal n'a pas été modifié par le module.
- Le worktree retenu est sous le répertoire local Application Support de Jarvis ; son chemin est accessible dans la fiche technique et n'est pas publié sur GitHub.
- Aucun merge, aucune suppression de worktree utilisateur, aucun changement des autres issues.

## Défauts supplémentaires confirmés à la fin

Après l'échec terminal, l'Overview revient à **Ready / Waiting for an eligible issue**. L'issue #204 apparaît **Not eligible — This issue has already been admitted and will not start twice** et perd son bouton Open execution. Le moteur évite bien une réadmission automatique, mais l'interface masque l'échec et son point de reprise. Captures 22 et 23.

L01 et L08 doivent garder l'échec visible et offrir une ouverture du dernier résultat. L02 doit éviter de refaire la même validation trois fois et d'appeler l'agent pour une panne d'environnement hors du périmètre de l'issue.

## Preuves locales

Dans `.scratch/ux-audit-2026-09-13/evidence/` :

- `terminal-state.json` : statuts, événements, checkpoints et branche, extraits en lecture seule de SQLite.
- `validation-failure-1.txt`, `validation-failure-2.txt`, `validation-failure-3.txt` : sorties enregistrées par Development, sans codes de couleur ANSI.
- `19-execution.png`, `20-execution-details.png` : frise verte et résultats en échec pendant les réparations.
- `22-failed-overview.png`, `23-terminal-issue.png` : échec non mis en évidence dans l'Overview.
- `24-paused.png` : pause après le test.

Ne pas traiter ce run comme une preuve réussie pour #203. Il constitue une reproduction utile pour le nouveau plan.
