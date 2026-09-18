import type { Migration } from './types.js';

/** Durable queue mode, concurrency scopes, cooldowns, and account circuit state. */
export const jobControlsMigration: Migration = {
  id: '0016_job_controls',
  sql: `
    ALTER TABLE jobs ADD COLUMN platform_id TEXT;
    ALTER TABLE jobs ADD COLUMN account_id TEXT;

    UPDATE jobs
    SET platform_id = CASE
          WHEN type = 'youtube.upload' THEN 'youtube'
          WHEN type = 'tiktok.direct-post' THEN 'tiktok'
          WHEN type = 'instagram.reels.publish' THEN 'instagram'
          WHEN type = 'facebook.reels.publish' THEN 'facebook'
          ELSE NULL
        END,
        account_id = CASE
          WHEN type IN ('youtube.upload', 'tiktok.direct-post') AND json_valid(input_json)
            THEN json_extract(input_json, '$.accountId')
          WHEN type IN ('instagram.reels.publish', 'facebook.reels.publish') AND json_valid(input_json)
            THEN json_extract(input_json, '$.targetId')
          ELSE NULL
        END;

    CREATE INDEX jobs_running_platform_idx ON jobs (status, platform_id);
    CREATE INDEX jobs_running_account_idx ON jobs (status, platform_id, account_id);

    CREATE TABLE job_queue_control (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
      mode TEXT NOT NULL CHECK (mode IN ('running', 'paused', 'draining')),
      updated_at INTEGER NOT NULL
    );
    INSERT INTO job_queue_control (singleton, mode, updated_at) VALUES (1, 'running', 0);

    CREATE TABLE job_platform_controls (
      platform_id TEXT PRIMARY KEY NOT NULL,
      cooldown_until INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE job_account_controls (
      platform_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
      pause_reason TEXT,
      auth_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (auth_failure_count >= 0),
      cooldown_until INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (platform_id, account_id)
    );
    CREATE INDEX job_account_controls_status_idx
      ON job_account_controls (status, cooldown_until);
  `,
};
