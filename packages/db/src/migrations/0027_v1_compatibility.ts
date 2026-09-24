import type { Migration } from './types.js';

/**
 * Establishes the v1 compatibility boundary without rewriting the final v0.9 schema or user data.
 * Recording this boundary also makes the normal migration runner create a v0.9 pre-upgrade backup.
 */
export const v1CompatibilityMigration: Migration = {
  id: '0027_v1_compatibility',
  sql: 'SELECT 1;',
};
