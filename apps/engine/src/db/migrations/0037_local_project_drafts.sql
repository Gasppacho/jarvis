-- Project configuration is local-only from ADR 0020 onward. Existing Projects
-- keep their repository binding/bookmark but restart as empty Drafts.
--
-- A Project with non-terminal work is intentionally left byte-for-byte intact:
-- changing its resolved composition or bindings while a Delivery/Execution is
-- active would make recovery unsafe. The user can remove and re-import it once
-- that work is terminal.
DELETE FROM project_resolved_compositions
WHERE project_id IN (
  SELECT projects.id
  FROM projects
  WHERE NOT EXISTS (
    SELECT 1 FROM executions
    WHERE executions.project_id = projects.id
      AND executions.status IN ('queued', 'running', 'cancelling')
  )
    AND NOT EXISTS (
      SELECT 1 FROM deliveries
      WHERE deliveries.project_id = projects.id
        AND deliveries.consumed_at IS NULL
    )
);

DELETE FROM project_migration_state
WHERE project_id IN (
  SELECT projects.id
  FROM projects
  WHERE NOT EXISTS (
    SELECT 1 FROM executions
    WHERE executions.project_id = projects.id
      AND executions.status IN ('queued', 'running', 'cancelling')
  )
    AND NOT EXISTS (
      SELECT 1 FROM deliveries
      WHERE deliveries.project_id = projects.id
        AND deliveries.consumed_at IS NULL
    )
);

UPDATE project_bindings
SET slot_bindings = '{}'
WHERE project_id IN (
  SELECT projects.id
  FROM projects
  WHERE NOT EXISTS (
    SELECT 1 FROM executions
    WHERE executions.project_id = projects.id
      AND executions.status IN ('queued', 'running', 'cancelling')
  )
    AND NOT EXISTS (
      SELECT 1 FROM deliveries
      WHERE deliveries.project_id = projects.id
        AND deliveries.consumed_at IS NULL
    )
);

UPDATE projects
SET status = 'draft',
    portable_config = json_set(
      portable_config,
      '$.compositionMode', 'fixed-modules',
      '$.modules', json('[]'),
      '$.slots', json('{}')
    ),
    updated_at = datetime('now')
WHERE json_valid(portable_config)
  AND json_type(portable_config) = 'object'
  AND NOT EXISTS (
    SELECT 1 FROM executions
    WHERE executions.project_id = projects.id
      AND executions.status IN ('queued', 'running', 'cancelling')
  )
  AND NOT EXISTS (
    SELECT 1 FROM deliveries
    WHERE deliveries.project_id = projects.id
      AND deliveries.consumed_at IS NULL
  );
