# Exécution du plan UX — 16 septembre 2026

> Archive de preuve historique. Le parcours décrit ici est remplacé par
> **Workflow → Paramétrage → Vérification** depuis l'ADR 0020.

## Livré localement

- Workflow guidé : parcours recommandé GitHub → Développement → PR, observation seule explicite, aperçu des quatre cartes dès le brouillon vide, cartes reflétant les modules activés, label de départ cohérent entre GitHub et Développement, ressources éditées dans Accès et agent, brouillon enregistrable.
- Blocages : catalogue indisponible avec Réessayer, saisies de branche et fréquence conservées pendant l'édition, fréquence bornée par un Stepper, pause accessible pour une migration historique, libellés français.
- Vérification : synthèse de la portée et des commandes, problèmes regroupés par correction, détails techniques repliés, activation interdite avec un contrôle périmé. Corriger transmet la destination structurée du contrôle et place le focus sur le champ ou l'action concernée pour les contrôles connus.
- Import : remote complet affiché sur plusieurs lignes et sélectionnable.

## Vérification observée

- `pnpm verify` : générateurs, contrats, formatage, types, architecture, 372 tests unitaires, 406 tests d'intégration, app release et 204 tests Swift passés. Après l'ajustement du cycle de vie du focus, une nouvelle compilation release et le test Swift ciblé sont passés.
- Instance native isolée avec `--data-root` et dépôt Git temporaire. Captures dans `.scratch/ux-implementation-20260916/` : import avec remote exact, brouillon vide, observation seule sans PR, parcours recommandé avec PR prévue et commandes à configurer, préflight après enregistrement, fenêtre 1100 × 800 et action Corriger vers Accès et agent. Aucune activation, issue ni PR distante.
- Après fermeture et réouverture de l'instance isolée, le brouillon et l'étape Accès et agent étaient conservés. Avec la navigation clavier complète de macOS, Tab parcourt les étapes, les quatre cartes, les champs, les actions du pied de page et les détails avancés. Les descriptions d'accessibilité des étapes et des cartes sont explicites ; le nouveau libellé de l'incrément de fréquence a été vérifié dans l'élément AX de la build finale.
- Captures claires supplémentaires du Workflow et de Vérification à 1100 × 800 et 1512 × 949 ; les actions et le pied de page restent visibles, le contenu long défile.
- VoiceOver activé sur l'instance isolée : déplacement dans la barre latérale et entrée dans la zone de contenu, avec annonce de l'action d'activation désactivée ; captures des sous-titres VoiceOver conservées. VoiceOver a ensuite été désactivé. Le mode clavier complet et l'apparence sombre ont été rétablis.
- Après un premier essai où le focus restait sur la fenêtre, le correctif a été retesté dans la build native : Corriger sur « Agent de développement » ouvre Accès et agent avec l'anneau de focus sur « Rechercher Codex » (`test-repair-runtime-focus.png`).

## Réception encore ouverte

- Parcours VoiceOver parlé complet et contrôle visuel de Dépôt et Accès et agent à toutes les combinaisons de taille et d'apparence. Une partie des annonces a été observée, sans réception complète des quatre étapes.
- Migration d'un projet historique actif et panne réelle du catalogue dans l'app native : tests ciblés passés, parcours visuel non exécuté.
- Le routage structuré a un test Swift ciblé ; le focus natif est prouvé pour l'agent. Les autres familles de contrôles, notamment une commande de validation manquante, attendent encore une réception native et VoiceOver.
- Essai GitHub/Codex de bout en bout : nécessite un dépôt sandbox, une issue dédiée, des accès et un budget autorisés. Il reste distinct des preuves locales.

L'automatisation macOS a envoyé une commande à l'instance Jarvis déjà ouverte pendant l'essai et y a créé un brouillon temporaire par erreur. Ce seul projet, créé le 16 septembre à 20:01:24 UTC, a été supprimé par l'interface ; la table `projects` de cette instance est de nouveau vide. Aucun dépôt ni fichier du dépôt n'a été supprimé.

L'instance isolée a été fermée. L'app principale a été relancée sur la dernière build et laissée au premier plan ; `projects` contient 0 projet, le mode clavier macOS est revenu à `0` et l'apparence à `Dark`.
