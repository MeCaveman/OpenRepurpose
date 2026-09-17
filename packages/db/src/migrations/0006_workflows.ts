import type { Migration } from './types.js';

/** Packet 9 watched-folder workflow definitions and durable source-settlement cursors. */
export const workflowsMigration: Migration = {
  id: '0006_workflows',
  sql: `
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      source_directory TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      title_template TEXT NOT NULL,
      description_template TEXT NOT NULL,
      privacy TEXT NOT NULL CHECK (privacy IN ('private', 'public', 'unlisted')),
      category TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX workflows_enabled_idx ON workflows (enabled);
    CREATE TABLE source_cursors (
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      source_key TEXT NOT NULL,
      path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      modified_at INTEGER NOT NULL,
      observed_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'processed')),
      media_id TEXT REFERENCES media_assets(id),
      PRIMARY KEY (workflow_id, source_key)
    );
  `,
};
