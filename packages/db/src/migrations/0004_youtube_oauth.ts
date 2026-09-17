import type { Migration } from './types.js';

export const youtubeOAuthMigration: Migration = {
  id: '0004_youtube_oauth',
  sql: `
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('youtube')),
      external_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('connected', 'reauthorization_required')),
      capabilities_json TEXT NOT NULL,
      connected_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX accounts_provider_external_id_idx
      ON accounts (provider, external_id);
    CREATE INDEX accounts_provider_status_idx ON accounts (provider, status);

    CREATE TABLE oauth_authorization_requests (
      id TEXT PRIMARY KEY NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('youtube')),
      state_hash TEXT NOT NULL UNIQUE,
      binding_hash TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX oauth_authorization_requests_expires_at_idx
      ON oauth_authorization_requests (expires_at);
  `,
};
