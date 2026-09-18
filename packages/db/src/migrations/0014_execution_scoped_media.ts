import type { Migration } from './types.js';

/** Permit identical bytes to have distinct execution-owned paths and retention lifetimes. */
export const executionScopedMediaMigration: Migration = {
  id: '0014_execution_scoped_media',
  foreignKeysDisabled: true,
  sql: `
    CREATE TABLE media_assets_next (
      id TEXT PRIMARY KEY NOT NULL,
      path TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      modified_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('available', 'missing')),
      duration_millis INTEGER,
      video_codec TEXT,
      audio_codec TEXT,
      width INTEGER,
      height INTEGER,
      frame_rate_milli INTEGER,
      has_audio INTEGER NOT NULL CHECK (has_audio IN (0, 1)),
      created_at INTEGER NOT NULL
    );
    INSERT INTO media_assets_next (
      id, path, fingerprint, size_bytes, modified_at, state, duration_millis, video_codec,
      audio_codec, width, height, frame_rate_milli, has_audio, created_at
    ) SELECT
      id, path, fingerprint, size_bytes, modified_at, state, duration_millis, video_codec,
      audio_codec, width, height, frame_rate_milli, has_audio, created_at
    FROM media_assets;
    DROP TABLE media_assets;
    ALTER TABLE media_assets_next RENAME TO media_assets;
    CREATE INDEX media_assets_created_at_idx ON media_assets (created_at DESC);
    CREATE INDEX media_assets_fingerprint_idx ON media_assets (fingerprint);
  `,
};
