import type { Migration } from './types.js';

export const initialSettingsMigration: Migration = {
  id: '0001_initial_settings',
  sql: `
    CREATE TABLE settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `,
};
