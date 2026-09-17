import type { Migration } from './types.js';

/** Replaces the v0.1 YouTube-only workflow columns with ordered destination records. */
export const workflowDestinationsMigration: Migration = {
  foreignKeysDisabled: true,
  id: '0008_workflow_destinations',
  sql: `
    CREATE TABLE workflows_v02 (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      source_directory TEXT NOT NULL,
      title_template TEXT NOT NULL,
      description_template TEXT NOT NULL,
      failure_policy TEXT NOT NULL CHECK (failure_policy = 'best_effort'),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO workflows_v02 (
      id, name, enabled, source_directory, title_template, description_template,
      failure_policy, created_at, updated_at
    )
    SELECT id, name, enabled, source_directory, title_template, description_template,
           'best_effort', created_at, updated_at
    FROM workflows;

    CREATE TABLE workflow_destinations (
      workflow_id TEXT NOT NULL REFERENCES workflows_v02(id) ON DELETE CASCADE,
      destination_id TEXT NOT NULL CHECK (destination_id IN ('youtube', 'tiktok')),
      account_id TEXT NOT NULL REFERENCES accounts(id),
      position INTEGER NOT NULL CHECK (position >= 0),
      configuration_json TEXT NOT NULL,
      PRIMARY KEY (workflow_id, destination_id),
      UNIQUE (workflow_id, position)
    );
    INSERT INTO workflow_destinations (
      workflow_id, destination_id, account_id, position, configuration_json
    )
    SELECT id, 'youtube', account_id, 0,
           json_object('privacy', privacy, 'category', category)
    FROM workflows;

    DROP TABLE workflows;
    ALTER TABLE workflows_v02 RENAME TO workflows;
    CREATE INDEX workflows_enabled_idx ON workflows (enabled);
    CREATE INDEX workflow_destinations_account_idx
      ON workflow_destinations (account_id);
  `,
};
