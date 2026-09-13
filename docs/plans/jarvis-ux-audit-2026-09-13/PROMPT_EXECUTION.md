# Mission : exécuter intégralement le plan de fiabilité et UX Jarvis

L'utilisateur demande une application macOS la plus simple et graphique possible, permettant à un débutant de configurer Jarvis pour développer ses propres issues GitHub. Il a demandé un audit réel, un plan détaillé puis le lancement d'une nouvelle session Codex pour exécuter ce plan. L'audit est terminé ; cette session est la session d'implémentation autorisée. Agis maintenant, ne te limite pas à reformuler le plan et ne redemande pas l'autorisation de commencer.

## Documents et environnement

Ton worktree isolé : `/Users/quentin/02_Code/jarvis-ux-reliability-20260913`.
Branche : `codex/ux-reliability-20260913`, base auditée `64eb2945b04755590ac7534ad0c7d939084953da`.

Lis d'abord les fichiers de `docs/plans/jarvis-ux-audit-2026-09-13/` copiés dans ce worktree :

1. `ETAT_DES_LIEUX.md` : diagnostic fondé sur l'application réelle.
2. `RESULTAT_TEST.md` : échec du vrai run GitHub/Codex #204, état conservé.
3. `PLAN.md` : dix tranches L01–L10, dépendances, critères d'acceptation et gates.
4. `reference-maquette.html` : copie de la proposition précédente. Inspiration visuelle, données fictives, pas spécification de comportement réelle.

Les preuves natives et journaux sont dans `/Users/quentin/02_Code/jarvis/.scratch/ux-audit-2026-09-13/evidence/`. Utilise view_image pour les lire. Les captures 01, 02, 03, 11, 19, 20, 22, 23 et les trois captures maquette sont particulièrement utiles.

Respecte les instructions AGENTS.md du dépôt et lis également `/Users/quentin/02_Code/jarvis/AGENTS.md` pour les instructions locales récentes, puis `/Users/quentin/.codex/RTK.md`. Préfixe les commandes shell par rtk. Cherche d'abord dans graft pour le code, trace les callers avant modification ; construis un index local si nécessaire. Utilise les skills installés implement, tdd, code-review, ponytail et diagnosing-bugs aux étapes appropriées. Utilise Context7 pour des questions de bibliothèques/CLI et la documentation primaire actuelle pour les faits de plateforme. Ne réinstalle aucun skill ni configuration globale.

## Objectif exact

Livrer quatre étapes guidées **Dépôt → Workflow → Accès et agent → Vérification**, avec schéma graphique et réglages usuels utilisables sans Advanced. Le workflow : issue ouverte portant ready-for-agent et sans bloqueur GitHub natif ouvert → GitHub produit scm.work-item.ready → Automation Rules produit development.implementation.requested → Development prépare le worktree, fait développer, valide, commit et pousse → scm.change-request.creation-requested → GitHub crée une PR. Une issue à la fois ; relecture et merge humains.

Commence par les blocages de confiance L01 et L02 : un validation.failed réel apparaissait en vert dans la frise ; le run réel a échoué trois fois aux deux mêmes tests d'intégration, pendant que les vérifications internes de Codex échouaient séparément sur listen EPERM. Le projet revenait ensuite à Ready et l'issue à Not eligible sans lien vers l'échec. Reproduis et corrige les causes, pas les assertions.

## Exécution et autorisation

- Implémente L01 puis L02 et toutes les tranches suivantes jusqu'à L10. Une tranche à la fois, un checkpoint de travail dans `PROGRESS.md` avec preuve, fichier et commande utile. Continue après chaque commit ; ne termine pas après la première correction.
- Travaille dans ce worktree, pas dans le checkout principal. Préserve les modifications utilisateur, les missions, les anciens worktrees et les autres branches. Installe les dépendances du projet avec le lockfile dans ton worktree.
- L'utilisateur a autorisé des issues de test sur Gasppacho/jarvis. Ne publie pas une nouvelle série d'issues d'amélioration : les lots locaux du plan suffisent. Ne traite pas les autres tickets sans rapport et ne ferme pas #187/#202/#203 en déclarant cette preuve équivalente à leurs critères.
- Le projet réel `jarvis` a été mis en pause après le test ; #204 est ouverte, son label déclencheur a été retiré. Ne le réactive pas sans contrôler la portée mono-issue et l'état du travail retenu. Préfère une racine de données isolée pour développer et tester l'UI.
- Aucun merge, force push, suppression de données réelles ou modification de configuration globale Codex. Prépare des commits relus sur la branche dédiée et une PR d'implémentation à relire une fois le résultat validé. L'autorisation d'implémenter n'autorise pas à fusionner.
- Ne contourne pas les garde-fous du produit pour obtenir une démo verte : pas de faux événement, pas de patch de la DB, pas de sandbox supprimé globalement, pas d'assertion retirée. Ne publie pas une PR du test manuellement à la place du module GitHub.
- Réutilise les contrôles et modèles existants, sans refonte générale du moteur ni nouvelle dépendance UI. Le graphique est une projection explicative des événements ; la configuration canonique reste la seule vérité. Swift ne réimplémente pas le routage.
- Choisis les détails d'implémentation usuels avec ton jugement. N'interroge l'utilisateur que pour un vrai blocage externe que les preuves et le plan ne permettent pas de résoudre.

## Vérification attendue

Tests au plus haut niveau réaliste, contrôles ciblés pendant chaque tranche, vérification complète `rtk pnpm verify` dans le worktree propre à la fin, relecture du diff et tests visuels de l'app empaquetée. Une seule assertion de labels figés n'est pas une preuve du parcours.

L'application a réellement pu être pilotée via System Events et cliclick dans la session d'audit. La fenêtre était à position 0,33, taille 1512,949. Ne réutilise pas aveuglément les coordonnées : observe la nouvelle interface. Attention : un clic AX sur un static text peut retourner sans changer la sélection. Les boutons SwiftUI ont souvent des noms AX manquants ; les captures sont alors nécessaires. Après une action réseau, vérifier le résultat terminé avant capture. Le navigateur Playwright ouvre la maquette via un serveur HTTP loopback, pas file://.

Évaluer aussi clavier, noms AX, VoiceOver quand disponible, taille réduite, clair/sombre, reprise du draft, compte absent, workflow incomplet, règle périmée et échec de validation. Documenter les preuves manquantes honnêtement.

La sortie L10 exige une nouvelle issue réelle limitée, configuration depuis l'UI, vrai Codex, validations réussies, un seul commit de travail pertinent et une seule PR créée par GitHub via l'événement. Capturer la chaîne, identifier le build et les SHA, puis mettre le projet en pause. Aucun merge. En cas d'échec, diagnostiquer et poursuivre les corrections autorisées ; ne déclarer ni terminé ni testé ce qui ne l'est pas.

## Communication et résultat

Communique en français avec de courts points d'avancement. Le rapport final doit distinguer changements implémentés, tests réellement exécutés, vérification visuelle, issue/PR réelle, commits et limites. Mets à jour `PROGRESS.md` pour permettre de reprendre précisément après interruption. Le plan complet est disponible à côté de ce prompt ; il constitue le périmètre à exécuter, pas une simple suggestion.
