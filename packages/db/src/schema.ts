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
