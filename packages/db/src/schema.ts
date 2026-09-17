import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
