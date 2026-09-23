-- Execution policy belongs to Development, never to Project configuration.
-- Strip every formerly accepted technical key from current local configs.
UPDATE projects
SET portable_config = json_set(
      json_remove(portable_config, '$.commands', '$.git', '$.workspace'),
      '$.repositories',
      json(COALESCE((
        SELECT json_group_array(json_object(
          'id', json_extract(repository.value, '$.id'),
          'root', json_extract(repository.value, '$.root')
        ))
        FROM json_each(projects.portable_config, '$.repositories') AS repository
      ), '[]')),
      '$.modules',
      json(COALESCE((
        SELECT json_group_array(json(
          CASE
            WHEN json_extract(module.value, '$.moduleId') = 'jarvis.module.development'
            THEN json_set(
              module.value,
              '$.configuration',
              json_remove(
                CASE
                  WHEN json_type(module.value, '$.configuration') = 'object'
                  THEN json_extract(module.value, '$.configuration')
                  ELSE json('{}')
                END,
                '$.scope',
                '$.validationOrder',
                '$.maxRepairCycles',
                '$.preparation',
                '$.retainWorkspaceOnSuccess',
                '$.timeoutMs',
                '$.outputLimitBytes',
                '$.environmentAllowlist'
              )
            )
            ELSE module.value
          END
        ))
        FROM json_each(projects.portable_config, '$.modules') AS module
      ), '[]'))
    ),
    updated_at = datetime('now')
WHERE json_valid(portable_config)
  AND json_type(portable_config) = 'object';

UPDATE project_resolved_compositions
SET resolved_project = json_set(
      json_remove(
        resolved_project,
        '$.composition.commands',
        '$.composition.git',
        '$.composition.workspace'
      ),
      '$.composition.repositories',
      json(COALESCE((
        SELECT json_group_array(json_object(
          'id', json_extract(repository.value, '$.id'),
          'root', json_extract(repository.value, '$.root')
        ))
        FROM json_each(resolved_project, '$.composition.repositories') AS repository
      ), '[]')),
      '$.composition.modules',
      json(COALESCE((
        SELECT json_group_array(json(
          CASE
            WHEN json_extract(module.value, '$.moduleId') = 'jarvis.module.development'
            THEN json_set(
              module.value,
              '$.configuration',
              json_remove(
                CASE
                  WHEN json_type(module.value, '$.configuration') = 'object'
                  THEN json_extract(module.value, '$.configuration')
                  ELSE json('{}')
                END,
                '$.scope',
                '$.validationOrder',
                '$.maxRepairCycles',
                '$.preparation',
                '$.retainWorkspaceOnSuccess',
                '$.timeoutMs',
                '$.outputLimitBytes',
                '$.environmentAllowlist'
              )
            )
            ELSE module.value
          END
        ))
        FROM json_each(resolved_project, '$.composition.modules') AS module
      ), '[]')),
      '$.moduleInstances',
      json(COALESCE((
        SELECT json_group_array(json(
          CASE
            WHEN json_extract(instance.value, '$.moduleId') = 'jarvis.module.development'
            THEN json_set(
              instance.value,
              '$.configuration',
              json_remove(
                CASE
                  WHEN json_type(instance.value, '$.configuration') = 'object'
                  THEN json_extract(instance.value, '$.configuration')
                  ELSE json('{}')
                END,
                '$.scope',
                '$.validationOrder',
                '$.maxRepairCycles',
                '$.preparation',
                '$.retainWorkspaceOnSuccess',
                '$.timeoutMs',
                '$.outputLimitBytes',
                '$.environmentAllowlist'
              )
            )
            ELSE instance.value
          END
        ))
        FROM json_each(resolved_project, '$.moduleInstances') AS instance
      ), '[]'))
    )
WHERE json_valid(resolved_project)
  AND json_type(resolved_project) = 'object'
  AND json_type(resolved_project, '$.composition') = 'object';
