import type { Migration } from './types.js';

/** Allows exact Instagram professional and Facebook Page target IDs in workflows. */
export const metaWorkflowDestinationsMigration: Migration = {
  foreignKeysDisabled: true,
  id: '0010_meta_workflow_destinations',
  sql: `
    CREATE TABLE workflow_destinations_v03 (
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      destination_id TEXT NOT NULL CHECK (destination_id IN ('youtube', 'tiktok', 'instagram', 'facebook')),
      account_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      configuration_json TEXT NOT NULL,
      PRIMARY KEY (workflow_id, destination_id, account_id),
      UNIQUE (workflow_id, position)
    );
    INSERT INTO workflow_destinations_v03
      SELECT workflow_id, destination_id, account_id, position, configuration_json
      FROM workflow_destinations;
    DROP TABLE workflow_destinations;
    ALTER TABLE workflow_destinations_v03 RENAME TO workflow_destinations;
    CREATE UNIQUE INDEX workflow_destinations_workflow_destination_idx
      ON workflow_destinations (workflow_id, destination_id, account_id);
    CREATE UNIQUE INDEX workflow_destinations_workflow_position_idx
      ON workflow_destinations (workflow_id, position);
    CREATE INDEX workflow_destinations_account_idx ON workflow_destinations (account_id);
  `,
};
