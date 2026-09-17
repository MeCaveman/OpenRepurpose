import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Durable user-configurable settings. Feature tables are introduced by their owning packets. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
