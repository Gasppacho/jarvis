# Testing Strategy

## Primary test seam

Le seam principal est l'API locale d'un **Application Harness** qui démarre le vrai moteur avec :

- SQLite temporaire réelle ;
- manifests et modules réels ;
- repository Git temporaire et remote bare ;
- Fake Agent Runtime ;
- Fake GitHub Adapter ;
- clock et ID generator contrôlables ;
- mêmes endpoints que le shell macOS.

Ce seam couvre le plus de comportement avec le moins de mocks et reste assez rapide pour TDD.

## Test layers

### Contract tests

- Valider JSON Schemas eux-mêmes.
- Valider tous les exemples.
- Compatibilité backward des événements v1.
- OpenAPI lint et génération Swift/TypeScript.
- Manifest declares every emitted event.

### Domain/application tests

Pour invariants locaux difficiles à exprimer uniquement en E2E : rules matching, retry classification, branch naming, cycle limits, project validation.

### Integration tests

- SQLite transactions, Inbox/Outbox et crash recovery.
- Git worktree/commit/push avec vrais repositories temporaires.
- Process supervisor avec fake child executable.
- Runtime adapters avec fake CLI process.
- GitHub adapter avec HTTP fake et test sandbox optionnel.

### Architecture tests

- Import graph autorisé.
- Aucun module → module.
- Aucun Kernel → module concret.
- Aucun accès direct aux repositories de persistence d'un autre context.
- Project scope obligatoire dans APIs internes.

### macOS tests

- XCTest du Engine Supervisor, Keychain abstraction et client API.
- View model tests avec client fake généré.
- XCUITest du premier lancement, import fixture, activation et lecture timeline.
- Smoke test sur app signée/notariée.

## Reference E2E scenario

1. Créer fixture repo avec API minimale et tests.
2. Créer remote Git bare local.
3. Importer project config GitHub Development avec adapters fake.
4. Activer projet.
5. Injecter `scm.work-item.tag-added` pour `agent:ready`.
6. Attendre `scm.change-request.created` par API.
7. Vérifier branche distante, commit, tests, idempotency et timeline.
8. Redémarrer moteur et vérifier persistance.
9. Réinjecter la request PR et vérifier qu'une seule Change Request existe.

## TDD cadence

Pour chaque ticket :

1. écrire ou étendre un test au seam le plus haut ;
2. observer l'échec pour la bonne raison ;
3. implémenter le minimum vertical ;
4. garder typecheck et test ciblé rapides ;
5. ajouter des tests plus bas uniquement pour une branche difficile ;
6. suite complète ;
7. `/code-review` ;
8. commit.

## Test doubles

- `FakeAgentRuntime` : script de modifications déterministe.
- `FakeGitHubAdapter` : store in-memory/persisté de Work Items et Change Requests.
- `ControllableClock` et `DeterministicIdGenerator`.
- `Failpoint` persistence pour simuler crash aux frontières transactionnelles.

Ne pas mocker SQLite, Git ou Eventing dans le test principal.

## CI gates

- formatting ;
- TypeScript typecheck ;
- Swift build/test ;
- unit/integration tests ;
- schema/example validation ;
- OpenAPI generation diff clean ;
- architecture rules ;
- license/security scan ;
- packaging smoke sur branche release.
