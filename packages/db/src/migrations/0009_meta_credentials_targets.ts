import type { Migration } from './types.js';

/** Adds Meta's identity/target split and admits Meta OAuth state records. */
export const metaCredentialsTargetsMigration: Migration = {
  foreignKeysDisabled: true,
  id: '0009_meta_credentials_targets',
  sql: `
    CREATE TABLE oauth_authorization_requests_v03 (
      id TEXT PRIMARY KEY NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('youtube', 'tiktok', 'meta')),
      state_hash TEXT NOT NULL UNIQUE,
      binding_hash TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO oauth_authorization_requests_v03
      SELECT id, provider, state_hash, binding_hash, redirect_uri, expires_at, created_at
      FROM oauth_authorization_requests;
    DROP TABLE oauth_authorization_requests;
    ALTER TABLE oauth_authorization_requests_v03 RENAME TO oauth_authorization_requests;
    CREATE INDEX oauth_authorization_requests_expires_at_idx
      ON oauth_authorization_requests (expires_at);

    CREATE TABLE meta_credentials (
      id TEXT PRIMARY KEY NOT NULL,
      external_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('connected', 'reauthorization_required')),
      scopes_json TEXT NOT NULL,
      token_expires_at INTEGER NOT NULL,
      connected_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX meta_credentials_status_idx ON meta_credentials (status);

    CREATE TABLE meta_publish_targets (
      id TEXT PRIMARY KEY NOT NULL,
      credential_id TEXT NOT NULL REFERENCES meta_credentials(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('facebook_page', 'instagram_professional')),
      external_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      username TEXT,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      availability TEXT NOT NULL CHECK (availability IN ('available', 'blocked')),
      blocker TEXT,
      updated_at INTEGER NOT NULL,
      UNIQUE (credential_id, kind, external_id)
    );
    CREATE INDEX meta_targets_credential_idx ON meta_publish_targets (credential_id);
  `,
};
