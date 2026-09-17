import type { Migration } from './types.js';

/** Packet 8 durable checkpoints; session URLs are opaque, non-secret resumable-upload identifiers. */
export const destinationJobRecordsMigration: Migration = {
  id: '0005_destination_job_records',
  sql: `
    CREATE TABLE destination_job_records (
      job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      destination_id TEXT NOT NULL,
      remote_id TEXT,
      remote_url TEXT,
      remote_status TEXT NOT NULL,
      resumable_session_url TEXT,
      uploaded_bytes INTEGER NOT NULL DEFAULT 0 CHECK (uploaded_bytes >= 0),
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX destination_job_records_remote_id_idx
      ON destination_job_records (destination_id, remote_id);
  `,
};
