# Observability

## Goals

L'utilisateur doit pouvoir répondre sans lire la base :

- quel événement a déclenché le travail ;
- quel module l'a consommé ;
- quelle exécution est en cours ;
- quels outputs ont été publiés ;
- où la chaîne s'est arrêtée ;
- si une action externe a été tentée plusieurs fois ;
- quel correctif est possible.

## Structured logs

Format minimal :

```json
{
  "timestamp": "...",
  "level": "info",
  "code": "workspace.allocated",
  "projectId": "token-warehouse",
  "moduleInstanceId": "development",
  "executionId": "exe_...",
  "correlationId": "corr_...",
  "message": "Workspace allocated",
  "attributes": {}
}
```

`message` est lisible ; `code` est stable. Les attributes sont validés et redacted.

## Event timeline

Source durable : events + deliveries + executions. La timeline montre :

- causation tree ;
- facts versus requests ;
- consumers ;
- attempts et durée ;
- dead letters ;
- external references ;
- artifacts.

Le graphe métier est reconstruit à la demande, pas persisté comme workflow.

## Health

### System health

- engine version ;
- database/migrations ;
- outbox backlog ;
- worker liveness ;
- disk space ;
- API/SSE.

### Project health

- composition validée ;
- bindings disponibles ;
- module status ;
- poller cursor age ;
- active executions ;
- dead letters ;
- workspace leaks.

## Metrics

MVP local, sans télémétrie distante par défaut :

- event throughput ;
- delivery latency ;
- execution duration/success rate ;
- retry/dead-letter count ;
- agent usage when available ;
- workspace allocation time ;
- PR creation latency.

L'UI peut afficher des compteurs locaux. Toute future télémétrie opt-in exige consentement et ADR.

## Real-time channel

SSE transporte des notifications UI :

```text
system.health-changed
project.status-changed
event.recorded
execution.changed
execution.log-appended
module.status-changed
```

Chaque message porte un sequence number de session. Après gap/reconnexion, le client recharge le snapshot via REST.

## Diagnostic bundle

Contenu :

- manifeste de versions ;
- project config portable ;
- binding descriptors sans secret ;
- validation reports ;
- logs structurés filtrés ;
- event/execution metadata ;
- crash traces ;
- checksums du bundle.

L'utilisateur choisit explicitement si un transcript agentique est inclus.
