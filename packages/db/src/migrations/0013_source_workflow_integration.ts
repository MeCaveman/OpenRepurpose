import type { Migration } from './types.js';

/** Remote workflow subscriptions plus durable job/destination result synchronization. */
export const sourceWorkflowIntegrationMigration: Migration = {
  id: '0013_source_workflow_integration',
  sql: `
    CREATE TABLE workflow_remote_sources (
      workflow_id TEXT PRIMARY KEY NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      source_connection_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE RESTRICT,
      filters_json TEXT NOT NULL,
      retention_policy TEXT NOT NULL CHECK (retention_policy IN (
        'delete_after_success', 'keep_for_duration', 'keep_forever'
      )),
      retention_duration_seconds INTEGER,
      rights_confirmed INTEGER NOT NULL CHECK (rights_confirmed IN (0, 1)),
      local_original_json TEXT,
      CHECK (
        (retention_policy = 'keep_for_duration' AND retention_duration_seconds IS NOT NULL AND
          retention_duration_seconds > 0) OR
        (retention_policy <> 'keep_for_duration' AND retention_duration_seconds IS NULL)
      )
    );
    CREATE INDEX workflow_remote_sources_connection_idx
      ON workflow_remote_sources (source_connection_id, workflow_id);

    CREATE TRIGGER source_destination_sync_after_job_update
    AFTER UPDATE OF status, attempt_count, last_error_code, last_error_message, completed_at
    ON jobs
    BEGIN
      UPDATE source_execution_destinations
      SET status = NEW.status,
          attempt_count = NEW.attempt_count,
          last_error_code = NEW.last_error_code,
          last_error_message = NEW.last_error_message,
          completed_at = CASE WHEN NEW.status = 'succeeded' THEN NEW.completed_at ELSE NULL END,
          updated_at = NEW.updated_at
      WHERE job_id = NEW.id AND status <> 'succeeded';
    END;

    CREATE TRIGGER source_destination_remote_checkpoint_after_insert
    AFTER INSERT ON destination_job_records
    BEGIN
      UPDATE source_execution_destinations
      SET remote_id = NEW.remote_id, remote_url = NEW.remote_url, updated_at = NEW.updated_at
      WHERE job_id = NEW.job_id;
    END;

    CREATE TRIGGER source_destination_remote_checkpoint_after_update
    AFTER UPDATE OF remote_id, remote_url, remote_status, updated_at ON destination_job_records
    BEGIN
      UPDATE source_execution_destinations
      SET remote_id = NEW.remote_id, remote_url = NEW.remote_url, updated_at = NEW.updated_at
      WHERE job_id = NEW.job_id;
    END;

    CREATE TRIGGER source_execution_after_destination_update
    AFTER UPDATE OF status ON source_execution_destinations
    WHEN NEW.status = 'succeeded'
      AND NOT EXISTS (
        SELECT 1 FROM source_execution_destinations
        WHERE execution_id = NEW.execution_id AND required = 1 AND status <> 'succeeded'
      )
    BEGIN
      UPDATE source_workflow_executions
      SET status = 'succeeded', completed_at = NEW.updated_at, updated_at = NEW.updated_at,
          cleanup_status = CASE
            WHEN retention_policy = 'keep_forever' THEN 'retained' ELSE 'eligible' END,
          cleanup_eligible_at = CASE
            WHEN retention_policy = 'delete_after_success' THEN NEW.updated_at
            WHEN retention_policy = 'keep_for_duration'
              THEN NEW.updated_at + (retention_duration_seconds * 1000)
            ELSE NULL END,
          cleanup_error_code = NULL, cleanup_error_message = NULL
      WHERE id = NEW.execution_id;

      UPDATE source_media_artifacts
      SET cleanup_state = CASE
            WHEN (SELECT retention_policy FROM source_workflow_executions
                  WHERE id = NEW.execution_id) = 'keep_forever' THEN 'retained'
            ELSE 'eligible' END,
          updated_at = NEW.updated_at
      WHERE execution_id = NEW.execution_id AND ownership <> 'user_owned_original';

      UPDATE source_items
      SET lifecycle_status = 'cleanup_pending', updated_at = NEW.updated_at
      WHERE id = (SELECT source_item_id FROM source_workflow_executions WHERE id = NEW.execution_id);

      UPDATE source_items
      SET lifecycle_status = 'completed', completed_at = NEW.updated_at,
          updated_at = NEW.updated_at
      WHERE id = (SELECT source_item_id FROM source_workflow_executions WHERE id = NEW.execution_id)
        AND NOT EXISTS (
          SELECT 1 FROM source_workflow_executions
          WHERE source_item_id = source_items.id
            AND cleanup_status NOT IN ('completed', 'retained')
        );
    END;

    CREATE TRIGGER source_execution_incomplete_after_destination_update
    AFTER UPDATE OF status ON source_execution_destinations
    WHEN EXISTS (
      SELECT 1 FROM source_execution_destinations
      WHERE execution_id = NEW.execution_id AND required = 1 AND status <> 'succeeded'
    )
    BEGIN
      UPDATE source_workflow_executions
      SET status = CASE
            WHEN EXISTS (
              SELECT 1 FROM source_execution_destinations
              WHERE execution_id = NEW.execution_id AND required = 1 AND status = 'failed'
            ) THEN 'failed'
            WHEN EXISTS (
              SELECT 1 FROM source_execution_destinations
              WHERE execution_id = NEW.execution_id AND required = 1 AND status = 'retrying'
            ) THEN 'retrying'
            ELSE 'running' END,
          updated_at = NEW.updated_at
      WHERE id = NEW.execution_id;

      UPDATE source_items
      SET lifecycle_status = CASE
            WHEN EXISTS (
              SELECT 1 FROM source_execution_destinations
              WHERE execution_id = NEW.execution_id AND required = 1 AND status = 'failed'
            ) THEN 'partial_failure'
            WHEN EXISTS (
              SELECT 1 FROM source_execution_destinations
              WHERE execution_id = NEW.execution_id AND required = 1 AND status = 'retrying'
            ) THEN 'retrying'
            ELSE 'publishing' END,
          updated_at = NEW.updated_at
      WHERE id = (SELECT source_item_id FROM source_workflow_executions WHERE id = NEW.execution_id)
        AND lifecycle_status <> 'completed';
    END;
  `,
};
