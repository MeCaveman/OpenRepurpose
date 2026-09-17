import type { Migration } from './types.js';

export const mediaAssetsMigration: Migration = {
  id: '0002_media_assets',
  sql: `
    CREATE TABLE media_assets (
      id TEXT PRIMARY KEY NOT NULL,
      path TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
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
    CREATE INDEX media_assets_created_at_idx ON media_assets (created_at DESC);
  `,
};
