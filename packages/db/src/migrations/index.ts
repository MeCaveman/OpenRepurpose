import { initialSettingsMigration } from './0001_initial_settings.js';
import type { Migration } from './types.js';

/** Ordered, immutable migration ledger. Never alter a released migration's SQL. */
export const migrations: readonly Migration[] = [initialSettingsMigration];
export type { Migration } from './types.js';
