import type { Migration } from './types.js';

/** Durable media-resolution checkpoints and persisted source media capabilities. */
export const mediaResolutionMigration: Migration = {
  id: '0012_media_resolution',
  sql: `
    ALTER TABLE source_items ADD COLUMN media_descriptor_json TEXT;

    CREATE TABLE source_media_resolutions (
      source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE RESTRICT,
      execution_id TEXT NOT NULL REFERENCES source_workflow_executions(id) ON DELETE RESTRICT,
      job_scope_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('resolving', 'ready', 'failed', 'cancelled')),
      resolver_id TEXT,
      managed_path TEXT,
      media_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
      error_code TEXT,
      error_message TEXT,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      PRIMARY KEY (source_item_id, execution_id),
      CHECK (length(trim(job_scope_id)) > 0),
      CHECK ((status = 'ready' AND media_id IS NOT NULL AND completed_at IS NOT NULL) OR status <> 'ready'),
      CHECK ((status IN ('failed', 'cancelled') AND error_code IS NOT NULL AND completed_at IS NOT NULL) OR status NOT IN ('failed', 'cancelled'))
    );
    CREATE INDEX source_media_resolutions_recovery_idx
      ON source_media_resolutions (status, updated_at);
  `,
};
