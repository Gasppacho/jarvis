# UX macOS

## Navigation principale

La fenêtre principale utilise une sidebar native :

```text
Jarvis
├── Projects
│   ├── Token Warehouse
│   └── Client A
├── Connections
├── Agent Runtimes
├── Module Catalog
└── Settings
```

Lorsqu'un projet est sélectionné :

```text
Overview · Graph · Modules · Executions · Events · Artifacts · Settings
```

## Premier lancement

Le premier lancement ne demande aucune configuration métier globale. Il :

1. initialise le stockage ;
2. détecte Git, `gh` et les runtimes connus ;
3. affiche l'état du moteur ;
4. propose `Import a repository`.

Les connexions peuvent être créées pendant le wizard projet ou depuis l'écran global.

## Wizard projet

### Étape 1 — Repository

L'utilisateur choisit un dossier. Jarvis obtient un security-scoped bookmark et détecte :

- repository Git ;
- remote et provider probables ;
- branche par défaut ;
- manifests de package ;
- package manager ;
- scripts disponibles ;
- fichiers d'instructions agentiques.

### Étape 2 — Écosystème

Jarvis propose sans imposer :

- commandes install, lint, typecheck, test, build ;
- convention de branche ;
- remote de push ;
- nombre maximal d'exécutions concurrentes.

### Étape 3 — Ressources

L'utilisateur lie :

- slot `sourceControl` ;
- slot `tickets` ;
- slot `agentRuntime` ;
- MCP optionnels.

Une ressource globale n'est pas visible des agents du projet sans ce binding.

### Étape 4 — Modules

Pour le template GitHub Development :

```text
[✓] GitHub
[✓] Automation Rules
[✓] Development
[ ] Change Request Review
[ ] Auto Merge
```

### Étape 5 — Validation

Jarvis affiche :

- contrats compatibles ;
- requests résolues ;
- capabilities satisfaites ;
- accès au repository ;
- connexion au provider ;
- runtime disponible ;
- commandes valides.

Un projet invalide peut être sauvegardé mais pas activé.

## Overview projet

Affiche :

- statut actif/inactif/dégradé ;
- dernière activité ;
- exécutions en cours ;
- requests sans consommateur ;
- dead letters ;
- liens repository et provider ;
- actions `Pause`, `Validate`, `Run diagnostics`.

## Graphe émergent

Le graphe est dérivé des manifests et instances actives. Il n'est pas un éditeur de workflow impératif.

```text
[GitHub]
    └─ scm.work-item.tag-added
           ↓
[Automation Rules]
    └─ development.implementation.requested
           ↓
[Development]
    └─ scm.change-request.creation-requested
           ↓
[GitHub]
    └─ scm.change-request.created
```

États visuels :

- chemin valide ;
- request orpheline ;
- plusieurs consommateurs illégaux ;
- module désactivé ;
- contrat incompatible.

## Executions

Liste filtrable par projet, module, statut et corrélation. Une fiche affiche :

- input event ;
- module instance ;
- début, durée et tentative ;
- étapes de loop ;
- sorties publiées ;
- logs structurés et flux agentique ;
- workspace et artefacts ;
- action d'annulation lorsque possible ;
- diagnostic de l'échec.

## Events

La timeline montre requests et facts avec une distinction visuelle claire. Chaque événement affiche :

- type/version/kind ;
- producer ;
- consumer(s) ;
- correlation/causation ;
- subject ;
- payload nettoyé ;
- état de livraison et retries.

## Menu bar

L'icône de menu bar expose :

- état du moteur ;
- nombre d'exécutions actives ;
- pause globale ;
- projets actifs ;
- ouverture de la fenêtre ;
- quitter Jarvis.

Fermer la fenêtre ne quitte pas le produit lorsque le mode menu bar est actif. `Quit Jarvis` arrête proprement les projets puis le moteur.

## Erreurs

Toute erreur visible doit répondre à trois questions :

1. Qu'est-ce qui est indisponible ?
2. Quel comportement est impacté ?
3. Quelle action précise peut corriger la situation ?

Exemple :

```text
Codex runtime unavailable
Development cannot start for Token Warehouse.
Reconnect the runtime or bind another runtime in Project Settings.
```
