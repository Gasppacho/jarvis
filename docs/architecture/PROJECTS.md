# Project Architecture

## Project as composition root

Le projet est la frontière où Jarvis assemble :

- repository principal ;
- instances de modules ;
- compte GitHub et CLI d'agent sélectionnés ;
- stockage, événements, exécutions et artefacts scopés.

Le Kernel connaît des packages et ressources globales ; il ne les expose pas automatiquement au projet.

## Local project configuration

La configuration vit uniquement dans Application Support/SQLite. Elle contient le
workflow sélectionné, le compte GitHub, le label Développeur, la CLI d'agent et les
références locales nécessaires au dépôt. Les secrets restent dans le Keychain.

Jarvis ne lit ni n'écrit `.jarvis/project.yaml`. Supprimer un Project supprime sa
configuration ; réimporter ensuite le même dépôt crée un workflow vide. Les ressources
globales restent de simples candidates jusqu'à leur sélection explicite dans ce Project.

## Import flow

1. Le shell obtient l'accès au dossier.
2. Le moteur inspecte le repository sans modification.
3. Le moteur crée un Project local en brouillon avec un workflow vide.
4. L'utilisateur sélectionne librement zéro, un ou deux Modules dans **Workflow**.
5. **Paramétrage** choisit le compte GitHub, le label et la CLI des Modules présents.
6. **Vérification** teste uniquement leurs dépendances externes.
7. Une réussite autorise **Créer le projet** ; un Project actif utilise ensuite
   **Appliquer la configuration** pour remplacer sa configuration.

## Detection

La détection peut lire :

- `.git/config`, remotes et refs ;
- `package.json`, lockfiles et scripts ;
- fichiers Xcode, Gradle, Cargo, Python ou autres ;
- `AGENTS.md`, `CLAUDE.md` et instructions spécifiques ;
- présence de CLI via un login shell contrôlé.

La détection ne lance pas les scripts projet et ne modifie pas le repository.

## Isolation

Tous les records persistés liés au travail portent `project_id`. Les services exigent un `ProjectContext` explicite ; aucune API ne fournit une requête non scopée aux modules.

```text
Event A(project=token-warehouse)
   └── deliveries uniquement vers instances project=token-warehouse
```

Les workspaces et artefacts sont placés sous :

```text
~/Library/Application Support/Jarvis/projects/<project-id>/
```

Les secrets restent dans le Keychain et sont accessibles uniquement via un binding autorisé.

## Project deletion

La suppression met automatiquement le Project en pause, puis retire dans une transaction
locale son Registry record, sa configuration, ses bindings, son état moteur et son
Repository Grant. Une exécution encore active bloque la suppression. Le repository,
ses branches, commits et fichiers ne sont jamais modifiés.

## Project states

```text
Draft → Valid → Active → Paused → Archived
          ↘ Invalid / Degraded
```

- `Draft` : configuration locale non vérifiée.
- `Valid` : dépendances externes vérifiées mais subscriptions inactives.
- `Active` : pollers, schedules et consumers actifs.
- `Paused` : aucune nouvelle delivery ; exécutions en cours selon politique.
- `Degraded` : ressource devenue indisponible ; chemins impactés suspendus.
- `Archived` : historique consultable, aucun travail.

## Project Overview read model

Après activation, `GET /v1/projects/{projectId}/overview` projette à la demande l'état
du Project, du poller GitHub, des admissions de Development et des exécutions actives.
Il ne crée pas de seconde source de vérité : les issues viennent de la readiness
observée par le Module GitHub, l'état de connexion vient du statut durable du polling,
et la présence d'une exécution active vient du Ledger et de l'Event subject associé.

L'Overview conserve le dernier snapshot observable lorsque GitHub échoue. Un refresh
peut demander un polling immédiat; il retourne alors l'état `failed` ou `reconnecting`
avec une raison filtrée. Un Project en pause expose `paused`, bloque les nouveaux claims
dans la boucle de dispatch et continue à montrer les exécutions déjà actives.

Les raisons d'éligibilité sont contractuelles et affichées par le shell sans être
recalculées. L'état `blocked` est réservé aux références `blocked_by` GitHub ouvertes.
Développeur interprète exactement le label sauvegardé ; un label vide n'admet aucun
Work Item et ne constitue pas un échec de vérification.

## Validation report

Le rapport de vérification est calculé depuis la configuration locale sauvegardée.
L'écran affiche chaque dépendance vérifiée, réussie ou échouée :

- GitHub produit trois lignes : dépôt Git local, identité du remote GitHub et accès du compte ;
- Développeur produit une ligne pour la CLI choisie, installée, prise en charge et exécutable.

Zéro Module produit un rapport réussi. Le label, les issues, les dépendances d'issues,
les commandes, les tests et la compatibilité du routage ne font pas partie de ce
rapport. La composition libre reste valide même si elle ne peut produire aucun travail.
Le contrôle ne démarre ni agent, ni commande du dépôt, ni polling.

Une réussite est persistée avec une identité stable dérivée uniquement des Modules
sélectionnés, du compte GitHub et de la CLI. Modifier l'une de ces valeurs supprime
la réussite dans la même transaction que la sauvegarde ; rétablir ensuite l'ancienne
valeur ne la ressuscite pas. Modifier le label Développeur ne l'invalide pas. Le résultat
survit au redémarrage de Jarvis.

## Activation

`POST /v1/projects/{projectId}/activate` exige une réussite persistée correspondant au
workflow, au compte et à la CLI actuellement sauvegardés. Il refuse une configuration
jamais vérifiée ou invalidée, sans relancer silencieusement les contrôles. Un changement
de label peut être appliqué avec la réussite existante.

Un refus laisse l'état durable inchangé. Enregistrer une nouvelle configuration d'un
Project actif ou pausé conserve son statut et son ancien Resolved Project : polling,
exécutions et Overview continuent donc d'utiliser ce snapshot. Après vérification,
Appliquer remplace explicitement le Resolved Project par la configuration sauvegardée.
La première activation d'un brouillon le fait passer à `active`. Répéter l'application
de la même configuration est idempotent.

Le succès ouvre aussi, sans écriture ni store durable supplémentaire, exactement les
subscriptions déclarées par les Module Instances project-scoped `enabled` du Resolved
Project (ticket #54) : un contrat consommé du Manifest pour chaque instance activée de la
composition figée ; une instance désactivée n'en ouvre aucune. `GET
/v1/projects/{projectId}/subscriptions` projette cet ensemble à la demande depuis le
Resolved Project et les Manifests des Module Packages, jamais depuis une seconde table :
il ne peut donc jamais diverger de ce qui a réellement été activé, et répéter
l'activation d'une composition inchangée laisse l'ensemble inchangé. Avant toute
activation réussie, `items` est vide. Ouvrir une subscription n'est pas délivrer un
Event : cette opération ne dispatche rien, ne délivre aucun Event et ne démarre aucune
exécution — la delivery reste le ticket #6.

## Logical repositories in MVP

Un Project possède un seul repository local. Jarvis conserve son chemin accordé et
résout son remote vers l'identité GitHub `owner/name` lorsque le Module GitHub est
sélectionné. Un dépôt non Git, un remote absent ou une identité ambiguë échoue seulement
sur la ligne GitHub de la vérification ; sans Module GitHub, cet état ne bloque pas
l'activation.

Lors de la migration vers les brouillons locaux, Jarvis conserve intégralement tout
Project qui possède encore une exécution ou une livraison non terminale. Sa
configuration, ses bindings et sa composition résolue restent inchangés afin que le
travail en cours puisse terminer avec le même contexte. Une fois ce travail terminé,
le Project peut être supprimé puis réimporté pour repartir d'un brouillon vide.

## Module catalogue

Le Catalogue embarqué contient GitHub et Développeur, chacun sélectionnable au plus
une fois. Il n'existe ni template de workflow ni composition recommandée implicite.
Le Module Développeur possède ses conventions de branche, commandes, validations,
concurrence, worktrees et politique d'exécution.
