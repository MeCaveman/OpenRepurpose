import { initialSettingsMigration } from './0001_initial_settings.js';
import { mediaAssetsMigration } from './0002_media_assets.js';
import { persistentJobsMigration } from './0003_persistent_jobs.js';
import { youtubeOAuthMigration } from './0004_youtube_oauth.js';
import { destinationJobRecordsMigration } from './0005_destination_job_records.js';
import { workflowsMigration } from './0006_workflows.js';
import { tiktokOAuthMigration } from './0007_tiktok_oauth.js';
import type { Migration } from './types.js';

/** Ordered, immutable migration ledger. Never alter a released migration's SQL. */
export const migrations: readonly Migration[] = [
  initialSettingsMigration,
  mediaAssetsMigration,
  persistentJobsMigration,
  youtubeOAuthMigration,
  destinationJobRecordsMigration,
  workflowsMigration,
  tiktokOAuthMigration,
];
export type { Migration } from './types.js';
