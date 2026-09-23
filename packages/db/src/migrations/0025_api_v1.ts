import type { Migration } from './types.js';

/** Persists verifier-only API credentials and replay-safe v1 side effects. */
export const apiV1Migration: Migration = {
  id: '0025_api_v1',
  sql: `
    CREATE TABLE api_tokens (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      verifier TEXT NOT NULL,
      permissions_json TEXT NOT NULL CHECK (json_valid(permissions_json)),
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    );
    CREATE INDEX api_tokens_created_at_idx ON api_tokens (created_at DESC);

    CREATE TABLE api_idempotency_records (
      subject TEXT NOT NULL,
      operation TEXT NOT NULL,
      key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
      status_code INTEGER,
      response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (subject, operation, key),
      CHECK (
        (status = 'pending' AND status_code IS NULL AND response_json IS NULL) OR
        (status = 'completed' AND status_code IS NOT NULL AND response_json IS NOT NULL)
      )
    );
    CREATE INDEX api_idempotency_updated_at_idx ON api_idempotency_records (updated_at);
  `,
};
