-- A Project may bind more than one GitHub Module Instance. Readiness admission
-- remains one work item per Project repository, independent of the poller.
DELETE FROM github_work_item_readiness
WHERE rowid NOT IN (
  SELECT MIN(rowid)
  FROM github_work_item_readiness
  GROUP BY project_id, repository_id, work_item_ref
);

CREATE UNIQUE INDEX github_work_item_readiness_project_repository_work_item
  ON github_work_item_readiness (project_id, repository_id, work_item_ref);
