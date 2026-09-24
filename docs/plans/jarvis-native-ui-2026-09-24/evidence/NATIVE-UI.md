# Recette native — 24 septembre 2026

## Environnement

- MacBook, macOS 26.6.2, Xcode 27.0, SDK macOS 27.0.
- Écran intégré : 1512 × 982 points (3024 × 1964 pixels).
- Bundle vérifié : `dist/Jarvis.app`, build Release, version 0.1.0.
- La version minimale du produit reste macOS 15 ; aucun Mac macOS 15 n'était
  disponible pour cette recette.

## Résultat

`rtk pnpm verify` termine avec succès : génération de contrats, lint, typage,
architecture, tests TypeScript (61 suites unitaires et 52 suites d'intégration),
tests Swift (208) et assemblage Release.

La recette visuelle native n'a pas pu être menée. Deux lancements propres du bundle
ont démarré le processus et le moteur, mais l'interface Accessibilité a renvoyé
zéro fenêtre Jarvis. La demande d'activation macOS a échoué et `screencapture` a
produit un écran entièrement noir. Ces images ne sont pas conservées comme preuves
visuelles, car elles ne montrent aucun écran de l'application.

## Matrice

| Cas | Résultat |
| --- | --- |
| Compilation et lancement du bundle Release | Vérifié |
| Fenêtre macOS visible, parcours et captures « après » | Non vérifié : aucune fenêtre observable |
| Liquid Glass et apparence claire/sombre | Non vérifié visuellement |
| Tailles de fenêtre, redimensionnement et focus clavier | Non vérifié |
| Compatibilité d'exécution macOS 15 | Non vérifié : environnement indisponible |
| VoiceOver | Hors périmètre, recette dédiée différée |

Les tests automatisés confirment la compilation et les comportements couverts par
leurs seams ; ils ne remplacent pas la recette visuelle native.
