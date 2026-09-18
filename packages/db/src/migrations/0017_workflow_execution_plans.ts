import type { Migration } from './types.js';

/** Compiled, allow-listed workflow plans; legacy columns remain compatibility projections. */
export const workflowExecutionPlansMigration: Migration = {
  id: '0017_workflow_execution_plans',
  sql: `
    ALTER TABLE workflows ADD COLUMN definition_json TEXT;
    ALTER TABLE workflows ADD COLUMN execution_plan_json TEXT;
    ALTER TABLE workflows ADD COLUMN execution_plan_version TEXT;

    UPDATE workflows
    SET definition_json = json_object(
          'schemaVersion', 1,
          'steps', json((
            SELECT json_group_array(json(node)) FROM (
              SELECT node FROM (
                SELECT 0 AS sort_order, json_object(
                'id', 'source',
                'kind', 'source',
                'sourceType', CASE WHEN EXISTS (
                  SELECT 1 FROM workflow_remote_sources r WHERE r.workflow_id = workflows.id
                ) THEN 'remote' ELSE 'watched_folder' END
                ) AS node
                UNION ALL
                SELECT position + 1 AS sort_order, json_object(
                'id', 'destination-' || (position + 1),
                'kind', 'destination',
                'destination', json(json_patch(
                  json_object('destinationId', destination_id, 'accountId', account_id),
                  json(configuration_json)
                ))
                )
                FROM workflow_destinations d WHERE d.workflow_id = workflows.id
              ) ORDER BY sort_order
            )
          )),
          'edges', json((
            SELECT json_group_array(json_object('from', 'source', 'to', 'destination-' || (position + 1)))
            FROM workflow_destinations d WHERE d.workflow_id = workflows.id
          ))
        );

    UPDATE workflows
    SET execution_plan_json = json_object(
          'planVersion', 'workflow-plan-v1',
          'definitionVersion', 1,
          'id', id,
          'name', name,
          'titleTemplate', title_template,
          'descriptionTemplate', description_template,
          'failurePolicy', failure_policy,
          'destinations', json((
            SELECT json_group_array(json(json_patch(
              json_object('destinationId', destination_id, 'accountId', account_id),
              json(configuration_json)
            ))) FROM workflow_destinations d WHERE d.workflow_id = workflows.id
          )),
          'steps', json_extract(definition_json, '$.steps')
        ),
        execution_plan_version = 'workflow-plan-v1';
  `,
};
