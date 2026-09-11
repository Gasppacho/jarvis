# macOS Application Architecture

## Responsibilities

L'application native :

- démarre et supervise le moteur embarqué ;
- obtient l'accès utilisateur aux repositories ;
- gère Keychain et security-scoped bookmarks ;
- consomme l'API locale et SSE ;
- affiche projets, modules, graphes, événements et exécutions ;
- présente notifications et actions utilisateur ;
- empaquette les ressources nécessaires.

Elle ne :

- route pas les événements ;
- exécute pas les modules ;
- lit pas SQLite directement ;
- construit pas une commande Git métier ;
- stocke pas de token dans les préférences.

## Swift structure

```text
apps/macos/
├── JarvisApp/
│   ├── App/
│   ├── Navigation/
│   ├── Features/
│   │   ├── Projects/
│   │   ├── ProjectSetup/
│   │   ├── Modules/
│   │   ├── Graph/
│   │   ├── Executions/
│   │   ├── Events/
│   │   ├── Connections/
│   │   └── Settings/
│   ├── EngineSupervisor/
│   ├── APIClient/
│   ├── Keychain/
│   └── Resources/
└── JarvisAppTests/
```

Features UI sont verticales ; elles partagent seulement design system, navigation et client API.

La feature `Connections` liste les descripteurs, enregistre une référence de
compte GitHub `gh://...` et déclenche leur validation via le Local API. Elle ne
demande ni n'affiche de token ; les bindings `sourceControl` restent une
configuration propre au Project.

## Engine bundle

```text
Jarvis.app/Contents/
├── MacOS/Jarvis
├── Resources/engine/
│   ├── node
│   ├── engine.bundle.mjs
│   ├── native/
│   ├── modules/
│   ├── contracts/
│   └── migrations/
├── Resources/build-manifest.json
└── Frameworks/
```

Tous les exécutables et native addons sont signés avec le bundle. Le moteur utilise des chemins dérivés du bundle, jamais le working directory courant.

## Local API client

`contracts/openapi/local-api.v1.yaml` est source de vérité. Swift OpenAPI Generator crée les types et opérations. Le client ajoute :

- base URL dynamique fournie par le handshake ;
- header bearer éphémère ;
- correlation client pour diagnostics ;
- décodage d'erreur standardisé.

Le SSE peut utiliser URLSession bytes et un parseur dédié ; les payloads d'événements UI sont versionnés dans l'OpenAPI. Le flux utilise une URLSession
séparée du transport REST : les appels loopback ordinaires expirent après cinq
secondes, tandis que le flux SSE dispose d'une limite d'inactivité/ressource de
cinq minutes. Le moteur envoie des commentaires SSE environ toutes les 15 secondes
pour maintenir une connexion saine observable ; ces commentaires sont ignorés et
ne sont pas des mises à jour métier.

## State management

- Une `AppModel` possède l'état de session moteur et navigation globale.
- Chaque feature possède un modèle observable isolé.
- Les lists utilisent snapshots issus de l'API ; SSE déclenche des mises à jour incrémentales ou invalidations.
- L'UI ne suppose jamais qu'un événement SSE est durable avant de pouvoir le relire via API.

## Repository access

L'utilisateur choisit un dossier avec `NSOpenPanel`. Le shell crée un bookmark durable et le stocke en local. Un build sandboxé utilise un security-scoped bookmark ; la distribution directe non sandboxée utilise un bookmark standard, afin que les rebuilds signés ad hoc ne rendent pas le Repository Grant illisible au processus suivant. Le moteur n'accède au repository que via un chemin résolu/autorisé transmis dans les bindings.

Dans les deux distributions, le bookmark conserve la pérennité du binding et la trace du consentement explicite. Un ancien security-scoped bookmark devenu illisible exige une nouvelle sélection explicite ; un binding moteur ne suffit jamais à recréer une autorisation shell.

Lors d'une suppression de Project, le shell attend le succès du Local API avant de retirer le Repository Grant et de libérer l'accès security-scoped. Un échec API conserve les deux ; un échec de nettoyage après succès moteur est signalé comme résultat partiel.

## Menu bar and lifecycle

Le produit peut rester actif avec fenêtre fermée. Le menu bar affiche santé et exécutions. L'option « lancer à l'ouverture de session » est postérieure au walking skeleton mais compatible avec un `SMAppService`.

`Quit` utilise le shutdown protocol. Un crash du shell ne doit pas laisser plusieurs moteurs concurrents : lockfile/session et parent-process monitoring empêchent les doublons.

## Notifications

Notifications locales seulement pour :

- exécution terminée ;
- intervention requise ;
- projet dégradé ;
- dead letter nouvelle.

Elles contiennent projet et résumé, jamais ticket privé complet, diff ou secret.

## Packaging pipeline

Le bundle est assemblé par `scripts/build-app.sh` depuis le binaire SwiftPM et
`dist/engine/` (ADR 0013). Le script écrit aussi
`Contents/Resources/build-manifest.json` depuis l'artefact assemblé : versions
UI/Engine/API/schema/Node et commit de build, sans chemin absolu ni secret. Le
format est défini par `contracts/schemas/build-manifest.v1.schema.json`.
script assemble et ne signe pas. La chaîne du ticket 19 est portée par les
scripts suivants ; `scripts/release.sh` les orchestre dans cet ordre :

1. `pnpm run build:app` appelle [`scripts/build-app.sh`](../../scripts/build-app.sh) en profil production.
2. [`scripts/sign-app.sh`](../../scripts/sign-app.sh) signe les Mach-O imbriqués, puis `Jarvis.app`, avec hardened runtime.
3. [`scripts/smoke-bundle.sh`](../../scripts/smoke-bundle.sh) exécute `--step launch`, `--step import` et `--step recovery`.
4. [`scripts/build-dmg.sh`](../../scripts/build-dmg.sh) produit une DMG UDZO signée et vérifie son contenu monté en lecture seule.
5. [`scripts/notarize-dmg.sh`](../../scripts/notarize-dmg.sh) soumet la DMG, attend le verdict Apple, agrafe puis valide le ticket.
6. [`scripts/release.sh`](../../scripts/release.sh) compose les étapes précédentes et s'arrête au premier échec.
7. La validation Gatekeeper et l'installation restent manuelles sur un compte/machine propre après obtention d'une DMG notariée et agrafée.

Les preuves locales sont ad hoc : la signature actuelle est vérifiable avec
`codesign`, et les tests [`scripts/build-dmg.test.sh`](../../scripts/build-dmg.test.sh),
[`scripts/notarize-dmg.test.sh`](../../scripts/notarize-dmg.test.sh) et
[`scripts/release.test.sh`](../../scripts/release.test.sh) passent avec leurs
seams de test. La notarisation Apple réelle, le ticket agrafé et Gatekeeper ne
sont pas prouvés : le poste n'a ni identité Developer ID/credentials de
notarisation ni compte/machine propre. La production est donc bloquée jusqu'à
la soumission Apple acceptée, la validation `xcrun stapler validate` et le
smoke complet après installation propre.

## Update strategy

Le MVP peut distribuer manuellement de nouvelles DMG. Le format de données doit néanmoins supporter les migrations et afficher la version engine/UI. Un updater automatique est post-MVP et exige un ADR dédié.
