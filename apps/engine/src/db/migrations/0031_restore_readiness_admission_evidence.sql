-- 0029 could retain an unadmitted duplicate while dropping an admitted row.
-- Readiness publication and admission committed together, so the durable
-- Outbox/journal can restore that marker without altering an applied migration.
UPDATE github_work_item_readiness AS candidate
SET admitted_at = (
  SELECT MIN(json_extract(evidence.envelope, '$.occurredAt'))
  FROM (
    SELECT project_id, envelope FROM events WHERE type = 'scm.work-item.ready'
    UNION ALL
    SELECT project_id, envelope FROM outbox
      WHERE json_extract(envelope, '$.type') = 'scm.work-item.ready'
  ) evidence
  WHERE evidence.project_id = candidate.project_id
    AND json_extract(evidence.envelope, '$.payload.repositoryId') = candidate.repository_id
    AND json_extract(evidence.envelope, '$.payload.workItemRef') = candidate.work_item_ref
)
WHERE admitted_at IS NULL;

-- Admissions already removed by provider observation must not restart on
-- upgrade or resume. Preserve their diagnostic row and failure-attempt budget.
UPDATE deliveries SET consumed_at = (
  SELECT updated_at FROM development_admissions WHERE delivery_id = deliveries.id
), lease_owner = NULL, lease_expires_at = NULL
WHERE consumed_at IS NULL
  AND id IN (SELECT delivery_id FROM development_admissions WHERE status = 'ineligible')
  AND NOT EXISTS (
    SELECT 1 FROM executions execution
    JOIN execution_checkpoints checkpoint ON checkpoint.execution_id = execution.id
    WHERE execution.project_id = deliveries.project_id
      AND execution.module_instance_id = deliveries.module_instance_id
      AND execution.input_event_id = deliveries.event_id
  );
