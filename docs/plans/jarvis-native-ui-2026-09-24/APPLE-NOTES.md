# SwiftUI et Liquid Glass — notes Apple

Recherche vérifiée le 24 septembre 2026. Sources primaires Apple ; recherche initiale via Context7 (`/websites/developer_apple_swiftui`), puis lecture des pages Apple et de leurs versions Markdown. Ces notes documentent les possibilités de la plateforme, pas une validation de l'application Jarvis.

## Faits vérifiés

| Sujet | Conséquence pour la réalisation | Source |
| --- | --- | --- |
| Adoption automatique | Les composants standard SwiftUI/AppKit adoptent le nouveau rendu avec les SDK récents, sur les versions système correspondantes. Apple recommande de commencer par reconstruire l'application. | [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass) |
| Navigation et contenu | Liquid Glass constitue une couche de navigation et de commandes. Les fonds personnalisés sur `NavigationSplitView`, les barres et les contrôles peuvent masquer le rendu système. | [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass) |
| Structure de fenêtre | Apple recommande les split views et l'inspecteur natif pour ces dispositions, avec redimensionnement et respect des zones de sécurité. | [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass) |
| Barres d'outils | Les éléments de barre reçoivent automatiquement Liquid Glass. Regrouper les commandes selon leur fonction. | [Exemple Landmarks](https://developer.apple.com/documentation/swiftui/landmarks-refining-the-system-provided-glass-effect-in-toolbars) |
| Verre personnalisé | `glassEffect(_:in:)` exige macOS 26.0 ou ultérieur. Son apparence par défaut utilise `.regular` et une capsule. | [glassEffect](https://developer.apple.com/documentation/swiftui/view/glasseffect(_:in:)) |
| Boutons | `.buttonStyle(.glass)` et `.buttonStyle(.glassProminent)` exigent macOS 26.0 ou ultérieur. | [glass](https://developer.apple.com/documentation/swiftui/primitivebuttonstyle/glass), [glassProminent](https://developer.apple.com/documentation/swiftui/primitivebuttonstyle/glassprominent) |
| Conteneur de verre | `GlassEffectContainer` exige macOS 26.0 ou ultérieur ; il rassemble le rendu de plusieurs formes et permet leur fusion. | [GlassEffectContainer](https://developer.apple.com/documentation/swiftui/glasseffectcontainer) |
| Transparence réduite | `accessibilityReduceTransparency` indique que les fonds doivent être opaques. | [EnvironmentValues](https://developer.apple.com/documentation/swiftui/environmentvalues/accessibilityreducetransparency) |
| Animations réduites | `accessibilityReduceMotion` demande d'éviter les animations importantes, particulièrement celles simulant la troisième dimension. | [EnvironmentValues](https://developer.apple.com/documentation/swiftui/environmentvalues/accessibilityreducemotion) |
| Contraste renforcé | `colorSchemeContrast` expose `.standard` ou `.increased`. Apple recommande l'Asset Catalog lorsque seules les couleurs ou images changent. | [EnvironmentValues](https://developer.apple.com/documentation/swiftui/environmentvalues/colorschemecontrast) |

Les composants système adaptent automatiquement leurs effets aux réglages d'accessibilité. Les couleurs, animations et composants personnalisés doivent être vérifiés séparément. Apple déconseille l'accumulation d'effets de verre. [Guide d'adoption](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass).

## Recommandations pour Jarvis

Ces choix sont des recommandations de réalisation, à distinguer des faits de plateforme ci-dessus.

- Conserver le déploiement macOS 15 et construire avec un SDK macOS 26 ou ultérieur. Le SDK disponible à la compilation et la version du système d'exécution sont deux contraintes différentes : macOS 15 conserve son apparence native ; le SDK récent ne lui apporte pas Liquid Glass.
- Utiliser `NavigationSplitView`, `.toolbar`, `List`, `Form`, `Button`, `Picker`, les sheets et les popovers standard. Limiter le verre aux surfaces de navigation et aux commandes ; conserver des fonds lisibles pour les listes, formulaires et journaux.
- Commencer par l'adoption automatique. Introduire un effet explicite uniquement s'il apporte un bénéfice visible. Garder les usages macOS 26 derrière `if #available(macOS 26.0, *)`, avec un contrôle ou fond natif compatible macOS 15 dans l'autre branche. Ne pas ajouter de bibliothèque de simulation du verre.
- Laisser les composants système gérer leur adaptation. Pour les seuls éléments personnalisés, respecter `accessibilityReduceTransparency`, `accessibilityReduceMotion` et `colorSchemeContrast`. Préférer les couleurs sémantiques ; prévoir les variantes nécessaires dans les assets pour les accents personnalisés.
- Vérifier sur une application native construite avec le SDK cible : macOS 26 et macOS 15, clair/sombre, contraste renforcé, transparence réduite, animations réduites, redimensionnement et navigation clavier. Une maquette HTML ne prouve aucun de ces comportements natifs.

## Limites de cette recherche

La disponibilité de chaque nouvelle API est vérifiée dans les métadonnées Apple. L'installation du SDK sur la machine, les réglages effectifs du projet, l'apparence réelle des écrans et les performances restent à constater dans les lots de développement. Aucun essai d'exécution ni test de Jarvis n'a été réalisé pour ces notes.
