import type { Migration } from './types.js';

/** Persists explicit webhook allowlist entries and delivery history; signing keys stay in SecretStore. */
export const webhooksMigration: Migration = {
  id: '0026_webhooks',
  sql: `
    CREATE TABLE webhook_destinations (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      events_json TEXT NOT NULL CHECK (json_valid(events_json)),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE webhook_deliveries (
      id TEXT PRIMARY KEY NOT NULL,
      destination_id TEXT NOT NULL REFERENCES webhook_destinations(id) ON DELETE RESTRICT,
      job_id TEXT REFERENCES jobs(id) ON DELETE RESTRICT,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN (
        'job.failed', 'job.succeeded',
        'workflow.execution.completed', 'workflow.execution.started'
      )),
      url TEXT NOT NULL,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'retrying', 'succeeded', 'failed')),
      last_response_status INTEGER,
      last_error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE (destination_id, event_id),
      CHECK (
        (status IN ('succeeded', 'failed') AND completed_at IS NOT NULL) OR
        (status IN ('pending', 'running', 'retrying') AND completed_at IS NULL)
      )
    );
    CREATE UNIQUE INDEX webhook_deliveries_job_id_idx ON webhook_deliveries (job_id);
    CREATE INDEX webhook_deliveries_status_created_idx
      ON webhook_deliveries (status, created_at DESC);
  `,
};
