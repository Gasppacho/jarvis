# Jarvis — Architecture modulaire event-driven

> **Statut :** architecture cible et contrat d’implémentation v1  
> **Document parent :** [`CONTEXT.md`](./CONTEXT.md)  
> **Style :** DDD modulaire, architecture hexagonale, modular monolith initial, chorégraphie événementielle

## 1. Objectif

Ce document transforme la vision de Jarvis en une architecture suffisamment précise pour guider l’implémentation du Kernel, du Module SDK et des premiers modules.

Les mots **DOIT**, **NE DOIT PAS**, **DEVRAIT** et **PEUT** expriment respectivement une exigence, une interdiction, une recommandation forte et une possibilité.

---

## 2. Vue d’ensemble

```text
┌────────────────────────────────────────────────────────────────────┐
│                         JARVIS DESKTOP / UI                        │
│ Modules · Graphe · Exécutions · Événements · Connexions · Logs   │
└───────────────────────────────┬────────────────────────────────────┘
                                │ Local API / WebSocket / IPC
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│                         JARVIS KERNEL                              │
│                                                                    │
│ Module Host            Event Bus             Contract Registry    │
│ Execution Runtime      Inbox / Outbox         Execution Ledger     │
│ Connection Registry    Capability Runtime    Workspace Manager    │
│ Agent Runtime          Artifact Store         Secrets Runtime      │
│ Observability          Scheduler technique   Health / Diagnostics │
└───────────────────────────────┬────────────────────────────────────┘
                                │ Module SDK uniquement
       ┌────────────────────────┼──────────────────────────┐
       ▼                        ▼                          ▼
┌───────────────┐       ┌──────────────────┐       ┌──────────────────┐
│ GitHub Module │       │ Development      │       │ PR Review Module │
│               │       │ Module           │       │                  │
│ Domain        │       │ Domain           │       │ Domain           │
│ Handlers      │       │ Loop             │       │ Loop             │
│ Adapters      │       │ Agents / Tools   │       │ Agents / Tools   │
│ State         │       │ State            │       │ State            │
└───────────────┘       └──────────────────┘       └──────────────────┘
       ▲                        ▲                          ▲
       └──────────── événements d’intégration ────────────┘
```

Le Kernel est un runtime technique. Les modules possèdent la logique métier.

---

## 3. Style architectural

### 3.1 Modular monolith strict pour le MVP

Le MVP DEVRAIT être livré comme un seul daemon local afin de réduire la complexité opérationnelle, tout en imposant des frontières de packages identiques à celles de futurs services séparés.

```text
Processus jarvisd
├── Kernel
├── Module GitHub
├── Module Automation Rules
├── Module Development
├── Module Change Request Review
└── Module Auto Merge
```

Chaque module :

- possède son package ;
- expose uniquement son manifest et son point d’entrée ;
- ne dépend que du Module SDK et de contrats explicitement autorisés ;
- possède ses repositories de domaine ;
- ne partage pas ses services applicatifs avec d’autres modules.

Le transport et le stockage sont abstraits afin qu’un module puisse plus tard être exécuté dans un processus ou une machine distincte sans modifier son domaine.

### 3.2 DDD et bounded contexts

Exemples de bounded contexts :

- `kernel` ;
- `scm-github` ;
- `scm-gitlab` ;
- `automation-rules` ;
- `ticket-refinement` ;
- `bug-resolution` ;
- `development` ;
- `change-request-review` ;
- `ci-observer` ;
- `ci-fix` ;
- `auto-merge` ;
- `notification`.

Les modèles internes ne sont pas mutualisés. Par exemple, `GitHubPullRequest` appartient au module GitHub, tandis que les autres modules manipulent une référence canonique `ChangeRequestRef` dans les événements d’intégration.

### 3.3 Architecture hexagonale interne à chaque module

```text
module/
├── domain/
│   ├── entities/
│   ├── value-objects/
│   ├── aggregates/
│   ├── domain-services/
│   └── domain-events/
├── application/
│   ├── handlers/
│   ├── use-cases/
│   ├── ports/
│   └── dto/
├── infrastructure/
│   ├── persistence/
│   ├── mcp/
│   ├── cli/
│   ├── api/
│   └── providers/
├── agentic/
│   ├── loops/
│   ├── agents/
│   ├── prompts/
│   ├── skills/
│   └── tools/
├── contracts/
│   ├── consumed-events/
│   └── produced-events/
├── module.manifest.yaml
└── index.ts
```

Un module purement déterministe peut ne pas avoir de dossier `agentic/`. Un module agentique peut embarquer plusieurs loops et agents.

---

## 4. Invariants d’architecture

Le code DOIT respecter les contraintes suivantes :

1. Aucun import applicatif direct entre deux modules.
2. Aucun appel synchrone de module à module.
3. Aucun accès à la base privée d’un autre module.
4. Aucun contrat intermodule non versionné.
5. Aucun séquencement métier caché dans le Kernel.
6. Aucune reprise d’une ancienne loop à la réception d’un webhook externe.
7. Aucune création de PR/MR ou merge spontané par un provider.
8. Aucun secret dans un événement, un prompt persisté ou un artefact public.
9. Toute request potentiellement redélivrée DOIT être idempotente.
10. Toute émission DOIT être validée par rapport au manifest et au schéma du contrat.
11. Tout module agentique DOIT produire un résultat structuré validable, même si ses logs restent en texte libre.
12. Les opérations concurrentes sur un repository DOIVENT utiliser des workspaces isolés.

Ces invariants DEVRAIENT être vérifiés par des tests d’architecture automatisés.

---

## 5. Le contrat d’un module

### 5.1 Manifest v1

Chaque package module expose un `module.manifest.yaml`.

```yaml
apiVersion: jarvis.dev/v1
kind: Module

metadata:
  id: jarvis.development
  version: 1.0.0
  displayName: Development
  description: Implémente, teste, committe et pousse le changement décrit par un ticket prêt.

runtime:
  mode: agentic
  entrypoint: dist/index.js
  isolation: in-process

subscriptions:
  - event: development.implementation.requested
    version: 1
    handler: handleImplementationRequested
    delivery: at-least-once

publications:
  - event: development.implementation.completed
    version: 1
    kind: fact
  - event: development.implementation.failed
    version: 1
    kind: fact
  - event: scm.change-request.creation-requested
    version: 1
    kind: request

capabilities:
  required:
    - workspace.allocate
    - repository.read
    - repository.write
    - git.branch.create
    - git.commit
    - git.push
    - shell.execute
    - tickets.read
  optional:
    - browser.navigate
    - documentation.search

connections:
  slots:
    - name: scm
      accepts:
        - github
        - gitlab
    - name: agentRuntime
      accepts:
        - codex-cli
        - claude-code
        - local-model

agentic:
  loops:
    - id: implement-ticket
      path: agentic/loops/implement-ticket.yaml
  agents:
    - planner
    - developer
    - tester
    - reviewer

configuration:
  schema: schemas/config.schema.json
  defaults:
    baseBranch: main
    branchPrefix: agent/ticket
    maxInternalAttempts: 3

permissions:
  emit:
    - development.implementation.completed@1
    - development.implementation.failed@1
    - scm.change-request.creation-requested@1
  secrets:
    - git-credential
  filesystem:
    scopes:
      - allocated-workspace
```

### 5.2 Point d’entrée

Le point d’entrée public d’un module expose uniquement une factory conforme au SDK.

```typescript
export interface JarvisModuleFactory {
  manifest(): ModuleManifest;
  create(context: ModuleBootstrapContext): Promise<JarvisModule>;
}

export interface JarvisModule {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<ModuleHealth>;
}
```

Les handlers sont enregistrés à partir du manifest. Ils ne sont pas appelables directement depuis un autre module.

### 5.3 Module Instance

Le package définit le comportement ; l’instance définit son activation concrète.

```yaml
apiVersion: jarvis.dev/v1
kind: ModuleInstance

metadata:
  id: development-token-warehouse

spec:
  module: jarvis.development@1.0.0
  enabled: true
  scope:
    projectIds:
      - token-warehouse
  connections:
    scm: github-qservices
    agentRuntime: codex-local
  configuration:
    baseBranch: main
    testCommand: pnpm test
```

Une instance peut filtrer les événements par projet, repository, environnement ou metadata.

---

## 6. Modèle d’événement

### 6.1 Enveloppe canonique

Tous les événements globaux utilisent la même enveloppe.

```json
{
  "id": "evt_01K4Y7M0BR8D7N4Q8M1VZ6Q0XK",
  "type": "scm.change-request.created",
  "version": 1,
  "kind": "fact",
  "occurredAt": "2026-08-26T21:20:00.000Z",

  "producer": {
    "moduleId": "jarvis.scm.github",
    "moduleInstanceId": "github-qservices"
  },

  "scope": {
    "tenantId": "default",
    "projectId": "token-warehouse",
    "environment": "default"
  },

  "subject": {
    "type": "scm.change-request",
    "ref": "github://github-qservices/QServices/token-warehouse/pull/57"
  },

  "correlationId": "corr_issue_42_development_1",
  "causationId": "evt_creation_requested_01K4Y7...",
  "traceId": "trace_01K4Y7...",

  "target": {
    "connectionId": "github-qservices"
  },

  "idempotencyKey": "github-qservices:token-warehouse:head:agent/ticket-42",
  "payload": {},
  "metadata": {
    "schema": "jarvis://contracts/scm.change-request.created/1",
    "generation": 1
  }
}
```

### 6.2 Champs obligatoires

| Champ | Rôle |
|---|---|
| `id` | Identifiant unique et clé de déduplication. |
| `type` | Nom canonique du contrat. |
| `version` | Version majeure du payload. |
| `kind` | `fact` ou `request`. |
| `occurredAt` | Date UTC du fait ou de la demande. |
| `producer` | Module ayant publié l’événement. |
| `scope` | Projet et périmètre de routage. |
| `correlationId` | Parcours distribué auquel appartient l’événement. |
| `causationId` | Événement ayant causé celui-ci. |
| `payload` | Données contractuelles versionnées. |

### 6.3 Request Events et Fact Events

#### Request Event

Une request représente une intention à exécuter.

```text
scm.change-request.creation-requested
scm.change-request.review-publication-requested
scm.change-request.merge-requested
work-item.update-requested
notification.sending-requested
```

Règles :

- elle DOIT être ciblable vers une instance ou une connexion ;
- elle DOIT fournir une `idempotencyKey` lorsqu’elle provoque un side-effect ;
- son nom DOIT indiquer qu’il s’agit d’une demande ;
- elle ne DOIT jamais être interprétée comme la preuve de réussite de l’action.

#### Fact Event

Un fact représente un fait accompli ou observé.

```text
scm.change-request.created
scm.change-request.creation-failed
scm.change-request.review-published
scm.change-request.merged
```

Règles :

- il PEUT être consommé par zéro, un ou plusieurs modules ;
- il ne nécessite pas de destinataire unique ;
- il DEVRAIT transporter les références vers les ressources créées ou observées.

### 6.4 Nommage

Format recommandé :

```text
<context>.<aggregate>.<event>
```

Exemples :

```text
scm.work-item.tag-added
development.implementation.requested
development.implementation.completed
scm.change-request.creation-requested
scm.change-request.created
scm.change-request.review-publication-requested
scm.change-request.review-published
scm.change-request.merge-requested
scm.change-request.merged
ci.checks.completed
ci.checks.passed
ci.checks.failed
```

La version n’est pas incluse dans le nom ; elle réside dans le champ `version` et dans l’URI de schéma.

### 6.5 Contrats et schémas

Chaque événement public DOIT avoir un schéma JSON versionné dans un package de contrats.

```text
packages/contracts/
└── scm/
    └── change-request/
        ├── creation-requested/
        │   └── v1.schema.json
        ├── created/
        │   └── v1.schema.json
        └── merge-requested/
            └── v1.schema.json
```

Le registre de contrats conserve :

- le schéma ;
- le propriétaire du contrat ;
- les versions supportées ;
- les producteurs déclarés ;
- les consommateurs déclarés ;
- les règles de compatibilité.

Un changement backward-compatible incrémente la version du package. Un changement incompatible crée une nouvelle version majeure du contrat.

### 6.6 Références canoniques

Les événements ne transportent pas un modèle fournisseur complet. Ils transportent des références opaques et stables.

```typescript
interface RepositoryRef {
  connectionId: string;
  provider: "github" | "gitlab" | string;
  externalId: string;
  cloneUrl?: string;
}

interface WorkItemRef {
  connectionId: string;
  repositoryRef: RepositoryRef;
  externalId: string;
}

interface ChangeRequestRef {
  connectionId: string;
  repositoryRef: RepositoryRef;
  externalId: string;
  url?: string;
}
```

Les autres modules peuvent utiliser la connexion globale correspondante pour résoudre les détails nécessaires.

---

## 7. Routage

### 7.1 Routage des facts

Un fact est diffusé à toutes les subscriptions actives dont :

- le type et la version correspondent ;
- le scope correspond ;
- les filtres déclaratifs correspondent ;
- le module est activé et sain.

Il est valide qu’aucun module ne consomme un fact.

### 7.2 Routage des requests

Une request DEVRAIT avoir un seul exécuteur dans son scope.

Le ciblage peut utiliser :

1. `target.moduleInstanceId` pour une instance précise ;
2. `target.connectionId` pour le module lié à une connexion ;
3. un selector de capability si aucune cible explicite n’est connue.

Exemple pour la création de PR :

```json
{
  "type": "scm.change-request.creation-requested",
  "kind": "request",
  "target": {
    "connectionId": "github-qservices"
  },
  "payload": {
    "repositoryRef": {
      "connectionId": "github-qservices",
      "provider": "github",
      "externalId": "QServices/token-warehouse"
    },
    "baseBranch": "main",
    "headBranch": "agent/ticket-42"
  }
}
```

Le Connection Registry sait que `github-qservices` est géré par l’instance `github-qservices` du module `jarvis.scm.github`.

### 7.3 Requests non prises en charge

Si aucune instance ne sait traiter une request :

- l’événement reste conservé ;
- son état devient `unhandled` ;
- une alerte apparaît dans les diagnostics et dans le graphe ;
- aucun comportement de fallback métier n’est déclenché par le Kernel.

Si plusieurs instances prétendent être l’exécuteur unique sans ciblage suffisant :

- la request devient `routing-conflict` ;
- aucun side-effect n’est exécuté ;
- l’utilisateur ou un module de configuration doit résoudre l’ambiguïté.

### 7.4 Filtres d’abonnement

Les manifests peuvent déclarer des filtres simples :

```yaml
subscriptions:
  - event: scm.work-item.tag-added
    version: 1
    handler: handleTagAdded
    filters:
      - path: scope.projectId
        operator: in
        value:
          - token-warehouse
      - path: payload.tag
        operator: equals
        value: agent:ready
```

Les règles complexes appartiennent à un module de décision ou de routage, pas au Kernel.

---

## 8. Fiabilité du bus

### 8.1 Garantie de livraison

Le bus initial fournit une livraison **at-least-once**.

Il en découle que :

- les handlers DOIVENT être idempotents ;
- les side-effects externes DOIVENT utiliser une clé d’idempotence ou un mécanisme de réconciliation ;
- un event peut être redélivré après un crash.

### 8.2 Inbox

Chaque module instance conserve les événements déjà traités.

```text
module_inbox
├── module_instance_id
├── event_id
├── received_at
├── processed_at
├── status
└── attempt
```

Avant d’exécuter un handler, le runtime vérifie l’Inbox. Un événement `completed` n’est pas retraité.

### 8.3 Outbox

Les événements produits sont écrits dans une Outbox au cours de la même transaction logique que la mise à jour d’état du module.

```text
Traitement event
   ├── mise à jour domaine
   ├── enregistrement résultat
   └── écriture événements Outbox
             ↓
       transaction validée
             ↓
       dispatcher Outbox
```

Une exécution ne doit pas être marquée `completed` si ses événements sortants ne sont pas durablement enregistrés.

### 8.4 Retries et dead-letter

Chaque subscription configure :

```yaml
retry:
  maxAttempts: 5
  strategy: exponential
  initialDelayMs: 1000
  maxDelayMs: 60000

deadLetter:
  enabled: true
```

Après épuisement :

- l’exécution passe à `dead-lettered` ;
- l’événement et l’erreur restent inspectables ;
- un fait technique `kernel.execution.dead-lettered` peut être publié ;
- la reprise manuelle crée une nouvelle tentative traçable.

### 8.5 Ordre

Le système ne garantit pas un ordre global.

Lorsque l’ordre est nécessaire, les événements utilisent une partition logique :

```text
partitionKey = repositoryRef + changeRequestRef
```

Un module de décision tel qu’Auto Merge ne doit pas supposer que `review-approved` arrivera avant `checks-passed`. Il stocke les faits reçus puis évalue sa condition après chaque mise à jour.

### 8.6 Prévention des cycles infinis

Les événements conservent :

- `correlationId` ;
- `causationId` ;
- `metadata.generation` ;
- éventuellement `payload.attempt`.

Les modules réactifs DEVRAIENT imposer une limite de génération ou de tentatives lorsqu’un cycle est possible.

---

## 9. Cycle d’exécution d’un module

```text
QUEUED
  │
  ▼
DELIVERED
  │ Inbox + validation
  ▼
RUNNING
  │
  ├── handler déterministe
  ├── loop agentique
  ├── tools / connections
  └── état privé
  │
  ▼
COMMITTING
  │ état + résultat + outbox
  ▼
COMPLETED
```

États d’échec :

```text
RETRY_SCHEDULED
FAILED
DEAD_LETTERED
CANCELLED
TIMED_OUT
```

### 9.1 Pas d’attente externe dans la loop

Un module peut attendre :

- un processus local ;
- une réponse de modèle ;
- une commande de test ;
- un appel API nécessaire à son travail local.

Il ne doit pas rester en état `waiting_external` dans l’attente d’un webhook destiné à poursuivre un workflow intermodule.

Exemple interdit :

```text
DevelopmentLoop → create PR → wait CI webhook → resume DevelopmentLoop
```

Exemple attendu :

```text
Development execution → push → emit PR creation request → completed
GitHub execution → create PR → emit PR created → completed
CI Observer execution → emit CI failed → completed
CI Fix execution → correct + push → completed
```

### 9.2 Résultat structuré

Une loop agentique DOIT produire un output conforme à un schéma du module.

```typescript
interface DevelopmentLoopResult {
  outcome: "implemented" | "blocked" | "failed";
  branch?: string;
  headSha?: string;
  commits?: string[];
  tests: {
    command: string;
    status: "passed" | "failed" | "skipped";
    artifactRef?: string;
  }[];
  summary: string;
  confidence: number;
  artifacts: string[];
}
```

Le handler applicatif transforme ce résultat en domain events puis en integration events. Un agent ne peut pas publier un type arbitraire non déclaré dans le manifest.

---

## 10. Kernel

### 10.1 Module Host

Responsabilités :

- découvrir les packages modules ;
- valider les manifests ;
- installer et migrer une version ;
- créer des instances ;
- démarrer et arrêter les instances ;
- exposer leur santé ;
- appliquer les scopes et permissions ;
- enregistrer subscriptions et publications.

Le Module Host ne connaît pas le domaine des modules.

### 10.2 Event Bus

Responsabilités :

- accepter des événements validés ;
- les persister ;
- calculer les destinataires ;
- livrer de façon durable ;
- gérer retries, dead-letter et acknowledgements ;
- exposer les streams d’observabilité.

Le transport est derrière un port :

```typescript
export interface EventTransport {
  publish(event: IntegrationEvent): Promise<void>;
  subscribe(subscription: RuntimeSubscription): AsyncIterable<EventDelivery>;
  acknowledge(deliveryId: string): Promise<void>;
  reject(deliveryId: string, error: SerializedError): Promise<void>;
}
```

### 10.3 Contract Registry

Responsabilités :

- enregistrer les schémas ;
- valider payloads et versions ;
- vérifier que le module publie uniquement des contrats déclarés ;
- détecter les requests sans exécuteur ;
- produire le graphe statique des dépendances événementielles.

### 10.4 Execution Ledger

Le Ledger conserve une ligne par traitement module/événement.

```typescript
interface ModuleExecutionRecord {
  id: string;
  moduleId: string;
  moduleInstanceId: string;
  inputEventId: string;
  correlationId: string;
  status: ExecutionStatus;
  startedAt?: string;
  completedAt?: string;
  attempt: number;
  outputEventIds: string[];
  artifactRefs: string[];
  error?: SerializedError;
  metrics?: Record<string, number>;
}
```

Il permet de reconstituer la timeline sans devenir un orchestrateur.

### 10.5 Connection Registry

Le registre centralise les connexions globales :

```typescript
interface ConnectionDescriptor {
  id: string;
  type: string;
  provider: string;
  displayName: string;
  capabilities: string[];
  secretRefs: string[];
  metadata: Record<string, unknown>;
  health: "healthy" | "degraded" | "offline";
}
```

Exemples :

```text
github-qservices       provider=github
gitlab-client-a        provider=gitlab
codex-local            provider=codex-cli
jira-company           provider=jira
browser-default        provider=browser
```

Les modules reçoivent des handles temporaires. Les secrets bruts ne leur sont pas exposés si une délégation ou un proxy est possible.

### 10.6 Capability Runtime

Les capacités sont globalement disponibles mais explicitement déclarées par chaque module.

Catégories :

```text
Agent runtimes
  agent.codex-cli
  agent.claude-code
  agent.local-model

Repository / workspace
  repository.read
  repository.write
  workspace.allocate
  workspace.release

Git
  git.status
  git.branch.create
  git.commit
  git.push
  git.diff

External connections
  tickets.read
  tickets.write
  scm.change-request.create
  scm.change-request.review
  scm.change-request.merge

General tools
  shell.execute
  browser.navigate
  documentation.search
  artifact.read
  artifact.write
```

Le Kernel applique une sécurité technique : un module ne reçoit que les capacités déclarées et accordées à son instance. Cette couche n’implémente aucune règle métier telle que « merger uniquement si la review est approuvée ».

### 10.7 Workspace Manager

Le Workspace Manager évite que deux loops agentiques modifient le même working tree.

Responsabilités :

- résoudre ou cloner un repository ;
- allouer un workspace isolé ;
- privilégier `git worktree` lorsque possible ;
- verrouiller les ressources ;
- injecter les credentials Git de l’hôte ;
- nettoyer ou archiver le workspace ;
- conserver le mapping entre exécution, branche et repository.

```typescript
interface WorkspaceLease {
  id: string;
  executionId: string;
  repositoryRef: RepositoryRef;
  path: string;
  baseBranch: string;
  expiresAt: string;
}
```

### 10.8 Artifact Store

Le bus ne transporte pas de contenu volumineux.

```typescript
interface ArtifactDescriptor {
  ref: string;
  mediaType: string;
  size: number;
  checksum: string;
  createdByExecutionId: string;
  retentionPolicy: string;
  metadata: Record<string, unknown>;
}
```

Exemples :

```text
artifact://development/corr-ticket-42/analysis.md
artifact://tests/run-842/result.json
artifact://reviews/pr-57/review.md
artifact://logs/execution-281/stdout.txt
```

### 10.9 Agent Runtime

Le Kernel expose un port commun vers Codex, Claude Code ou un modèle local.

```typescript
interface AgentRuntime {
  id: string;
  capabilities: AgentRuntimeCapabilities;
  execute(request: AgentExecutionRequest): Promise<AgentExecutionResult>;
  cancel(executionId: string): Promise<void>;
}

interface AgentExecutionRequest {
  executionId: string;
  workspace?: WorkspaceLease;
  instructions: string;
  input: unknown;
  tools: ToolGrant[];
  connections: ConnectionGrant[];
  outputSchema: JsonSchema;
  limits: {
    timeoutMs: number;
    maxCost?: number;
    maxIterations?: number;
  };
}
```

Le module choisit un profil logique ; le runtime résout le provider concret selon la configuration de l’instance ou du projet.

---

## 11. Connexions globales, MCP et accès aux tickets

### 11.1 Principe

Les MCP et connexions sont enregistrés globalement puis montés dans l’environnement d’une exécution selon les besoins déclarés.

```text
Module Development
        │ requires tickets.read + git + shell
        ▼
Capability Runtime
        ├── GitHub MCP / GitLab MCP / Jira MCP
        ├── Git credentials
        ├── Shell
        └── Workspace
```

Le module peut lire le ticket, ses commentaires et ses liens directement par le MCP adapté. Il n’est pas obligé de dépendre du module provider pour chaque lecture.

### 11.2 Accès global ne signifie pas état partagé

Une connexion externe globale est un port d’infrastructure. Elle ne permet pas :

- d’appeler les use cases privés du module GitHub ;
- de lire ses tables ;
- de manipuler son agrégat interne ;
- de contourner les contrats intermodules pour coordonner un workflow.

### 11.3 Mutations externes

Les credentials et MCP peuvent techniquement offrir des opérations en écriture. La convention d’architecture est :

- les mutations intrinsèques au travail local du module sont autorisées dans ce module ;
- les mutations qui représentent une étape composable du workflow DEVRAIENT passer par une request event dédiée.

Décision explicite pour le développement :

| Action | Propriétaire |
|---|---|
| Lire le ticket | Module agentique via connexion globale |
| Lire le repository | Module agentique |
| Modifier les fichiers | Module agentique |
| Créer la branche | Module agentique |
| Committer | Module agentique |
| Pousser la branche | Module agentique |
| Créer la PR/MR | Module provider après request event |
| Publier une review | Module provider après request event |
| Merger | Module provider après request event produite par un module de décision |

La permission technique peut être restreinte pour rendre cette convention vérifiable.

---

## 12. Flux de référence : Development

Ce flux constitue la verticale de référence du MVP. Le ticket peut demander n’importe quel changement vérifiable — par exemple ajouter un endpoint `/health`, un composant, une commande CLI, une migration légère ou un test — et n’a pas besoin de décrire un bug.

### 12.1 Événement initial

```json
{
  "type": "development.implementation.requested",
  "version": 1,
  "kind": "request",
  "scope": {
    "projectId": "token-warehouse"
  },
  "payload": {
    "workItemRef": {
      "connectionId": "github-qservices",
      "externalId": "QServices/token-warehouse/issues/42"
    },
    "repositoryRef": {
      "connectionId": "github-qservices",
      "provider": "github",
      "externalId": "QServices/token-warehouse",
      "cloneUrl": "git@github.com:QServices/token-warehouse.git"
    }
  }
}
```

### 12.2 Exécution locale

```text
DevelopmentHandler
    │
    ├── allocate workspace
    ├── read ticket through MCP
    ├── inspect repository conventions
    ├── checkout base branch
    ├── create agent/ticket-42
    ├── run DevelopmentLoop
    ├── implement requested change
    ├── add or update tests
    ├── run configured checks
    ├── git commit
    ├── git push
    └── persist result
```

### 12.3 Événements sortants

Fait métier :

```json
{
  "type": "development.implementation.completed",
  "version": 1,
  "kind": "fact",
  "payload": {
    "repositoryRef": {},
    "workItemRef": {},
    "branch": "agent/ticket-42",
    "headSha": "29ab7f0",
    "summary": "Ajout de l’endpoint de statut et de ses tests.",
    "testArtifactRef": "artifact://tests/run-842/result.json",
    "confidence": 0.94
  }
}
```

Demande d’intégration :

```json
{
  "type": "scm.change-request.creation-requested",
  "version": 1,
  "kind": "request",
  "target": {
    "connectionId": "github-qservices"
  },
  "idempotencyKey": "github-qservices:QServices/token-warehouse:agent/ticket-42",
  "payload": {
    "repositoryRef": {},
    "workItemRef": {},
    "baseBranch": "main",
    "headBranch": "agent/ticket-42",
    "headSha": "29ab7f0",
    "title": "Add health status endpoint",
    "descriptionArtifactRef": "artifact://development/corr-ticket-42/pr-description.md",
    "draft": false
  }
}
```

L’exécution `Development` se termine dès que ces événements sont durablement placés dans l’Outbox.

### 12.4 Traitement provider

```text
GitHub Module
    │ consumes scm.change-request.creation-requested
    ├── resolves github-qservices
    ├── verifies idempotency key
    ├── checks existing PR for head branch
    ├── creates Pull Request
    └── emits scm.change-request.created
```

Le provider ne crée ni branche ni commit.

---

## 13. Flux de référence : Change Request Review

```text
scm.change-request.created
       ↓
Change Request Review Module
       ├── resolve connection
       ├── read PR/MR metadata via MCP/API
       ├── fetch branch or diff
       ├── read linked ticket
       ├── run review loop
       └── emit review-publication-requested
       ↓
GitHub/GitLab Module
       ├── publish review
       └── emit review-published / review-approved / changes-requested
```

Exemple de demande :

```json
{
  "type": "scm.change-request.review-publication-requested",
  "version": 1,
  "kind": "request",
  "target": {
    "connectionId": "github-qservices"
  },
  "idempotencyKey": "review:github-qservices:pr-57:head-29ab7f0:reviewer-v1",
  "payload": {
    "changeRequestRef": {},
    "headSha": "29ab7f0",
    "verdict": "approve",
    "bodyArtifactRef": "artifact://reviews/pr-57/review.md",
    "commentsArtifactRef": "artifact://reviews/pr-57/comments.json"
  }
}
```

Une nouvelle version du head SHA peut déclencher une nouvelle review. La clé d’idempotence inclut donc le SHA.

---

## 14. Flux de référence : Auto Merge

Le module `Auto Merge` est un agrégateur de faits indépendant du provider.

### 14.1 État privé

```typescript
interface MergeCandidate {
  changeRequestRef: ChangeRequestRef;
  headSha: string;
  reviewApproved: boolean;
  checksPassed: boolean;
  blocked: boolean;
  mergeRequestedEventId?: string;
}
```

### 14.2 Événements consommés

```text
scm.change-request.created
scm.change-request.review-approved
scm.change-request.review-changes-requested
ci.checks.passed
ci.checks.failed
scm.change-request.updated
```

Après chaque fait, le module met à jour son agrégat et réévalue sa règle.

### 14.3 Émission

Lorsque les conditions sont remplies :

```json
{
  "type": "scm.change-request.merge-requested",
  "version": 1,
  "kind": "request",
  "target": {
    "connectionId": "github-qservices"
  },
  "idempotencyKey": "merge:github-qservices:pr-57:29ab7f0",
  "payload": {
    "changeRequestRef": {},
    "expectedHeadSha": "29ab7f0",
    "strategy": "squash"
  }
}
```

Le provider vérifie le SHA attendu avant le merge. S’il a changé, il publie un échec ou un conflit plutôt que de merger une version non revue.

Sans module Auto Merge, aucune request n’est produite.

---

## 15. Provider GitHub

### 15.1 Responsabilités

- gérer les connexions et installations GitHub ;
- ingérer webhooks ou polling ;
- normaliser les faits GitHub en événements canoniques ;
- consommer les requests SCM ciblées sur une connexion GitHub ;
- exécuter les actions provider-specific ;
- publier le résultat canonique ;
- assurer idempotence et réconciliation.

### 15.2 Non-responsabilités

- décider qu’un ticket doit être développé ;
- lancer une loop de développement ;
- créer la branche de code ;
- committer ou pousser ;
- décider qu’une PR est de qualité suffisante ;
- décider qu’elle doit être mergée ;
- reprendre une exécution d’un autre module.

### 15.3 Mapping externe

```text
GitHub issues.labeled
    → scm.work-item.tag-added

GitHub pull_request.opened
    → scm.change-request.created

scm.change-request.creation-requested
    → GitHub Create Pull Request API
    → scm.change-request.created

scm.change-request.merge-requested
    → GitHub Merge Pull Request API
    → scm.change-request.merged
```

Une PR créée manuellement dans GitHub et une PR créée par Jarvis doivent produire le même fact canonique, avec une metadata indiquant éventuellement l’origine.

---

## 16. Webhooks et synchronisation externe

Les webhooks sont des adaptateurs entrants privés aux modules providers.

Pipeline :

```text
Webhook HTTP
   ↓ signature validation
Provider inbox
   ↓ external event deduplication
Provider domain mapping
   ↓
Canonical integration event
```

Le provider conserve l’identifiant de livraison externe pour éviter les doublons.

Si les webhooks ne sont pas disponibles, le provider PEUT utiliser du polling ou une synchronisation périodique. La source ne change pas le contrat canonique produit.

Aucun webhook ne doit contenir un identifiant de loop à reprendre. Il peut contenir un `correlationId` précédemment attaché à la ressource externe, mais l’événement déclenche toujours une nouvelle exécution.

---

## 17. Stockage

### 17.1 Modèle logique

```text
Kernel Store
├── modules
├── module_instances
├── event_contracts
├── events
├── event_deliveries
├── executions
├── connections
├── workspace_leases
├── artifacts
└── dead_letters

Module-private Store
├── module inbox
├── module outbox
├── aggregates
├── projections
└── configuration state
```

### 17.2 MVP

Pour un daemon local, le MVP PEUT utiliser une base embarquée unique avec :

- tables Kernel ;
- namespaces ou préfixes de tables par module ;
- repositories distincts ;
- interdiction de jointures cross-module dans le code ;
- transactions locales pour Inbox/Outbox.

Cette simplification physique ne change pas la propriété logique des données.

### 17.3 Évolution distribuée

Le port de persistance et le transport permettent ensuite :

- une base par module ;
- un bus externe ;
- des workers distants ;
- un module exécuté sur le Mac mini ;
- un module cloud ;
- une projection centralisée pour le Business OS.

Les contrats restent identiques.

---

## 18. Sécurité

### 18.1 Sécurité technique, pas policy métier centrale

Le Kernel contrôle :

- quels modules sont installés ;
- quelles capacités sont accordées ;
- quelles connexions sont injectées ;
- quels événements un module peut publier ;
- quels scopes de filesystem et de réseau sont accessibles ;
- les limites de coût, temps et ressources.

Il ne décide pas :

- si une PR mérite d’être mergée ;
- si un ticket est suffisamment raffiné ;
- si un déploiement est fonctionnellement autorisé.

Ces décisions appartiennent à des modules dédiés.

### 18.2 Secrets

- les événements ne contiennent jamais de token ;
- les secrets sont référencés par ID ;
- le runtime injecte des handles ou variables éphémères ;
- sur macOS, le Keychain ou un coffre compatible peut servir de backend ;
- les logs et prompts sont nettoyés avant persistance ;
- les credentials Git peuvent être fournis par SSH Agent ou credential helper.

### 18.3 Permissions de publication

Un module ne peut publier que les événements déclarés dans son manifest. Cela empêche un module compromis d’émettre arbitrairement `scm.change-request.merge-requested` s’il ne possède pas cette permission technique.

### 18.4 Sandboxing progressif

Le MVP peut exécuter les modules in-process. L’architecture doit permettre ensuite :

- worker process isolé ;
- sandbox filesystem ;
- allowlist réseau ;
- limite CPU/mémoire ;
- confirmation humaine sur certaines capacités ;
- signature et provenance des packages modules.

---

## 19. Observabilité

### 19.1 Trois vues complémentaires

#### Graphe statique

Construit depuis les manifests :

```text
module A --publishes event X--> module B --publishes event Y--> module C
```

Il montre les chemins possibles.

#### Graphe runtime

Construit depuis `correlationId` et `causationId`. Il montre le parcours réellement observé.

#### Timeline d’exécution

```text
22:10:01 event received
22:10:02 workspace allocated
22:10:08 agent started
22:14:41 tests passed
22:15:04 branch pushed
22:15:05 outbox committed
22:15:06 execution completed
```

### 19.2 Données minimales

Chaque exécution enregistre :

- module et instance ;
- event input ;
- statuts et timestamps ;
- runtime agentique utilisé ;
- durée ;
- consommation estimée ;
- workspace ;
- outputs ;
- artefacts ;
- erreurs ;
- retry count ;
- logs structurés.

### 19.3 Diagnostics de composition

Jarvis doit détecter :

- request sans consommateur ;
- plusieurs consommateurs concurrents pour une request unique ;
- version de contrat incompatible ;
- module désactivé sur un chemin ;
- connexion manquante ;
- capability non accordée ;
- cycle potentiel ;
- module unhealthy ;
- dead-letter active.

---

## 20. Module SDK

### 20.1 Context d’exécution

```typescript
export interface ModuleExecutionContext {
  execution: {
    id: string;
    correlationId: string;
    causationId: string;
    attempt: number;
  };

  events: {
    emit<T>(draft: IntegrationEventDraft<T>): Promise<void>;
  };

  artifacts: {
    put(input: ArtifactInput): Promise<ArtifactDescriptor>;
    get(ref: string): Promise<ArtifactContent>;
  };

  capabilities: CapabilityAccessor;
  connections: ConnectionAccessor;
  workspaces: WorkspaceAccessor;
  agents: AgentRuntimeAccessor;
  logger: StructuredLogger;
  clock: Clock;
  ids: IdGenerator;
}
```

### 20.2 Handler

```typescript
export interface IntegrationEventHandler<TPayload> {
  handle(
    event: IntegrationEvent<TPayload>,
    context: ModuleExecutionContext
  ): Promise<HandlerResult>;
}

export interface HandlerResult {
  status: "completed" | "failed" | "cancelled";
  summary?: string;
  artifactRefs?: string[];
  metrics?: Record<string, number>;
}
```

### 20.3 Publication contrôlée

`context.events.emit()` :

1. complète l’enveloppe ;
2. copie le `correlationId` ;
3. renseigne le `causationId` avec l’event input ;
4. valide le type contre le manifest ;
5. valide le payload contre le Contract Registry ;
6. écrit dans l’Outbox.

### 20.4 Agent Loop SDK

```typescript
export interface AgenticLoopDefinition<TInput, TOutput> {
  id: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  execute(
    input: TInput,
    context: AgenticLoopContext
  ): Promise<TOutput>;
}
```

Le SDK peut fournir :

- steps et checkpoints internes ;
- budget de tokens/coût ;
- sélection de runtime ;
- injection de prompts et skills ;
- output schema enforcement ;
- tool grants ;
- streaming de progression ;
- annulation ;
- redaction de secrets.

Les checkpoints servent à reprendre un crash technique au sein de la même exécution, pas à modéliser une attente intermodule.

---

## 21. Structure de repository recommandée

```text
jarvis/
├── apps/
│   ├── jarvis-daemon/
│   ├── jarvis-desktop/
│   └── jarvis-cli/
│
├── packages/
│   ├── kernel/
│   ├── module-sdk/
│   ├── event-contracts/
│   ├── agent-runtime-sdk/
│   ├── connection-sdk/
│   ├── testing-sdk/
│   └── shared-technical/
│
├── modules/
│   ├── scm-github/
│   ├── scm-gitlab/
│   ├── automation-rules/
│   ├── ticket-refinement/
│   ├── development/
│   ├── bug-resolution/
│   ├── change-request-review/
│   ├── ci-observer/
│   ├── ci-fix/
│   ├── auto-merge/
│   └── notification-telegram/
│
├── contracts/
│   ├── scm/
│   ├── development/
│   ├── bug-resolution/
│   ├── refinement/
│   ├── ci/
│   └── notifications/
│
├── docs/
│   ├── CONTEXT.md
│   ├── ARCHITECTURE.md
│   └── adr/
│
└── tooling/
    ├── architecture-tests/
    ├── contract-codegen/
    └── module-generator/
```

`shared-technical` ne doit contenir que des primitives sans langage métier : Result, Clock, IDs, pagination, erreurs techniques. Il ne doit pas devenir un dépôt de modèles partagés.

---

## 22. Tests

### 22.1 Tests d’architecture

Ils vérifient :

- absence d’import entre dossiers `modules/*` ;
- dépendances autorisées uniquement vers SDK et contrats ;
- absence de repository d’un autre module ;
- manifest cohérent avec les events réellement publiés ;
- aucun provider ne dépend d’un module agentique ;
- aucun module métier ne dépend du package GitHub ou GitLab.

### 22.2 Contract tests

Pour chaque événement :

- validation de fixtures producteur ;
- validation de fixtures consommateur ;
- compatibilité entre versions ;
- sérialisation/désérialisation ;
- tests de valeurs manquantes et payloads invalides.

### 22.3 Tests module

Chaque module dispose d’un harness :

```typescript
const harness = await createModuleHarness(developmentModule)
  .withConnection(fakeGithubMcp)
  .withCapability(fakeGit)
  .withAgentRuntime(fakeAgentRuntime)
  .start();

await harness.deliver(implementationRequestedFixture);

expect(harness.publishedEvents()).toContainEvent(
  "scm.change-request.creation-requested",
  1
);
```

### 22.4 Tests de redélivrance

Scénarios obligatoires :

- même request livrée deux fois ;
- crash après side-effect externe mais avant acknowledgement ;
- crash après commit Outbox ;
- webhook externe dupliqué ;
- PR déjà existante pour la branche ;
- merge demandé deux fois ;
- head SHA modifié entre review et merge.

### 22.5 Tests de composition

Le système démarre avec différentes combinaisons :

```text
GitHub + Development
GitHub + Development + Review
GitHub + Development + Review + Auto Merge
GitLab + Development + Review
```

Les modules métier restent inchangés entre GitHub et GitLab.

---

## 23. Séquence d’implémentation recommandée

### Phase 1 — Fondations

1. packages de contrats et enveloppe v1 ;
2. Module SDK et validation de manifest ;
3. Event Store / Bus local durable ;
4. Inbox, Outbox et Execution Ledger ;
5. Module Host ;
6. Connection Registry ;
7. tests d’architecture.

### Phase 2 — Runtime agentique

1. Workspace Manager ;
2. port Agent Runtime ;
3. premier adapter CLI ;
4. capability grants ;
5. Artifact Store ;
6. streaming d’exécution.

### Phase 3 — Vertical slice GitHub → Development → PR

1. créer un ticket simple et vérifiable, par exemple « ajouter un endpoint `/health` et son test » ;
2. GitHub provider entrant : `tag-added` avec le label `agent:ready` ;
3. Automation Rules ;
4. Development minimal ;
5. Git branch/implementation/tests/commit/push ;
6. request `change-request.creation-requested` ;
7. création PR GitHub ;
8. timeline de corrélation dans l’UI.

Cette phase doit démontrer la philosophie complète sans dépendre de la présence d’un bug réel.

### Phase 4 — Review et CI

1. Change Request Review ;
2. publication de review ;
3. CI Observer ;
4. CI Fix ;
5. gestion des nouvelles générations de head SHA.

### Phase 5 — Décisions optionnelles

1. Auto Merge ;
2. Human Approval ;
3. notifications ;
4. configuration du graphe émergent.

### Phase 6 — Second provider

Implémenter GitLab pour vérifier que les modules métier n’ont aucune dépendance GitHub.

---

## 24. Critères d’acceptation du vertical slice initial

Le premier parcours est accepté lorsque :

1. un ticket de développement simple reçoit le label `agent:ready` ;
2. le module GitHub produit `scm.work-item.tag-added` ;
3. un module de règles produit `development.implementation.requested` ;
4. Development lit le ticket via une connexion globale ;
5. il obtient un workspace isolé ;
6. il crée une branche, implémente le changement, ajoute ou adapte les tests, committe et pousse ;
7. il publie une request de création de change request puis se termine ;
8. le module GitHub crée la Pull Request sans créer ni modifier la branche ;
9. il publie `scm.change-request.created` ;
10. chaque étape possède une exécution indépendante ;
11. toutes les étapes partagent le même `correlationId` ;
12. une redélivrance ne crée pas une deuxième PR ;
13. désactiver le module GitHub laisse la request visible comme `unhandled` ;
14. aucun code de Development n’importe le package GitHub ;
15. l’interface affiche le graphe possible et la timeline réellement exécutée.

---

## 25. Anti-patterns à refuser en revue de code

```text
❌ kernel.handleReadyTicket()
❌ workflow.runDevelopmentThenCreatePrThenWaitForCi()
❌ developmentService.githubClient.createPullRequest()
❌ autoMergeService.githubService.merge()
❌ moduleARepository.queryModuleBTable()
❌ webhook.resumeExecution(oldLoopId)
❌ event payload containing accessToken
❌ one shared DomainModels package for all modules
❌ provider automatically merging after creating a PR
❌ agent publishing arbitrary undeclared event types
```

Formes attendues :

```text
✅ provider emits canonical fact
✅ module consumes fact and emits request
✅ next module starts a new execution
✅ global MCP is injected through a declared connection
✅ development module owns branch/commit/push
✅ provider owns PR/MR API details
✅ optional decision module owns merge decision
✅ Kernel records and routes without knowing the business sequence
```

---

## 26. Résumé normatif

Jarvis DOIT être construit autour d’un Kernel minimal et de modules DDD autonomes. Les modules communiquent exclusivement par événements d’intégration versionnés. Une loop agentique appartient à un module, effectue un travail local et fini, puis publie ses résultats. Les événements externes créent de nouvelles exécutions au lieu de reprendre une loop globale.

Les connexions, MCP, agents CLI, Git, shell et credentials sont des capacités globales injectées aux modules. Les modules de développement gèrent eux-mêmes le workspace, les branches, les commits et le push. Les modules providers gèrent les opérations propres au fournisseur — création de PR/MR, publication de review, merge — uniquement après réception d’une request explicite.

Le workflow global émerge des modules actifs. Une capacité optionnelle ne s’exécute que si un module produit l’événement qui la demande. Le Kernel assure la fiabilité, la sécurité technique, l’idempotence, la traçabilité et l’observabilité, sans contenir de règles métier de séquencement.
