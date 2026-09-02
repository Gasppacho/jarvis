-- ProjectDetail now exposes a typed draft union. Projects imported before
-- composition editing existed lack the empty slots/modules collections.
-- Normalize only missing draft fields so existing user values are never replaced.
UPDATE projects
SET portable_config = json_set(portable_config, '$.slots', json('{}'))
WHERE status = 'draft'
  AND json_valid(portable_config)
  AND json_type(portable_config) = 'object'
  AND json_type(portable_config, '$.slots') IS NULL;

UPDATE projects
SET portable_config = json_set(portable_config, '$.modules', json('[]'))
WHERE status = 'draft'
  AND json_valid(portable_config)
  AND json_type(portable_config) = 'object'
  AND json_type(portable_config, '$.modules') IS NULL;
