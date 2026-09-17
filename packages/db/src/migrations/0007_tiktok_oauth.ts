import type { Migration } from './types.js';

/** Expands the released YouTube-only account and OAuth state constraints for TikTok. */
export const tiktokOAuthMigration: Migration = {
  foreignKeysDisabled: true,
  id: '0007_tiktok_oauth',
  sql: `
    CREATE TABLE accounts_v02 (
      id TEXT PRIMARY KEY NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('youtube', 'tiktok')),
      external_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('connected', 'reauthorization_required')),
      capabilities_json TEXT NOT NULL,
      connected_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO accounts_v02
      SELECT id, provider, external_id, display_name, status, capabilities_json,
             connected_at, updated_at
      FROM accounts;
    DROP TABLE accounts;
    ALTER TABLE accounts_v02 RENAME TO accounts;
    CREATE UNIQUE INDEX accounts_provider_external_id_idx
      ON accounts (provider, external_id);
    CREATE INDEX accounts_provider_status_idx ON accounts (provider, status);

    CREATE TABLE oauth_authorization_requests_v02 (
      id TEXT PRIMARY KEY NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('youtube', 'tiktok')),
      state_hash TEXT NOT NULL UNIQUE,
      binding_hash TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO oauth_authorization_requests_v02
      SELECT id, provider, state_hash, binding_hash, redirect_uri, expires_at, created_at
      FROM oauth_authorization_requests;
    DROP TABLE oauth_authorization_requests;
    ALTER TABLE oauth_authorization_requests_v02 RENAME TO oauth_authorization_requests;
    CREATE INDEX oauth_authorization_requests_expires_at_idx
      ON oauth_authorization_requests (expires_at);
  `,
};
