# Context: Eventing

## Terms

### Event
A versioned integration message with a project scope and causal metadata.

_Avoid_: command when referring to both Requests and Facts; webhook event for canonical events.

### Request
An Event expressing intent that must resolve to exactly one active consumer.

_Avoid_: action, because the action may not yet have occurred.

### Fact
An Event reporting something that has actually occurred and may have zero or many consumers.

### Delivery
The durable assignment of one Event to one Module Instance consumer.

### Delivery lease
Temporary ownership of a Delivery by one worker. A live lease excludes another
worker; an expired lease makes the Delivery claimable again.

### Inbox
The consumer-side deduplication record for a Delivery.

### Outbox
The transactionally recorded set of Events awaiting publication.

### Dead Letter
A Delivery that exhausted its retry policy or failed permanently.

### Replay
An explicit request to run a Dead Letter's original Delivery and Event again,
using the original Event identity and idempotency semantics while recording a
new replay-marked Execution.

### Retry
A later attempt on the same Delivery after a retryable failure. It does not
create a new Event or a new business chain.

### Correlation
The full business chain linked by a shared `correlationId`.

### Causation
The direct parent relationship between two Events.

### Partition Key
The key used to serialize Deliveries whose order matters.
