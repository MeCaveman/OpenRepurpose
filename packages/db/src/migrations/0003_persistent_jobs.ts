import type { Migration } from './types.js';

export const persistentJobsMigration: Migration = {
  id: '0003_persistent_jobs',
  sql: `
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'retrying', 'succeeded', 'failed', 'cancelled')),
      input_json TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      available_at INTEGER NOT NULL,
      lease_owner TEXT,
      lease_expires_at INTEGER,
      cancellation_requested_at INTEGER,
      last_error_code TEXT,
      last_error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX jobs_status_available_at_idx ON jobs (status, available_at);
    CREATE INDEX jobs_lease_expires_at_idx ON jobs (lease_expires_at);

    CREATE TABLE job_attempts (
      id TEXT PRIMARY KEY NOT NULL,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
      lease_owner TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      error_code TEXT,
      error_message TEXT,
      retryable INTEGER CHECK (retryable IN (0, 1)),
      UNIQUE (job_id, attempt_number)
    );
    CREATE INDEX job_attempts_job_id_idx ON job_attempts (job_id, attempt_number);
  `,
};
