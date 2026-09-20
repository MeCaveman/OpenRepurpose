import type { Migration } from './types.js';

/** Persist the latest structured FFmpeg progress snapshot for headless/background inspection. */
export const transformProgressMigration: Migration = {
  id: '0019_transform_progress',
  sql: `
    ALTER TABLE transform_derivatives ADD COLUMN progress_json TEXT
      CHECK (progress_json IS NULL OR json_valid(progress_json));
    ALTER TABLE transform_derivatives ADD COLUMN progress_updated_at INTEGER;

    CREATE INDEX transform_derivatives_progress_updated_idx
      ON transform_derivatives (status, progress_updated_at);
  `,
};
