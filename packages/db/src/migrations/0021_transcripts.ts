import type { Migration } from './types.js';

/** Durable provider-neutral transcription cache, provenance, and editable cue records. */
export const transcriptsMigration: Migration = {
  id: '0021_transcripts',
  sql: `
    CREATE TABLE transcripts (
      id TEXT PRIMARY KEY NOT NULL,
      media_id TEXT REFERENCES media_assets(id) ON DELETE RESTRICT,
      derivative_id TEXT REFERENCES transform_derivatives(id) ON DELETE RESTRICT,
      source_audio_fingerprint TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_version TEXT NOT NULL,
      language TEXT,
      options_json TEXT NOT NULL,
      has_user_edits INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      generated_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CONSTRAINT transcripts_source_check CHECK ((media_id IS NULL) <> (derivative_id IS NULL)),
      CONSTRAINT transcripts_options_json_check CHECK (json_valid(options_json)),
      CONSTRAINT transcripts_revision_check CHECK (revision >= 0)
    );
    CREATE UNIQUE INDEX transcripts_cache_key_idx ON transcripts (cache_key);
    CREATE INDEX transcripts_media_created_idx ON transcripts (media_id, created_at);
    CREATE INDEX transcripts_derivative_created_idx ON transcripts (derivative_id, created_at);

    CREATE TABLE transcript_cues (
      transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      start_millis INTEGER NOT NULL,
      end_millis INTEGER NOT NULL,
      text TEXT NOT NULL,
      words_json TEXT,
      PRIMARY KEY (transcript_id, position),
      CONSTRAINT transcript_cues_position_check CHECK (position >= 0),
      CONSTRAINT transcript_cues_time_check CHECK (start_millis >= 0 AND end_millis > start_millis),
      CONSTRAINT transcript_cues_text_check CHECK (length(trim(text)) > 0),
      CONSTRAINT transcript_cues_words_json_check CHECK (words_json IS NULL OR json_valid(words_json))
    );
  `,
};
