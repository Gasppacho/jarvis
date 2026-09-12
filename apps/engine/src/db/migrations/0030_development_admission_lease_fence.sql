-- The lease is the irreversible Development start. Keep this policy in the
-- same SQLite statement so a concurrent suspend cannot admit a later lease.
CREATE TRIGGER workspace_leases_reject_suspended_development_admission
BEFORE INSERT ON workspace_leases
WHEN EXISTS (
  SELECT 1 FROM development_admission_controls
  WHERE project_id = NEW.project_id AND suspended_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'development-admission-suspended');
END;
