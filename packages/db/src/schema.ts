import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
    provider: text('provider', { enum: ['youtube', 'tiktok'] }).notNull(),
    stateHash: text('state_hash').notNull().unique(),
    bindingHash: text('binding_hash').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('oauth_authorization_requests_expires_at_idx').on(table.expiresAt)],
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
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    titleTemplate: text('title_template').notNull(),
    descriptionTemplate: text('description_template').notNull(),
    privacy: text('privacy', { enum: ['private', 'public', 'unlisted'] }).notNull(),
    category: text('category'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('workflows_enabled_idx').on(table.enabled)],
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
