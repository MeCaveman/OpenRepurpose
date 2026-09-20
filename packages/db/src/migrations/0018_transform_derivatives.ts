import type { Migration } from './types.js';

/** Durable transform cache identity, state, finalized output metadata, and provenance. */
export const transformDerivativesMigration: Migration = {
  id: '0018_transform_derivatives',
  sql: `
    CREATE TABLE transform_derivatives (
      id TEXT PRIMARY KEY NOT NULL,
      source_media_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
      source_fingerprint TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      recipe_hash TEXT NOT NULL,
      normalized_plan_json TEXT NOT NULL CHECK (json_valid(normalized_plan_json)),
      output_profile_version TEXT NOT NULL,
      ffmpeg_version TEXT NOT NULL,
      encoder TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
      output_path TEXT,
      output_size_bytes INTEGER,
      output_duration_millis INTEGER,
      output_video_codec TEXT,
      output_audio_codec TEXT,
      output_width INTEGER,
      output_height INTEGER,
      output_frame_rate_milli INTEGER,
      output_has_audio INTEGER,
      error_code TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      CONSTRAINT transform_derivatives_success_output_check CHECK (
        (
          status = 'succeeded'
          AND output_path IS NOT NULL
          AND output_size_bytes IS NOT NULL
          AND output_duration_millis IS NOT NULL
          AND output_video_codec IS NOT NULL
          AND output_width IS NOT NULL
          AND output_height IS NOT NULL
          AND output_has_audio IS NOT NULL
          AND completed_at IS NOT NULL
        ) OR (
          status <> 'succeeded'
          AND output_path IS NULL
          AND output_size_bytes IS NULL
          AND output_duration_millis IS NULL
          AND output_video_codec IS NULL
          AND output_audio_codec IS NULL
          AND output_width IS NULL
          AND output_height IS NULL
          AND output_frame_rate_milli IS NULL
          AND output_has_audio IS NULL
        )
      ),
      CONSTRAINT transform_derivatives_completion_check CHECK (
        (status IN ('pending', 'running') AND completed_at IS NULL)
        OR (status IN ('succeeded', 'failed', 'cancelled') AND completed_at IS NOT NULL)
      ),
      CONSTRAINT transform_derivatives_error_check CHECK (
        status = 'failed' OR (error_code IS NULL AND error_message IS NULL)
      ),
      CONSTRAINT transform_derivatives_numeric_output_check CHECK (
        (output_size_bytes IS NULL OR output_size_bytes >= 0)
        AND (output_duration_millis IS NULL OR output_duration_millis >= 0)
        AND (output_width IS NULL OR output_width > 0)
        AND (output_height IS NULL OR output_height > 0)
        AND (output_frame_rate_milli IS NULL OR output_frame_rate_milli > 0)
      ),
      CONSTRAINT transform_derivatives_audio_output_check CHECK (
        output_has_audio IS NULL
        OR (output_has_audio = 0 AND output_audio_codec IS NULL)
        OR (output_has_audio = 1 AND output_audio_codec IS NOT NULL)
      )
    );

    CREATE UNIQUE INDEX transform_derivatives_cache_key_idx
      ON transform_derivatives (cache_key);
    CREATE INDEX transform_derivatives_source_created_idx
      ON transform_derivatives (source_media_id, created_at);
    CREATE INDEX transform_derivatives_status_updated_idx
      ON transform_derivatives (status, updated_at);
  `,
};
