export interface Migration {
  /** Required only for SQLite parent-table rebuilds; the migration still runs in one transaction. */
  readonly foreignKeysDisabled?: boolean;
  readonly id: string;
  readonly sql: string;
}
