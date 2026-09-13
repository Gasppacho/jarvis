# Issue #201 — preuve du premier workflow visible

Date : 2026-09-13. Worktree : `/private/tmp/jarvis-issue-201`. Base :
`8c3175d` (`origin/main`, issue #200). Les dépendances #198, #199 et #200
sont présentes dans cette base.

Cette preuve exécute le vrai Engine et la même Local API que les écrans
macOS, avec SQLite temporaire, un dépôt Git et un bare remote temporaires,
un faux GitHub et le `FakeRuntime` enfant déterministe. Elle ne crée aucun
objet GitHub réel et ne lance pas Codex réel.

## Exigences et preuves

| Exigence | Preuve exécutée |
| --- | --- |
| Un checkout vierge démarre avec un brouillon guidé et une racine de données temporaire | `startReferenceWorkflowFixture(..., true)` crée le repository, le bare remote et la racine SQLite sous `mkdtemp`; le test vérifie les quatre instances, `maxConcurrentExecutions: 1`, l’absence de ressources implicites et zéro lecture GitHub/agent avant activation. |
| Le parcours expose Repository → Workflow → Connections → Review et le brouillon survit à la réouverture | [`ProjectOnboardingPresentationTests.swift`](../../apps/macos/JarvisAppTests/ProjectOnboardingPresentationTests.swift) vérifie les quatre étapes, leurs titres et la persistance du pas; le scénario Engine sauvegarde puis relit la configuration complète. |
| Une issue avec `blocked_by` ouvert est visible comme bloquée, avec raison et blocker, sans travail | [`reference-workflow-first-run.integration.test.ts`](../../apps/engine/test/reference-workflow-first-run.integration.test.ts) vérifie le contrat `ProjectOverviewV1`, `open-native-blockers`, le lien opaque `github://.../999`, l’observation SQLite `blocked`, zéro événement, zéro exécution, zéro runtime et zéro PR. |
| La fermeture du blocker rend l’issue éligible une seule fois | Le même test remplace uniquement l’état du blocker dans le fake provider, vérifie le candidat `eligible` via `POST /preflight`, puis la ligne `github_work_item_readiness` devient `ready` et un seul fact `scm.work-item.ready` est émis; aucune étiquette `blocked` n’est utilisée. |
| Le fake child réalise une modification, les validations passent, le commit et le push sont observables | Le test attend les événements `development.implementation.requested`, `development.implementation.completed` et `scm.change-request.creation-requested`, contrôle `verify: passed`, le commit différent sur le bare remote et `fake-runtime-change.txt` sur la branche poussée. |
| Une PR est créée et le parcours s’arrête avant le merge | Le test observe un seul `scm.change-request.created`, une seule PR fake, un mapping GitHub terminé et aucune occurrence d’événement de merge. |
| Un redémarrage/replay ne duplique rien | Le test redémarre le même fixture et la même racine de données, attend une nouvelle lecture de polling, puis vérifie une seule branche `agent/*`, une seule PR, un seul runtime, trois exécutions (`github`, `automation-rules`, `development`), les mêmes événements et les mêmes mappings. Le curseur GitHub et la clé d’idempotence sont lus dans SQLite. La redélivrance explicite des handlers reste couverte par [`reference-workflow-redelivery.integration.test.ts`](../../apps/engine/test/reference-workflow-redelivery.integration.test.ts), exécuté par le gate intégration. |
| Les états visibles et la donnée technique correspondent | Les réponses réelles `GET /overview`, `POST /preflight` et `GET /executions/:id/detail` sont validées par `ProjectOverviewV1`, `ProjectPreflightV1` et `ExecutionDetailV1`; le détail consommé par `ProjectExecutionDetailView` prouve `Issue reçue`, `Éligibilité confirmée`, workspace, agent, checks, commit/push et PR. |
| La preuve Engine et la preuve UI sont séparées | Le test automatisé documente explicitement ses faux services et ses limites; les tests Swift existants couvrent les modèles réellement consommés par SwiftUI. Aucun capture injectée ni target XCUITest n’est présenté comme un smoke visuel. |

## Commandes et résultats

- `rtk pnpm exec vitest run --project integration apps/engine/test/reference-workflow-first-run.integration.test.ts` : **1/1 réussi** (6,25 s), avec build du bundle Engine de test.
- `rtk pnpm exec prettier --write apps/engine/test/reference-workflow-first-run.integration.test.ts` : réussi.
- `rtk pnpm verify` : **réussi** — contrats, architecture, 365 tests unitaires, 377 tests d'intégration, build release et 185 tests Swift.
- Le contrôle ciblé lancé avant l’ajout du fichier ne trouvait aucun test et sortait avec le code 1; le même contrôle passe après l’implémentation.

`rtk pnpm build:app` réussit et assemble `dist/Jarvis.app`. Le smoke manuel
avec `rtk proxy open dist/Jarvis.app` a ensuite lancé l’application et son
Engine, mais la session graphique disponible ne crée aucune fenêtre :
`osascript` observe `count of windows = 0` pour Jarvis et pour TextEdit, et
`screencapture -x` produit une surface noire. Les captures des quatre étapes,
les durées interactives et VoiceOver ne peuvent donc pas être observés dans
cette session. Le dépôt macOS est SwiftPM-only et ne possède pas de target
XCUITest; cette limite reste volontairement non cochée dans les checklists.

## Limites de livraison

Le fake GitHub et le FakeRuntime prouvent la causalité locale, la durabilité
et l’idempotence. Ils ne prouvent ni permissions d’un compte GitHub réel, ni
notarisation, ni Gatekeeper, ni qualité d’interaction VoiceOver. Le workflow
s’arrête volontairement à la PR et ne demande aucun merge. Aucun label
`ready-for-human` n’est ajouté tant que cette preuve interactive manque.
