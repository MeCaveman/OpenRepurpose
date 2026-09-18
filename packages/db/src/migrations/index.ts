import { initialSettingsMigration } from './0001_initial_settings.js';
import { mediaAssetsMigration } from './0002_media_assets.js';
import { persistentJobsMigration } from './0003_persistent_jobs.js';
import { youtubeOAuthMigration } from './0004_youtube_oauth.js';
import { destinationJobRecordsMigration } from './0005_destination_job_records.js';
import { workflowsMigration } from './0006_workflows.js';
import { tiktokOAuthMigration } from './0007_tiktok_oauth.js';
import { workflowDestinationsMigration } from './0008_workflow_destinations.js';
import { metaCredentialsTargetsMigration } from './0009_meta_credentials_targets.js';
import { metaWorkflowDestinationsMigration } from './0010_meta_workflow_destinations.js';
import { sourceDomainMigration } from './0011_source_domain.js';
import { mediaResolutionMigration } from './0012_media_resolution.js';
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
  workflowDestinationsMigration,
  metaCredentialsTargetsMigration,
  metaWorkflowDestinationsMigration,
  sourceDomainMigration,
  mediaResolutionMigration,
];
export type { Migration } from './types.js';
