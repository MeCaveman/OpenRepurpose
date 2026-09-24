import { createHash } from 'node:crypto';

export interface Migration {
  /** Required only for SQLite parent-table rebuilds; the migration still runs in one transaction. */
  readonly foreignKeysDisabled?: boolean;
  readonly id: string;
  readonly sql: string;
}

/** Stable checksum used by both the migration ledger and portable-backup validation. */
export function migrationChecksum(migration: Migration): string {
  return createHash('sha256')
    .update(migration.sql)
    .update(migration.foreignKeysDisabled === true ? '\nforeign_keys_disabled=true' : '')
    .digest('hex');
}
