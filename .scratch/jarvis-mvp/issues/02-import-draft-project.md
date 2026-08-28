# Ticket 02 — Import a repository as a draft project

**Phase :** A — Product walking skeleton
**Label de triage :** `ready-for-agent`
**Blockers :** ticket 01 (walking skeleton, API locale et persistence disponibles).

## Résultat observable

Depuis Jarvis, l'utilisateur choisit un dossier local avec le sélecteur natif macOS.
Jarvis inspecte le repository sans le modifier, propose une configuration détectée
(remote, branche par défaut, package manager, commandes probables) et enregistre un
projet à l'état `draft`. Le projet apparaît dans la liste et reste consultable.

## Tranche verticale traversée

```text
NSOpenPanel → ProjectsModel → POST /v1/discovery/repository
  → lecture read-only de .git/config, .git/HEAD, lockfiles, package.json
  → POST /v1/projects → SQLite (projects + project_bindings)
  → GET /v1/projects, GET /v1/projects/{projectId} → liste et détail natifs
```

## Critères d'acceptation

1. `POST /v1/discovery/repository` renvoie un `RepositoryDiscovery` valide selon l'OpenAPI.
2. La discovery détecte : présence Git, remote, provider, branche par défaut,
   package manager et scripts du projet.
3. La discovery **ne modifie rien** dans le repository inspecté et n'exécute **aucun**
   script du projet.
4. Un chemin inexistant, relatif ou non-dossier est refusé avec l'enveloppe d'erreur.
5. `POST /v1/projects` crée un projet `draft` et renvoie `201` + `ProjectDetail`.
6. Le chemin absolu du repository vit dans les **bindings locaux**, jamais dans la
   configuration portable. Aucun chemin absolu, aucun secret dans `portableConfig`.
7. Réimporter le même repository échoue avec un code d'erreur stable plutôt que de
   créer un doublon silencieux.
8. Une `portableConfig` fournie et non conforme au schéma est refusée avec le chemin
   du schéma en cause, sans recopier de valeur sensible.
9. Un repository contenant déjà `.jarvis/project.yaml` voit ce fichier adopté et validé.
10. `GET /v1/projects` liste les projets ; `GET /v1/projects/{projectId}` renvoie le
    détail ; un identifiant inconnu renvoie `404` avec l'enveloppe d'erreur.
11. Les projets survivent à un redémarrage du moteur.
12. L'application macOS permet de choisir un dossier, lance l'import et affiche la
    liste des projets avec leur état.

## Test seam

**Seam principal :** l'Application Harness du ticket 01, étendu avec un repository Git
temporaire réel (`.git/config`, `.git/HEAD`, `package.json`, lockfile). Aucun mock de
système de fichiers, aucun mock SQLite.

**Seam secondaire :** XCTest du modèle de projets contre le moteur réel.

Écrire d'abord le test au seam principal et l'observer échouer.

## Sources de vérité à lire

- `docs/architecture/PROJECTS.md` — import flow, portable config vs bindings, états
- `docs/architecture/PERSISTENCE.md` — tables, ownership, scoping par `project_id`
- `contracts/schemas/project-config.v1.schema.json` et `project-bindings.v1.schema.json`
- `contracts/openapi/local-api.v1.yaml` — discovery et projects
- `docs/product/UX.md` — wizard projet, étapes 1 et 2
- `docs/product/MVP_SPEC.md` — user stories 4 à 6

## Contradictions relevées

- `PROJECTS.md` « Import flow » étape 8 dit que le projet est sauvegardé `inactive`,
  mais la machine à états du même document et l'enum `ProjectSummary.status` de
  l'OpenAPI ne connaissent pas `inactive` (seul `ModuleInstance.status` l'a).
  Ce ticket retient `draft`, conformément à `IMPLEMENTATION_SEQUENCE.md`.
- Le ticket 01 a créé la base sous `jarvis.db` alors que `PERSISTENCE.md` impose
  `jarvis.sqlite`. Ce ticket corrige le nom avant que le ticket 03 ne s'appuie dessus.

## Hors périmètre

- Slots, connexions, runtimes et bindings de ressources (tickets 05, 12, 13).
- Modules et catalogue (tickets 04 et 05).
- `Validate` et `Activate`, donc les états `valid` / `active` (ticket 05).
- Écriture de `.jarvis/project.yaml` dans le repository (`PUT .../configuration`).
- Security-scoped bookmarks durables : le schéma prévoit `bookmarkRef`, mais le
  stockage du bookmark appartient au ticket 03 avec la restauration après redémarrage.
- Détection des CLI externes via un login shell.
