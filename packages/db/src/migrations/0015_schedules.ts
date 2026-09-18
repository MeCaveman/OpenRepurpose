import type { Migration } from './types.js';

/** Durable schedule checkpoints and immutable materialized occurrence history. */
export const schedulesMigration: Migration = {
  id: '0015_schedules',
  sql: `
    ALTER TABLE source_connections ADD COLUMN cadence_owner TEXT NOT NULL DEFAULT 'interval'
      CHECK (cadence_owner IN ('interval', 'schedule'));
    ALTER TABLE source_connections ADD COLUMN scheduled_poll_pending INTEGER NOT NULL DEFAULT 0
      CHECK (scheduled_poll_pending IN (0, 1));
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
      revision INTEGER NOT NULL,
      target_json TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      time_zone TEXT NOT NULL,
      next_occurrence_at INTEGER,
      last_occurrence_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX schedules_due_idx ON schedules (status, next_occurrence_at);
    CREATE TABLE schedule_occurrences (
      id TEXT PRIMARY KEY NOT NULL,
      schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE RESTRICT,
      schedule_revision INTEGER NOT NULL,
      scheduled_for_utc INTEGER NOT NULL,
      target_json TEXT NOT NULL,
      dispatch_status TEXT NOT NULL CHECK (dispatch_status IN ('pending_dispatch', 'dispatched', 'failed')),
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (schedule_id, schedule_revision, scheduled_for_utc)
    );
    CREATE INDEX schedule_occurrences_dispatch_idx ON schedule_occurrences (dispatch_status, created_at);
  `,
};
