-- Development admission suspends new implementations. A completed implementation
-- must still be able to reach downstream modules such as Pull Request.
DROP TRIGGER workspace_leases_reject_suspended_development_admission;

CREATE TRIGGER workspace_leases_reject_suspended_development_admission
BEFORE INSERT ON workspace_leases
WHEN EXISTS (
  SELECT 1 FROM development_admission_controls
  WHERE project_id = NEW.project_id AND suspended_at IS NOT NULL
)
AND EXISTS (
  SELECT 1 FROM executions
  WHERE id = NEW.execution_id
    AND project_id = NEW.project_id
    AND module_id = 'jarvis.module.development'
)
BEGIN
  SELECT RAISE(ABORT, 'development-admission-suspended');
END;
