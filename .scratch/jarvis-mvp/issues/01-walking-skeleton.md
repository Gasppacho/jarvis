# Ticket 01 — Swift app launches engine and displays health

**Phase :** A — Product walking skeleton
**Label de triage :** `ready-for-agent`
**Blockers :** aucun. Ce ticket est la racine du chemin critique.

## Résultat observable

Un utilisateur lance l'application macOS Jarvis. L'application démarre le moteur TypeScript
embarqué comme processus enfant, s'authentifie sur son API locale et affiche un état de santé
lisible : version du moteur, version d'API et état de la base. Si le moteur ne démarre pas,
l'écran affiche une erreur actionnable au lieu d'un état vide.

## Tranche verticale traversée

```text
SwiftUI View → HealthModel → EngineSupervisor → spawn(node engine.bundle.mjs)
  → handshake ready sur stdout → HTTP loopback + bearer → Fastify /v1/health
  → SQLite WAL + migrations → HealthResponse
```

Aucune couche n'est construite « en entier » : uniquement ce que `GET /v1/health` exige.

## Critères d'acceptation

1. `pnpm install`, `pnpm generate`, `pnpm contracts:check`, `pnpm lint`, `pnpm typecheck`,
   `pnpm test`, `pnpm test:integration`, `pnpm build:engine` et `pnpm verify` existent et passent.
2. Le moteur bind `127.0.0.1` sur un port dynamique et n'accepte aucun host non-loopback.
3. Le moteur écrit exactement une ligne JSON `{"type":"ready","port":…,"apiVersion":"v1","sessionId":…}`
   sur stdout, puis plus rien sur stdout.
4. `GET /v1/health` sans bearer token répond `401` avec l'enveloppe d'erreur du contrat.
5. `GET /v1/health` avec le bon token répond `200` et un corps valide selon
   `HealthResponse` (`status`, `engineVersion`, `apiVersion: "v1"`, `database`).
6. La base SQLite est ouverte en WAL, ses migrations sont appliquées avant l'annonce `ready`,
   et `database` reflète cet état.
7. `JARVIS_DATA_ROOT` isole totalement les données ; aucun test n'écrit dans
   `~/Library/Application Support`.
8. `POST /v1/system/shutdown` répond `202` puis le processus sort avec le code `0`.
9. L'application macOS compile, lance le moteur, appelle `/v1/health` via un client généré
   depuis `contracts/openapi/local-api.v1.yaml` et affiche le résultat.
10. Un échec de démarrage du moteur produit un message d'erreur affichant cause et action.
11. `contracts:check` échoue si un schéma, un exemple, un manifeste ou l'OpenAPI est invalide.
12. Le graphe d'imports interdit `module → module` et est vérifié en CI.

## Test seam

**Seam principal (TypeScript) :** Application Harness local. Il démarre le vrai binaire moteur
avec une SQLite temporaire réelle et un `JARVIS_DATA_ROOT` jetable, lit le handshake `ready`,
et pilote le système par la même API locale que le shell macOS. Pas de mock HTTP, pas de mock SQLite.

**Seam secondaire (Swift) :** XCTest de `EngineSupervisor` + client généré, lancé contre le
bundle moteur réellement construit. Il prouve la traversée Swift → processus → HTTP → TypeScript.

Écrire d'abord le test du seam principal, l'observer échouer pour la bonne raison, puis implémenter.

## Sources de vérité à lire

- `docs/architecture/SYSTEM.md` — startup/shutdown protocol, dependency rules, repository shape
- `docs/architecture/TECHNOLOGY_STACK.md` — versions baseline à épingler dans ce ticket
- `docs/architecture/MACOS_APP.md` — structure Swift, bundle moteur, client API
- `docs/contracts/LOCAL_API_V1.md` + `contracts/openapi/local-api.v1.yaml` — contrat `/v1/health`
- `docs/engineering/LOCAL_DEVELOPMENT.md` — commandes racine à rendre réelles
- `docs/engineering/CONTRACT_VALIDATION.md` — contenu de `contracts:check`
- `docs/architecture/TESTING.md` — cadence TDD et couches de test
- `docs/agents/coding-standards.md`
- ADR 0006, 0007, 0008

## Hors périmètre

- Import de projet, discovery, persistence de projets (ticket 02 et 03).
- Modules, Event Bus, Execution Ledger (phases B et C).
- SSE `/v1/stream` : le contrat existe mais aucun consommateur n'existe avant le ticket 07.
- Signature, notarisation et DMG (ticket 19).
- Kysely : le ticket 01 n'émet aucune requête applicative.
- `packages/persistence` et `packages/local-api` : extraits quand un second consommateur existe.
  Créer des packages vides contredirait la règle de prefactoring.

## Décisions à enregistrer

Toute décision structurante prise ici (forme du build macOS, protocole de handshake)
exige un ADR avant le commit.
