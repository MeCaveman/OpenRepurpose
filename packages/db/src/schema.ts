import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Durable user-configurable settings. Feature tables are introduced by their owning packets. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const mediaAssets = sqliteTable('media_assets', {
  id: text('id').primaryKey(),
  path: text('path').notNull(),
  fingerprint: text('fingerprint').notNull().unique(),
  sizeBytes: integer('size_bytes').notNull(),
  modifiedAt: integer('modified_at', { mode: 'timestamp_ms' }).notNull(),
  state: text('state', { enum: ['available', 'missing'] }).notNull(),
  durationMillis: integer('duration_millis'),
  videoCodec: text('video_codec'),
  audioCodec: text('audio_codec'),
  width: integer('width'),
  height: integer('height'),
  frameRateMilli: integer('frame_rate_milli'),
  hasAudio: integer('has_audio', { mode: 'boolean' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    status: text('status', {
      enum: ['pending', 'running', 'retrying', 'succeeded', 'failed', 'cancelled'],
    }).notNull(),
    inputJson: text('input_json').notNull(),
    idempotencyKey: text('idempotency_key'),
    maxAttempts: integer('max_attempts').notNull(),
    attemptCount: integer('attempt_count').notNull(),
    availableAt: integer('available_at', { mode: 'timestamp_ms' }).notNull(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: integer('lease_expires_at', { mode: 'timestamp_ms' }),
    cancellationRequestedAt: integer('cancellation_requested_at', { mode: 'timestamp_ms' }),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    uniqueIndex('jobs_idempotency_key_idx').on(table.idempotencyKey),
    index('jobs_status_available_at_idx').on(table.status, table.availableAt),
    index('jobs_lease_expires_at_idx').on(table.leaseExpiresAt),
  ],
);

export const jobAttempts = sqliteTable(
  'job_attempts',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    status: text('status', { enum: ['running', 'succeeded', 'failed', 'cancelled'] }).notNull(),
    leaseOwner: text('lease_owner').notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    retryable: integer('retryable', { mode: 'boolean' }),
  },
  (table) => [
    uniqueIndex('job_attempts_job_number_idx').on(table.jobId, table.attemptNumber),
    index('job_attempts_job_id_idx').on(table.jobId),
  ],
);

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    provider: text('provider', { enum: ['youtube', 'tiktok'] }).notNull(),
    externalId: text('external_id').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status', { enum: ['connected', 'reauthorization_required'] }).notNull(),
    capabilitiesJson: text('capabilities_json').notNull(),
    connectedAt: integer('connected_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('accounts_provider_external_id_idx').on(table.provider, table.externalId),
    index('accounts_provider_status_idx').on(table.provider, table.status),
  ],
);

export const oauthAuthorizationRequests = sqliteTable(
  'oauth_authorization_requests',
  {
    id: text('id').primaryKey(),
    provider: text('provider', { enum: ['youtube', 'tiktok', 'meta'] }).notNull(),
    stateHash: text('state_hash').notNull().unique(),
    bindingHash: text('binding_hash').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('oauth_authorization_requests_expires_at_idx').on(table.expiresAt)],
);

export const metaCredentials = sqliteTable(
  'meta_credentials',
  {
    id: text('id').primaryKey(),
    externalId: text('external_id').notNull().unique(),
    displayName: text('display_name').notNull(),
    status: text('status', { enum: ['connected', 'reauthorization_required'] }).notNull(),
    scopesJson: text('scopes_json').notNull(),
    tokenExpiresAt: integer('token_expires_at', { mode: 'timestamp_ms' }).notNull(),
    connectedAt: integer('connected_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('meta_credentials_status_idx').on(table.status)],
);

export const metaPublishTargets = sqliteTable(
  'meta_publish_targets',
  {
    id: text('id').primaryKey(),
    credentialId: text('credential_id')
      .notNull()
      .references(() => metaCredentials.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['facebook_page', 'instagram_professional'] }).notNull(),
    externalId: text('external_id').notNull(),
    pageId: text('page_id').notNull(),
    displayName: text('display_name').notNull(),
    username: text('username'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    availability: text('availability', { enum: ['available', 'blocked'] }).notNull(),
    blocker: text('blocker'),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('meta_targets_credential_kind_external_idx').on(
      table.credentialId,
      table.kind,
      table.externalId,
    ),
    index('meta_targets_credential_idx').on(table.credentialId),
  ],
);

export const destinationJobRecords = sqliteTable(
  'destination_job_records',
  {
    jobId: text('job_id')
      .primaryKey()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    destinationId: text('destination_id').notNull(),
    remoteId: text('remote_id'),
    remoteUrl: text('remote_url'),
    remoteStatus: text('remote_status').notNull(),
    resumableSessionUrl: text('resumable_session_url'),
    uploadedBytes: integer('uploaded_bytes').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('destination_job_records_remote_id_idx').on(table.destinationId, table.remoteId),
  ],
);

export const workflows = sqliteTable(
  'workflows',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    sourceDirectory: text('source_directory').notNull(),
    titleTemplate: text('title_template').notNull(),
    descriptionTemplate: text('description_template').notNull(),
    failurePolicy: text('failure_policy', { enum: ['best_effort'] }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('workflows_enabled_idx').on(table.enabled)],
);

export const workflowDestinations = sqliteTable(
  'workflow_destinations',
  {
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    destinationId: text('destination_id', {
      enum: ['youtube', 'tiktok', 'instagram', 'facebook'],
    }).notNull(),
    /** Legacy account IDs and Meta publish-target IDs share this selector column. */
    accountId: text('account_id').notNull(),
    position: integer('position').notNull(),
    configurationJson: text('configuration_json').notNull(),
  },
  (table) => [
    uniqueIndex('workflow_destinations_workflow_destination_idx').on(
      table.workflowId,
      table.destinationId,
      table.accountId,
    ),
    uniqueIndex('workflow_destinations_workflow_position_idx').on(table.workflowId, table.position),
    index('workflow_destinations_account_idx').on(table.accountId),
  ],
);

export const sourceCursors = sqliteTable(
  'source_cursors',
  {
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    sourceKey: text('source_key').notNull(),
    path: text('path').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    modifiedAt: integer('modified_at', { mode: 'timestamp_ms' }).notNull(),
    observedAt: integer('observed_at', { mode: 'timestamp_ms' }).notNull(),
    state: text('state', { enum: ['pending', 'processed'] }).notNull(),
    mediaId: text('media_id').references(() => mediaAssets.id),
  },
  (table) => [
    uniqueIndex('source_cursors_workflow_source_idx').on(table.workflowId, table.sourceKey),
  ],
);

export const sourceConnections = sqliteTable(
  'source_connections',
  {
    id: text('id').primaryKey(),
    adapterId: text('adapter_id').notNull(),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    externalSourceId: text('external_source_id').notNull(),
    displayName: text('display_name').notNull(),
    configurationJson: text('configuration_json').notNull(),
    status: text('status', { enum: ['active', 'paused', 'authorization_failed'] }).notNull(),
    cursorJson: text('cursor_json'),
    watermarkPublishedAt: integer('watermark_published_at', { mode: 'timestamp_ms' }),
    watermarkExternalId: text('watermark_external_id'),
    lastPollAt: integer('last_poll_at', { mode: 'timestamp_ms' }),
    lastSuccessfulPollAt: integer('last_successful_poll_at', { mode: 'timestamp_ms' }),
    lastPollErrorCode: text('last_poll_error_code'),
    lastPollErrorMessage: text('last_poll_error_message'),
    consecutivePollFailures: integer('consecutive_poll_failures').notNull().default(0),
    nextPollAt: integer('next_poll_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('source_connections_adapter_external_idx').on(
      table.adapterId,
      table.externalSourceId,
    ),
    index('source_connections_status_next_poll_idx').on(table.status, table.nextPollAt),
    check(
      'source_connections_watermark_pair_check',
      sql`(${table.watermarkPublishedAt} IS NULL AND ${table.watermarkExternalId} IS NULL) OR (${table.watermarkPublishedAt} IS NOT NULL AND ${table.watermarkExternalId} IS NOT NULL)`,
    ),
  ],
);

export const workflowRemoteSources = sqliteTable(
  'workflow_remote_sources',
  {
    workflowId: text('workflow_id')
      .primaryKey()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    sourceConnectionId: text('source_connection_id')
      .notNull()
      .references(() => sourceConnections.id, { onDelete: 'restrict' }),
    filtersJson: text('filters_json').notNull(),
    retentionPolicy: text('retention_policy', {
      enum: ['delete_after_success', 'keep_for_duration', 'keep_forever'],
    }).notNull(),
    retentionDurationSeconds: integer('retention_duration_seconds'),
    rightsConfirmed: integer('rights_confirmed', { mode: 'boolean' }).notNull(),
    localOriginalJson: text('local_original_json'),
  },
  (table) => [
    index('workflow_remote_sources_connection_idx').on(table.sourceConnectionId, table.workflowId),
  ],
);

export const sourceItems = sqliteTable(
  'source_items',
  {
    id: text('id').primaryKey(),
    sourceConnectionId: text('source_connection_id')
      .notNull()
      .references(() => sourceConnections.id, { onDelete: 'restrict' }),
    externalId: text('external_id').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    eventId: text('event_id'),
    publishedAt: integer('published_at', { mode: 'timestamp_ms' }),
    firstObservedAt: integer('first_observed_at', { mode: 'timestamp_ms' }).notNull(),
    lastObservedAt: integer('last_observed_at', { mode: 'timestamp_ms' }).notNull(),
    metadataJson: text('metadata_json').notNull(),
    mediaDescriptorJson: text('media_descriptor_json'),
    lifecycleStatus: text('lifecycle_status', {
      enum: [
        'observed',
        'queued',
        'resolving',
        'media_ready',
        'processing',
        'publishing',
        'partial_failure',
        'retrying',
        'published',
        'cleanup_pending',
        'completed',
        'failed',
      ],
    }).notNull(),
    resolutionStatus: text('resolution_status', {
      enum: ['unresolved', 'resolving', 'ready', 'unavailable', 'failed'],
    }).notNull(),
    linkedMediaId: text('linked_media_id').references(() => mediaAssets.id, {
      onDelete: 'set null',
    }),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('source_items_connection_external_idx').on(
      table.sourceConnectionId,
      table.externalId,
    ),
    uniqueIndex('source_items_connection_dedupe_idx').on(table.sourceConnectionId, table.dedupeKey),
    index('source_items_connection_observed_idx').on(
      table.sourceConnectionId,
      table.firstObservedAt,
    ),
    index('source_items_lifecycle_idx').on(table.lifecycleStatus, table.updatedAt),
  ],
);

export const sourceWorkflowExecutions = sqliteTable(
  'source_workflow_executions',
  {
    id: text('id').primaryKey(),
    sourceItemId: text('source_item_id')
      .notNull()
      .references(() => sourceItems.id, { onDelete: 'restrict' }),
    workflowId: text('workflow_id').references(() => workflows.id, { onDelete: 'set null' }),
    workflowKey: text('workflow_key').notNull(),
    workflowVersion: text('workflow_version').notNull(),
    status: text('status', {
      enum: ['pending', 'running', 'waiting', 'retrying', 'succeeded', 'failed', 'cancelled'],
    }).notNull(),
    snapshotJson: text('snapshot_json').notNull(),
    retentionPolicy: text('retention_policy', {
      enum: ['delete_after_success', 'keep_for_duration', 'keep_forever'],
    }).notNull(),
    retentionDurationSeconds: integer('retention_duration_seconds'),
    cleanupStatus: text('cleanup_status', {
      enum: ['not_eligible', 'eligible', 'scheduled', 'running', 'completed', 'failed', 'retained'],
    }).notNull(),
    cleanupEligibleAt: integer('cleanup_eligible_at', { mode: 'timestamp_ms' }),
    cleanupErrorCode: text('cleanup_error_code'),
    cleanupErrorMessage: text('cleanup_error_message'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    uniqueIndex('source_workflow_executions_item_workflow_version_idx').on(
      table.sourceItemId,
      table.workflowKey,
      table.workflowVersion,
    ),
    index('source_workflow_executions_item_idx').on(table.sourceItemId, table.createdAt),
    index('source_workflow_executions_recovery_idx').on(table.status, table.updatedAt),
    index('source_workflow_executions_cleanup_idx').on(
      table.cleanupStatus,
      table.cleanupEligibleAt,
    ),
  ],
);

export const sourceExecutionDestinations = sqliteTable(
  'source_execution_destinations',
  {
    id: text('id').primaryKey(),
    executionId: text('execution_id')
      .notNull()
      .references(() => sourceWorkflowExecutions.id, { onDelete: 'restrict' }),
    destinationKey: text('destination_key').notNull(),
    destinationId: text('destination_id').notNull(),
    required: integer('required', { mode: 'boolean' }).notNull(),
    jobId: text('job_id')
      .unique()
      .references(() => jobs.id, { onDelete: 'set null' }),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    status: text('status', {
      enum: ['pending', 'running', 'waiting', 'retrying', 'succeeded', 'failed', 'cancelled'],
    }).notNull(),
    remoteId: text('remote_id'),
    remoteUrl: text('remote_url'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    uniqueIndex('source_execution_destinations_execution_key_idx').on(
      table.executionId,
      table.destinationKey,
    ),
    index('source_execution_destinations_recovery_idx').on(table.executionId, table.status),
  ],
);

export const sourceMediaArtifacts = sqliteTable(
  'source_media_artifacts',
  {
    id: text('id').primaryKey(),
    sourceItemId: text('source_item_id')
      .notNull()
      .references(() => sourceItems.id, { onDelete: 'restrict' }),
    executionId: text('execution_id').references(() => sourceWorkflowExecutions.id, {
      onDelete: 'restrict',
    }),
    mediaId: text('media_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
    path: text('path').notNull(),
    ownership: text('ownership', {
      enum: ['user_owned_original', 'openrepurpose_temporary', 'openrepurpose_generated'],
    }).notNull(),
    state: text('state', { enum: ['available', 'missing', 'deleted'] }).notNull(),
    cleanupState: text('cleanup_state', {
      enum: [
        'protected',
        'not_eligible',
        'eligible',
        'scheduled',
        'running',
        'completed',
        'failed',
        'retained',
      ],
    }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    uniqueIndex('source_media_artifacts_item_path_ownership_idx').on(
      table.sourceItemId,
      table.path,
      table.ownership,
    ),
    index('source_media_artifacts_cleanup_idx').on(
      table.ownership,
      table.cleanupState,
      table.updatedAt,
    ),
  ],
);

export const sourceMediaResolutions = sqliteTable(
  'source_media_resolutions',
  {
    sourceItemId: text('source_item_id')
      .notNull()
      .references(() => sourceItems.id, { onDelete: 'restrict' }),
    executionId: text('execution_id')
      .notNull()
      .references(() => sourceWorkflowExecutions.id, { onDelete: 'restrict' }),
    jobScopeId: text('job_scope_id').notNull(),
    status: text('status', { enum: ['resolving', 'ready', 'failed', 'cancelled'] }).notNull(),
    resolverId: text('resolver_id'),
    managedPath: text('managed_path'),
    mediaId: text('media_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    uniqueIndex('source_media_resolutions_item_execution_idx').on(
      table.sourceItemId,
      table.executionId,
    ),
    index('source_media_resolutions_recovery_idx').on(table.status, table.updatedAt),
  ],
);
