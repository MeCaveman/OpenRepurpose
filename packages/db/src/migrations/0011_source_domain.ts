import type { Migration } from './types.js';

/** Durable remote-source identity, execution, destination, and media-ownership foundations. */
export const sourceDomainMigration: Migration = {
  id: '0011_source_domain',
  sql: `
    CREATE TABLE source_connections (
      id TEXT PRIMARY KEY NOT NULL,
      adapter_id TEXT NOT NULL,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      external_source_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      configuration_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'authorization_failed')),
      cursor_json TEXT,
      watermark_published_at INTEGER,
      watermark_external_id TEXT,
      last_poll_at INTEGER,
      last_successful_poll_at INTEGER,
      last_poll_error_code TEXT,
      last_poll_error_message TEXT,
      consecutive_poll_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_poll_failures >= 0),
      next_poll_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (adapter_id, external_source_id),
      CHECK (
        (watermark_published_at IS NULL AND watermark_external_id IS NULL) OR
        (watermark_published_at IS NOT NULL AND watermark_external_id IS NOT NULL)
      )
    );
    CREATE INDEX source_connections_status_next_poll_idx
      ON source_connections (status, next_poll_at);

    CREATE TRIGGER source_connection_identity_is_immutable
    BEFORE UPDATE OF adapter_id, external_source_id ON source_connections
    WHEN OLD.adapter_id <> NEW.adapter_id OR OLD.external_source_id <> NEW.external_source_id
    BEGIN
      SELECT RAISE(ABORT, 'source connection identity is immutable');
    END;

    CREATE TABLE source_items (
      id TEXT PRIMARY KEY NOT NULL,
      source_connection_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE RESTRICT,
      external_id TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      event_id TEXT,
      published_at INTEGER,
      first_observed_at INTEGER NOT NULL,
      last_observed_at INTEGER NOT NULL,
      metadata_json TEXT NOT NULL,
      lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN (
        'observed', 'queued', 'resolving', 'media_ready', 'processing', 'publishing',
        'partial_failure', 'retrying', 'published', 'cleanup_pending', 'completed', 'failed'
      )),
      resolution_status TEXT NOT NULL CHECK (resolution_status IN (
        'unresolved', 'resolving', 'ready', 'unavailable', 'failed'
      )),
      linked_media_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
      completed_at INTEGER,
      updated_at INTEGER NOT NULL,
      UNIQUE (source_connection_id, external_id),
      UNIQUE (source_connection_id, dedupe_key),
      CHECK (length(trim(external_id)) > 0),
      CHECK (last_observed_at >= first_observed_at),
      CHECK ((lifecycle_status = 'completed') = (completed_at IS NOT NULL))
    );
    CREATE INDEX source_items_connection_observed_idx
      ON source_items (source_connection_id, first_observed_at);
    CREATE INDEX source_items_lifecycle_idx ON source_items (lifecycle_status, updated_at);

    CREATE TRIGGER source_item_identity_is_immutable
    BEFORE UPDATE OF source_connection_id, external_id, dedupe_key ON source_items
    WHEN OLD.source_connection_id <> NEW.source_connection_id
      OR OLD.external_id <> NEW.external_id
      OR OLD.dedupe_key <> NEW.dedupe_key
    BEGIN
      SELECT RAISE(ABORT, 'source item identity is immutable');
    END;

    CREATE TABLE source_workflow_executions (
      id TEXT PRIMARY KEY NOT NULL,
      source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE RESTRICT,
      workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
      workflow_key TEXT NOT NULL,
      workflow_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'pending', 'running', 'waiting', 'retrying', 'succeeded', 'failed', 'cancelled'
      )),
      snapshot_json TEXT NOT NULL,
      retention_policy TEXT NOT NULL CHECK (retention_policy IN (
        'delete_after_success', 'keep_for_duration', 'keep_forever'
      )),
      retention_duration_seconds INTEGER,
      cleanup_status TEXT NOT NULL CHECK (cleanup_status IN (
        'not_eligible', 'eligible', 'scheduled', 'running', 'completed', 'failed', 'retained'
      )),
      cleanup_eligible_at INTEGER,
      cleanup_error_code TEXT,
      cleanup_error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE (source_item_id, workflow_key, workflow_version),
      CHECK (length(trim(workflow_key)) > 0),
      CHECK (length(trim(workflow_version)) > 0),
      CHECK (
        (retention_policy = 'keep_for_duration' AND retention_duration_seconds IS NOT NULL AND
          retention_duration_seconds > 0) OR
        (retention_policy <> 'keep_for_duration' AND retention_duration_seconds IS NULL)
      ),
      CHECK (
        (retention_policy = 'keep_forever' AND cleanup_status IN ('not_eligible', 'retained')) OR
        retention_policy <> 'keep_forever'
      ),
      CHECK (
        (cleanup_status IN ('eligible', 'scheduled', 'running', 'completed', 'failed') AND
          cleanup_eligible_at IS NOT NULL) OR
        (cleanup_status IN ('not_eligible', 'retained') AND cleanup_eligible_at IS NULL)
      )
    );
    CREATE INDEX source_workflow_executions_item_idx
      ON source_workflow_executions (source_item_id, created_at);
    CREATE INDEX source_workflow_executions_recovery_idx
      ON source_workflow_executions (status, updated_at);
    CREATE INDEX source_workflow_executions_cleanup_idx
      ON source_workflow_executions (cleanup_status, cleanup_eligible_at);

    CREATE TRIGGER source_execution_snapshot_is_immutable
    BEFORE UPDATE OF source_item_id, workflow_key, workflow_version, snapshot_json,
      retention_policy, retention_duration_seconds
    ON source_workflow_executions
    WHEN OLD.source_item_id <> NEW.source_item_id
      OR OLD.workflow_key <> NEW.workflow_key
      OR OLD.workflow_version <> NEW.workflow_version
      OR OLD.snapshot_json <> NEW.snapshot_json
      OR OLD.retention_policy <> NEW.retention_policy
      OR OLD.retention_duration_seconds IS NOT NEW.retention_duration_seconds
    BEGIN
      SELECT RAISE(ABORT, 'source execution snapshot is immutable');
    END;

    CREATE TABLE source_execution_destinations (
      id TEXT PRIMARY KEY NOT NULL,
      execution_id TEXT NOT NULL REFERENCES source_workflow_executions(id) ON DELETE RESTRICT,
      destination_key TEXT NOT NULL,
      destination_id TEXT NOT NULL,
      required INTEGER NOT NULL CHECK (required IN (0, 1)),
      job_id TEXT UNIQUE REFERENCES jobs(id) ON DELETE SET NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN (
        'pending', 'running', 'waiting', 'retrying', 'succeeded', 'failed', 'cancelled'
      )),
      remote_id TEXT,
      remote_url TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error_code TEXT,
      last_error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE (execution_id, destination_key),
      CHECK (length(trim(destination_key)) > 0),
      CHECK (length(trim(idempotency_key)) > 0),
      CHECK ((status = 'succeeded' AND completed_at IS NOT NULL) OR status <> 'succeeded')
    );
    CREATE INDEX source_execution_destinations_recovery_idx
      ON source_execution_destinations (execution_id, status);

    CREATE TRIGGER source_destination_intent_is_immutable
    BEFORE UPDATE OF execution_id, destination_key, destination_id, required, idempotency_key
    ON source_execution_destinations
    WHEN OLD.execution_id <> NEW.execution_id
      OR OLD.destination_key <> NEW.destination_key
      OR OLD.destination_id <> NEW.destination_id
      OR OLD.required <> NEW.required
      OR OLD.idempotency_key <> NEW.idempotency_key
    BEGIN
      SELECT RAISE(ABORT, 'source destination intent is immutable');
    END;

    CREATE TRIGGER source_destination_success_is_terminal
    BEFORE UPDATE OF status ON source_execution_destinations
    WHEN OLD.status = 'succeeded' AND NEW.status <> 'succeeded'
    BEGIN
      SELECT RAISE(ABORT, 'a successful destination checkpoint is terminal');
    END;

    CREATE TRIGGER source_cleanup_requires_destination_success
    BEFORE UPDATE OF cleanup_status ON source_workflow_executions
    WHEN NEW.cleanup_status IN ('eligible', 'scheduled', 'running', 'completed', 'failed')
      AND EXISTS (
        SELECT 1 FROM source_execution_destinations
        WHERE execution_id = NEW.id AND required = 1 AND status <> 'succeeded'
      )
    BEGIN
      SELECT RAISE(ABORT, 'required destinations must succeed before cleanup');
    END;

    CREATE TRIGGER source_destination_cannot_invalidate_cleanup_insert
    BEFORE INSERT ON source_execution_destinations
    WHEN NEW.required = 1 AND NEW.status <> 'succeeded'
      AND EXISTS (
        SELECT 1 FROM source_workflow_executions
        WHERE id = NEW.execution_id
          AND cleanup_status IN ('eligible', 'scheduled', 'running', 'completed', 'failed')
      )
    BEGIN
      SELECT RAISE(ABORT, 'required destinations must succeed before cleanup');
    END;

    CREATE TRIGGER source_destination_cannot_invalidate_cleanup_update
    BEFORE UPDATE OF required, status ON source_execution_destinations
    WHEN NEW.required = 1 AND NEW.status <> 'succeeded'
      AND EXISTS (
        SELECT 1 FROM source_workflow_executions
        WHERE id = NEW.execution_id
          AND cleanup_status IN ('eligible', 'scheduled', 'running', 'completed', 'failed')
      )
    BEGIN
      SELECT RAISE(ABORT, 'required destinations must succeed before cleanup');
    END;

    CREATE TABLE source_media_artifacts (
      id TEXT PRIMARY KEY NOT NULL,
      source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE RESTRICT,
      execution_id TEXT REFERENCES source_workflow_executions(id) ON DELETE RESTRICT,
      media_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
      path TEXT NOT NULL,
      ownership TEXT NOT NULL CHECK (ownership IN (
        'user_owned_original', 'openrepurpose_temporary', 'openrepurpose_generated'
      )),
      state TEXT NOT NULL CHECK (state IN ('available', 'missing', 'deleted')),
      cleanup_state TEXT NOT NULL CHECK (cleanup_state IN (
        'protected', 'not_eligible', 'eligible', 'scheduled', 'running', 'completed', 'failed',
        'retained'
      )),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      UNIQUE (source_item_id, path, ownership),
      CHECK (length(trim(path)) > 0),
      CHECK (
        (ownership = 'user_owned_original' AND cleanup_state = 'protected' AND
          state <> 'deleted' AND deleted_at IS NULL) OR
        (ownership <> 'user_owned_original' AND cleanup_state <> 'protected' AND
          execution_id IS NOT NULL)
      ),
      CHECK ((state = 'deleted' AND deleted_at IS NOT NULL) OR (state <> 'deleted' AND deleted_at IS NULL))
    );
    CREATE INDEX source_media_artifacts_cleanup_idx
      ON source_media_artifacts (ownership, cleanup_state, updated_at);

    CREATE TRIGGER source_media_artifact_ownership_is_immutable
    BEFORE UPDATE OF source_item_id, execution_id, path, ownership ON source_media_artifacts
    WHEN OLD.source_item_id <> NEW.source_item_id
      OR OLD.execution_id IS NOT NEW.execution_id
      OR OLD.path <> NEW.path
      OR OLD.ownership <> NEW.ownership
    BEGIN
      SELECT RAISE(ABORT, 'source media artifact ownership is immutable');
    END;

    CREATE TRIGGER source_media_cleanup_requires_execution_eligibility_insert
    BEFORE INSERT ON source_media_artifacts
    WHEN NEW.ownership <> 'user_owned_original'
      AND (NEW.state = 'deleted' OR NEW.cleanup_state IN ('eligible', 'scheduled', 'running', 'completed', 'failed'))
      AND NOT EXISTS (
        SELECT 1 FROM source_workflow_executions
        WHERE id = NEW.execution_id
          AND cleanup_status IN ('eligible', 'scheduled', 'running', 'completed', 'failed')
      )
    BEGIN
      SELECT RAISE(ABORT, 'managed media cleanup requires an eligible execution');
    END;

    CREATE TRIGGER source_media_cleanup_requires_execution_eligibility
    BEFORE UPDATE OF state, cleanup_state ON source_media_artifacts
    WHEN NEW.ownership <> 'user_owned_original'
      AND (NEW.state = 'deleted' OR NEW.cleanup_state IN ('eligible', 'scheduled', 'running', 'completed', 'failed'))
      AND NOT EXISTS (
        SELECT 1 FROM source_workflow_executions
        WHERE id = NEW.execution_id
          AND cleanup_status IN ('eligible', 'scheduled', 'running', 'completed', 'failed')
      )
    BEGIN
      SELECT RAISE(ABORT, 'managed media cleanup requires an eligible execution');
    END;

    CREATE TRIGGER source_media_artifact_history_is_persistent
    BEFORE DELETE ON source_media_artifacts
    BEGIN
      SELECT RAISE(ABORT, 'source media artifact history must be retained');
    END;
  `,
};
