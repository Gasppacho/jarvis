# Jarvis — Contexte produit et principes fondateurs

> **Statut :** document de référence pour la conception et l’implémentation  
> **Audience :** développeurs, architectes, agents de code et contributeurs du projet  
> **Complément :** les choix techniques détaillés sont décrits dans [`ARCHITECTURE.md`](./ARCHITECTURE.md)

## 1. Objet du document

Ce document décrit la vision de Jarvis, le problème résolu, son vocabulaire, ses frontières et les décisions structurantes qui doivent rester vraies pendant l’implémentation.

Jarvis est conçu comme un **système d’exploitation modulaire pour automatisations agentiques event-driven**. Il permet d’assembler des comportements autonomes sous forme de modules indépendants qui consomment et publient des événements. Le workflow global n’est pas codé dans un orchestrateur central : il **émerge des modules installés, de leurs abonnements et des événements qu’ils produisent**.

Le développement logiciel est le premier domaine d’application — tickets, refinement, correction de bugs, développement, Pull Requests, revues, CI et merge — mais l’architecture doit rester suffisamment générale pour accueillir d’autres domaines : support client, recherche, opérations, communication, finance, monitoring, contenu ou automatisation personnelle.

---

## 2. Vision

Jarvis doit permettre de construire un système agentique comme un jeu de Lego :

1. un module observe ou reçoit un événement ;
2. il exécute un comportement local et fini ;
3. il publie zéro, un ou plusieurs nouveaux événements ;
4. d’autres modules peuvent réagir indépendamment ;
5. supprimer un module supprime le comportement associé sans modifier les autres modules.

Exemple :

```text
GitHub Module
    │
    │ scm.work-item.tag-added
    ▼
Automation Rules Module
    │
    │ development.implementation.requested
    ▼
Development Module
    │
    │ scm.change-request.creation-requested
    ▼
GitHub Module
    │
    │ scm.change-request.created
    ▼
Change Request Review Module
```

L’ajout d’un module `Auto Merge` peut prolonger ce graphe. Son absence garantit qu’aucun merge automatique ne sera demandé.

```text
Review approved ─┐
                 ├── Auto Merge Module
CI passed ───────┘          │
                            │ scm.change-request.merge-requested
                            ▼
                       GitHub Module
```

Le provider GitHub sait techniquement merger une Pull Request, mais ne le fait jamais de lui-même. Il ne réalise l’action que lorsqu’il reçoit l’événement de demande correspondant.

---

## 3. Problème résolu

Les orchestrateurs de workflows traditionnels imposent généralement un graphe central décrivant toutes les étapes. Cette approche devient rigide lorsque :

- plusieurs fournisseurs doivent être interchangeables ;
- les comportements agentiques évoluent indépendamment ;
- des étapes optionnelles doivent pouvoir être ajoutées ou supprimées ;
- certaines étapes proviennent d’événements externes ;
- plusieurs modules doivent réagir au même fait ;
- les workflows diffèrent selon le projet ;
- une boucle agentique doit pouvoir embarquer ses propres agents, outils, prompts et règles métier.

Jarvis remplace ce workflow central par une **chorégraphie événementielle modulaire**.

Le noyau ne connaît pas la logique métier. Il fournit uniquement l’hébergement des modules, le transport fiable des événements, l’accès aux capacités globales, la traçabilité et l’exécution des loops agentiques.

---

## 4. Principes fondateurs

### 4.1 Le module est l’unité fondamentale

Un module est un **bounded context exécutable**. Il encapsule un comportement cohérent et peut contenir :

- son domaine et ses règles ;
- ses handlers d’événements ;
- une ou plusieurs loops agentiques ;
- ses agents spécialisés ;
- ses prompts, skills et instructions ;
- ses outils privés ;
- son état interne ;
- ses adaptateurs techniques ;
- les contrats des événements qu’il consomme et produit.

Un module n’est pas une simple extension visuelle ou une fonction isolée. Il est une unité autonome de conception, de test, de versionnement et, à terme, de déploiement.

### 4.2 Les modules ne s’appellent jamais directement

Un module ne doit pas invoquer un autre module par une référence de code, un service partagé ou une requête directe.

Interdit :

```typescript
await githubModule.createPullRequest(...);
```

Attendu :

```typescript
await context.events.publish(changeRequestCreationRequested);
```

Les frontières intermodules sont constituées exclusivement par :

- les événements d’intégration ;
- les références vers des artefacts partagés ;
- les connexions globales vers des systèmes externes ;
- les API techniques du Kernel et du Module SDK.

### 4.3 Le workflow global n’est pas orchestré par le Core

Jarvis ne contient pas de moteur métier central sachant qu’un ticket de développement doit être implémenté, suivi d’une Pull Request, puis d’une review, puis éventuellement d’un merge.

Le workflow apparaît parce que :

- `Development` publie une demande de création de change request après avoir terminé son travail Git ;
- `GitHub` ou `GitLab` sait consommer cette demande ;
- `Change Request Review` écoute le fait indiquant que la change request existe ;
- `Auto Merge`, s’il est installé, écoute les événements nécessaires à sa décision.

Un module générique de règles peut mapper certains événements vers d’autres, mais ce module reste un Lego optionnel. Ce n’est pas une responsabilité cachée du Kernel.

### 4.4 Une loop effectue un travail local et fini

Une loop agentique appartient à un module. Elle démarre à partir d’un événement consommé, exécute son travail, publie ses résultats et se termine.

Elle ne reste pas suspendue en attendant un webhook externe pour reprendre plusieurs minutes ou plusieurs heures plus tard.

```text
Événement entrant
      ↓
Exécution du module
      ↓
Loop agentique
      ↓
Événement(s) sortant(s)
      ↓
Exécution terminée
```

Un événement externe ultérieur crée une **nouvelle exécution indépendante**, éventuellement dans un autre module. Les identifiants de corrélation permettent de relier ces exécutions sans transformer l’ensemble en une seule loop globale.

### 4.5 L’absence d’un module signifie l’absence du comportement

Jarvis ne doit pas cacher de décisions métier dans un moteur central.

- Sans module de review, aucune review agentique n’est lancée.
- Sans module d’auto-merge, aucun événement de merge automatique n’est produit.
- Sans module de notification, aucun message n’est envoyé.
- Sans module de release, un merge ne déclenche aucune publication.

Un provider peut annoncer qu’il sait exécuter une action, mais cette action reste dormante tant qu’aucun module ne publie la demande correspondante.

### 4.6 Les modules sont indépendants, mais peuvent utiliser des capacités globales

Jarvis fournit un registre commun de capacités et de connexions :

- agents CLI tels que Codex, Claude Code ou un modèle local ;
- Git et le shell ;
- accès au système de fichiers et aux workspaces ;
- serveurs MCP ;
- connexions GitHub, GitLab, Jira, Linear, Sentry, navigateur, documentation, etc. ;
- secrets, credentials et identités techniques.

Un module peut également embarquer ses propres tools, agents ou skills privés.

La règle est donc :

> Le module possède le comportement. Le runtime lui fournit l’environnement et les connexions dont il a besoin.

Les connexions globales ne créent pas de couplage entre modules. Elles constituent des ports d’infrastructure vers des systèmes externes.

### 4.7 Git appartient aux modules de développement

La responsabilité Git suit le **modèle A** retenu pour Jarvis.

Les modules tels que `Development`, `Bug Resolution` ou `CI Fix` sont responsables de :

- créer ou sélectionner leur workspace ;
- créer la branche ;
- modifier le code ;
- exécuter les tests ;
- créer les commits ;
- pousser la branche sur le remote ;
- publier ensuite une demande de création de Pull Request ou Merge Request.

Cette décision est cohérente avec l’usage de CLI agentiques disposant déjà de Git, du shell, du filesystem et des credentials nécessaires.

Le module provider ne gère pas la production du code. Il gère uniquement les opérations propres au fournisseur :

- créer une Pull Request GitHub ou une Merge Request GitLab ;
- publier une review ;
- ajouter un commentaire ;
- mettre à jour un ticket ;
- merger une change request lorsqu’une demande explicite est reçue ;
- convertir les événements externes en événements canoniques Jarvis.

### 4.8 Les providers sont des modules comme les autres

Un provider n’est pas un composant privilégié du Kernel.

Le module GitHub peut à la fois :

- produire des événements à partir de webhooks, de polling ou d’une synchronisation ;
- consommer des demandes d’action ;
- exécuter l’action via l’API, la CLI ou un MCP ;
- publier le fait résultant ou un événement d’échec.

Le webhook reste un détail d’infrastructure interne au module provider. Il ne reprend jamais une loop agentique précédente.

```text
Webhook GitHub
      ↓
GitHub Module
      ↓
scm.change-request.created
      ↓
Nouvelles exécutions indépendantes
```

---

## 5. Vocabulaire partagé

### Jarvis Kernel

Le noyau technique minimal qui charge les modules, transporte les événements, maintient les registres, fournit les capacités globales et conserve la traçabilité. Il ne contient aucune logique métier de workflow.

### Module

Bounded context exécutable pouvant consommer des événements, exécuter un comportement et produire des événements. Un module peut être purement déterministe, agentique, orienté intégration ou combiner ces dimensions.

### Module Instance

Configuration active d’un module. Un même module peut avoir plusieurs instances :

```text
jarvis.scm.github
├── github-qservices
├── github-personal
└── github-client-a
```

Chaque instance possède sa configuration, ses connexions, son scope et son état.

### Loop agentique

Processus interne à un module mobilisant un ou plusieurs agents et tools pour atteindre un résultat local. Elle ne constitue pas le workflow global de Jarvis.

### Agent

Comportement cognitif spécialisé utilisé à l’intérieur d’une loop : planner, developer, reviewer, researcher, tester, architecte, etc.

### Tool

Primitive exécutable accessible par un agent ou un handler : shell, Git, filesystem, navigateur, code search, test runner, MCP, API, etc.

### Capability

Faculté technique fournie par le runtime ou par un module : `git.write`, `tickets.read`, `scm.change-request.create`, `browser.navigate`, etc. Une capability n’implique pas qu’elle sera utilisée.

### Connection

Configuration globale donnant accès à un système externe ou à un runtime : compte GitHub, GitLab, Jira, serveur MCP, gateway de runtime agentique distant, modèle local ou clé API.

### Integration Event

Message versionné franchissant la frontière d’un module. Il s’agit du seul contrat métier public entre modules.

### Request Event

Événement représentant une intention à exécuter :

```text
scm.change-request.creation-requested
scm.change-request.merge-requested
notification.sending-requested
```

Une request ne prétend pas que l’action a déjà réussi.

### Fact Event

Événement représentant un fait réellement observé ou accompli :

```text
scm.change-request.created
scm.change-request.merged
notification.sent
```

### Domain Event interne

Événement appartenant au domaine privé d’un module. Il peut rester local et ne doit être publié globalement que s’il constitue un contrat utile pour d’autres modules.

### Execution

Traitement d’un événement par une instance de module. Une exécution possède un début, une fin, un statut, un input, des outputs, des logs et des métriques.

### Correlation

Lien logique entre plusieurs événements et exécutions appartenant au même parcours métier distribué.

### Artifact

Contenu volumineux ou structuré stocké séparément des événements : rapport, diff, résultat de tests, plan, logs, capture, patch ou bundle documentaire. Les événements transportent une référence vers l’artefact.

### Workspace

Environnement isolé dans lequel une loop peut lire ou modifier un repository. Pour les opérations concurrentes, Jarvis privilégie des worktrees ou clones dédiés plutôt qu’un working tree partagé.

---

## 6. Typologie descriptive des modules

Toutes les briques restent des `Module`. Les catégories suivantes sont uniquement descriptives ; elles ne créent pas de hiérarchie différente dans le Kernel.

### Modules d’intégration

Ils relient Jarvis à un système externe :

- GitHub ;
- GitLab ;
- Jira ;
- Linear ;
- Sentry ;
- Telegram ;
- Gmail ;
- Slack ;
- calendrier ;
- filesystem watcher.

### Modules agentiques

Ils exécutent principalement des loops :

- Ticket Refinement ;
- Development ;
- Bug Resolution ;
- Change Request Review ;
- Architecture Review ;
- Security Review ;
- CI Fix ;
- Research ;
- Documentation Update.

### Modules de décision

Ils observent plusieurs faits, maintiennent éventuellement un état local et publient une demande lorsqu’une règle est satisfaite :

- Auto Merge ;
- Human Approval ;
- Deployment Approval ;
- Escalation ;
- Budget Guard ;
- Quality Gate.

### Modules de routage

Ils transforment des conventions externes en intentions métier :

- mapping d’un ticket portant le label `agent:ready` vers `development.implementation.requested` ;
- mapping d’un label `agent:bug` vers `bug-resolution.fix.requested` pour un module spécialisé éventuel ;
- mapping d’une alerte Sentry critique vers `incident.analysis.requested`.

### Modules d’observation

Ils consomment des événements sans modifier le workflow principal :

- audit ;
- analytics ;
- métriques ;
- reporting ;
- notifications ;
- projections pour l’interface.

---

## 7. Exemple de parcours complet : développement d’un ticket

Ce parcours est la verticale de référence du MVP. Il ne dépend pas de l’existence d’un bug : un ticket simple demandant par exemple l’ajout d’un endpoint, d’un composant, d’une commande ou d’un test suffit à le valider.

### 7.1 Détection du signal

Une issue GitHub décrivant un travail de développement reçoit le label `agent:ready`.

Le module GitHub produit :

```text
scm.work-item.tag-added
```

Le module provider ne lance aucun développement lui-même.

### 7.2 Routage vers le domaine de développement

Un module `Automation Rules` consomme ce fait et, si la règle configurée correspond, produit :

```text
development.implementation.requested
```

Ce module permet de modifier les conventions de déclenchement sans modifier GitHub ni le module `Development`. Le signal pourrait plus tard provenir de GitLab, Jira, Linear, d’une commande locale ou d’un autre module.

### 7.3 Exécution de Development

Le module `Development` :

1. lit le ticket et ses commentaires via la connexion ou le MCP global ;
2. prépare un workspace isolé ;
3. inspecte le repository et ses conventions ;
4. transforme le ticket en plan d’implémentation local ;
5. crée une branche ;
6. implémente le changement demandé ;
7. ajoute ou adapte les tests ;
8. exécute les vérifications configurées ;
9. committe les changements ;
10. pousse la branche ;
11. termine son exécution.

Il publie notamment :

```text
development.implementation.completed
scm.change-request.creation-requested
```

Il n’attend pas que la Pull Request soit créée.

### 7.4 Création de la change request

Le module GitHub reçoit la demande ciblée sur sa connexion et crée une Pull Request à partir de la branche déjà poussée.

Il publie :

```text
scm.change-request.created
```

En cas d’échec :

```text
scm.change-request.creation-failed
```

### 7.5 Review indépendante

Le module `Change Request Review`, s’il est actif, consomme `scm.change-request.created`, lit le ticket, le diff et les checks, exécute sa loop puis publie :

```text
scm.change-request.review-publication-requested
```

Le provider publie la review et émet ensuite :

```text
scm.change-request.review-published
```

Sans module de review, le parcours s’arrête simplement après la création de la change request.

### 7.6 Merge optionnel

Un module `Auto Merge` peut agréger :

```text
scm.change-request.review-approved
scm.change-request.checks-passed
```

Lorsqu’il estime que les conditions sont réunies, il publie :

```text
scm.change-request.merge-requested
```

Le provider réalise le merge et publie :

```text
scm.change-request.merged
```

Sans instance active du module `Auto Merge`, cette demande n’est jamais émise.

---

## 8. Portée produit

### Jarvis doit fournir

- un catalogue de modules installés et installables ;
- l’activation, la désactivation et la configuration d’instances de modules ;
- un Event Bus durable ;
- un registre de contrats d’événements ;
- un registre de connexions et de capacités globales ;
- un runtime de loops agentiques ;
- une gestion de workspaces et de Git ;
- une traçabilité par événements, corrélations et exécutions ;
- un stockage d’artefacts ;
- des mécanismes de reprise, retry, idempotence et dead-letter ;
- une vue graphique dérivée des contrats et des traces réelles ;
- une API/SDK permettant de développer chaque module indépendamment.

### Jarvis ne doit pas devenir

- un orchestrateur central de workflows métier ;
- un gigantesque ensemble de conditions `if label then loop` dans le Core ;
- un moteur BPMN imposant un processus global ;
- un framework où les modules partagent leurs tables ;
- un système où une loop appelle directement la suivante ;
- un outil exclusivement dédié à GitHub ou au développement logiciel ;
- un monolithe dans lequel agents, tools, providers et domaines sont mélangés dans un dossier générique `modules` sans frontières.

---

## 9. Contexte d’exécution et runtimes agentiques

Jarvis n’est pas lui-même un modèle de langage. Il héberge et pilote des modules qui peuvent utiliser plusieurs runtimes agentiques.

Un runtime peut être local à la machine ou distant, par exemple exécuté sur un autre Mac et exposé par une gateway sécurisée. Jarvis peut utiliser :

- un modèle local pour une présence permanente ;
- Codex ou Claude Code pour des tâches de code ;
- des providers API ;
- plusieurs runtimes selon le module, le coût, la complexité ou la disponibilité.

Le choix du runtime agentique est une configuration de module ou de projet, pas une dépendance du domaine.

Une topologie possible est :

```text
Jarvis Desktop macOS
        │
        ├── Jarvis local daemon / Kernel
        ├── modules locaux
        ├── modèle local
        └── connexions globales
                 │
                 └── Gateway sécurisée → runtime agentique distant
```

Le Business OS web peut consommer des projections, des statuts et des demandes de validation produits par Jarvis, sans devenir le moteur d’exécution des modules.

---

## 10. Expérience utilisateur cible

L’interface Jarvis ne demande pas nécessairement à l’utilisateur de dessiner un workflow impératif comme dans n8n.

Elle montre plutôt :

### Le catalogue de modules

Pour chaque module :

- objectif ;
- événements consommés ;
- événements produits ;
- loops, agents et tools fournis ;
- connexions requises ;
- permissions demandées ;
- configuration ;
- version ;
- santé et dernières exécutions.

### Le graphe émergent

Jarvis dérive un graphe à partir des manifests actifs :

```text
[GitHub]
    │ scm.work-item.tag-added
    ▼
[Automation Rules]
    │ development.implementation.requested
    ▼
[Development]
    │ scm.change-request.creation-requested
    ▼
[GitHub]
    │ scm.change-request.created
    ▼
[Change Request Review]
```

Le graphe doit distinguer :

- les chemins possibles d’après les contrats ;
- les chemins réellement observés ;
- les requests sans consommateur ;
- les abonnements ambigus ;
- les modules désactivés ;
- les erreurs et retries.

### La timeline de corrélation

Pour l’implémentation d’un ticket précis :

```text
Correlation corr_issue_42_development
├── GitHub execution: ready tag detected
├── Rules execution: implementation requested
├── Development execution: completed
├── GitHub execution: PR created
├── Review execution: approved
└── Auto Merge execution: merge requested
```

Cette timeline reconstitue le workflow sans qu’un orchestrateur central l’ait possédé.

---

## 11. Modules prioritaires du MVP

### Kernel et SDK

- Module Host ;
- Event Bus durable ;
- registre de contrats ;
- Inbox/Outbox ;
- Execution Ledger ;
- Connection Registry ;
- Workspace Manager ;
- Agent Runtime Adapter ;
- Artifact Store ;
- API locale et flux temps réel pour l’interface.

### Modules fonctionnels

1. **GitHub Provider**
   - ingestion d’événements GitHub ;
   - création de Pull Request ;
   - publication de commentaire/review ;
   - merge sur demande explicite.

2. **Automation Rules**
   - mapping configurable d’événements vers des request events ;
   - filtrage par projet, label, auteur, branche ou metadata.

3. **Development**
   - lecture d’un ticket de développement prêt ;
   - analyse du code et planification locale ;
   - gestion du workspace, de la branche, des modifications, des tests, des commits et du push ;
   - émission d’un résultat d’implémentation et d’une demande de création de change request.

4. **Change Request Review**
   - analyse du diff ;
   - review agentique ;
   - émission d’une demande de publication de review.

5. **Ticket Refinement**
   - lecture du ticket et du code ;
   - enrichissement agentique ;
   - émission d’un résultat de refinement et, selon la configuration, d’une demande de mise à jour ;
   - possibilité de publier ensuite `development.implementation.requested` via un module de décision ou de routage.

6. **CI Observer / CI Fix**
   - normalisation des résultats CI ;
   - correction indépendante en cas d’échec.

7. **Auto Merge**
   - module optionnel ;
   - agrégation review + CI ;
   - émission d’une demande de merge.

8. **Notification**
   - observation non bloquante ;
   - Telegram ou autre canal.

9. **Bug Resolution**
   - module spécialisé optionnel pour les tickets explicitement qualifiés comme bugs ;
   - réutilise les mêmes capacités Git, workspace et provider ;
   - n’est pas requis pour valider la verticale initiale.

---

## 12. Invariants non négociables

Les affirmations suivantes doivent être vérifiables dans le code et les tests d’architecture :

1. Un module ne dépend pas du code applicatif d’un autre module.
2. Un module ne lit ni n’écrit directement les tables privées d’un autre module.
3. Les communications métier intermodules passent par des événements versionnés.
4. Une loop se termine avant qu’un événement externe ultérieur ne poursuive le parcours.
5. Les webhooks créent de nouveaux faits ; ils ne reprennent pas une ancienne loop globale.
6. Les opérations Git de production de code appartiennent aux modules de développement.
7. Les providers n’exécutent une action que lorsqu’ils reçoivent une request explicite.
8. Une action métier optionnelle n’existe que si le module qui la décide est installé et actif.
9. Le Kernel ne contient aucune connaissance du séquencement métier.
10. Les events transportent des références, pas de secrets ni de gros artefacts.
11. Chaque traitement est idempotent ou protégé par une clé d’idempotence.
12. Les événements et exécutions disposent de `correlationId` et `causationId`.
13. Les capacités globales sont injectées par le runtime et déclarées dans le manifest du module.
14. Les contrats publics sont validés et versionnés.
15. Le graphe du workflow est dérivé des modules ; il n’est pas la source impérative de vérité.

---

## 13. Décisions d’architecture actées

| ID | Décision |
|---|---|
| ADR-001 | Jarvis utilise une chorégraphie événementielle plutôt qu’un workflow métier central. |
| ADR-002 | Le module est un bounded context exécutable et l’unité principale de modularité. |
| ADR-003 | Une loop réalise un travail local fini et ne reste pas en attente d’un événement externe. |
| ADR-004 | Les providers publient des faits et exécutent uniquement les requests qu’ils savent gérer. |
| ADR-005 | L’absence d’un module de décision implique l’absence du comportement correspondant. |
| ADR-006 | Les branches, commits et push sont gérés par les modules de développement via Git et la CLI agentique. |
| ADR-007 | Les MCP, connexions, runtimes et credentials sont fournis comme capacités globales. |
| ADR-008 | Un module peut embarquer ses propres loops, agents, tools, prompts et état. |
| ADR-009 | Les communications intermodules sont exclusivement événementielles. |
| ADR-010 | Le Kernel gère la sécurité technique et la fiabilité, mais aucune policy métier centralisée. |
| ADR-011 | Les termes Pull Request et Merge Request sont normalisés en `Change Request` dans les contrats communs. |
| ADR-012 | Le MVP est développé comme un modular monolith strict, avec possibilité d’externaliser les modules plus tard. |

---

## 14. Critères de réussite

Jarvis est conforme à cette vision lorsque :

- un nouveau module peut être développé dans un package séparé sans modifier le Core ;
- GitHub peut être remplacé par GitLab sans modifier `Development` ;
- l’ajout de `Change Request Review` ajoute une étape uniquement par son abonnement aux événements ;
- désactiver `Auto Merge` suffit à supprimer tout merge automatique ;
- une loop de développement crée, committe et pousse sa branche puis se termine avant la création de la PR ;
- les événements permettent de reconstituer l’intégralité du parcours ;
- un agent de code peut comprendre un module à partir de son manifest, de ses contrats et de son dossier, sans explorer toute la codebase ;
- les erreurs, doublons et redélivrances ne créent pas plusieurs Pull Requests ou merges ;
- l’interface montre les modules actifs et le workflow émergent ;
- le même Kernel peut héberger des modules hors développement logiciel.

---

## 15. Phrase de référence

> **Jarvis est un système d’exploitation modulaire pour automatisations agentiques event-driven. Il héberge des modules autonomes qui consomment des événements, exécutent un comportement local — éventuellement au moyen de loops, agents et tools — puis publient de nouveaux événements. Le workflow global émerge de cette composition et n’appartient à aucun orchestrateur central.**
