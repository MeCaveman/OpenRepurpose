import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import type { MediaAsset, MediaRepository } from '@openrepurpose/core';
import { migrations } from './migrations/index.js';
import type { Migration } from './migrations/types.js';
import { mediaAssets, settings } from './schema.js';

export { migrations } from './migrations/index.js';
export type { Migration } from './migrations/index.js';
export { mediaAssets, settings } from './schema.js';

export interface OpenDatabaseOptions {
  readonly createParentDirectory?: boolean;
}

export interface OpenRepurposeDatabase {
  readonly client: DatabaseSync;
  readonly db: ReturnType<typeof drizzle>;
  close(): void;
}

/** Opens a local SQLite database with durability and referential-integrity safeguards enabled. */
export function openDatabase(
  path: string,
  options: OpenDatabaseOptions = {},
): OpenRepurposeDatabase {
  if (options.createParentDirectory ?? true) mkdirSync(dirname(path), { recursive: true });
  const client = new DatabaseSync(path);
  client.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return { client, db: drizzle({ client }), close: () => client.close() };
}

/** Applies each unapplied migration atomically and rejects altered historical migrations. */
export function runMigrations(
  database: OpenRepurposeDatabase,
  migrationSet: readonly Migration[] = migrations,
): void {
  database.client.exec(
    `CREATE TABLE IF NOT EXISTS __openrepurpose_migrations (id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL);`,
  );
  const lookup = database.client.prepare(
    'SELECT checksum FROM __openrepurpose_migrations WHERE id = ?',
  );
  const record = database.client.prepare(
    'INSERT INTO __openrepurpose_migrations (id, checksum, applied_at) VALUES (?, ?, ?)',
  );
  for (const migration of migrationSet) {
    const checksum = createHash('sha256').update(migration.sql).digest('hex');
    const existing = lookup.get(migration.id) as { checksum: string } | undefined;
    if (existing !== undefined) {
      if (existing.checksum !== checksum)
        throw new Error(`Applied migration ${migration.id} does not match its recorded checksum.`);
      continue;
    }
    database.client.exec('BEGIN IMMEDIATE;');
    try {
      database.client.exec(migration.sql);
      record.run(migration.id, checksum, Date.now());
      database.client.exec('COMMIT;');
    } catch (error) {
      database.client.exec('ROLLBACK;');
      throw error;
    }
  }
}

/** Infrastructure repository for durable settings; domain services depend on its narrow contract. */
export class SettingsRepository {
  public constructor(private readonly database: OpenRepurposeDatabase) {}
  public get(key: string): string | undefined {
    return this.database.db.select().from(settings).where(eq(settings.key, key)).get()?.value;
  }
  public set(key: string, value: string): void {
    const updatedAt = new Date();
    this.database.db
      .insert(settings)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } })
      .run();
  }
}

/** SQLite implementation of the media-library boundary. */
export class SqliteMediaRepository implements MediaRepository {
  public constructor(private readonly database: OpenRepurposeDatabase) {}
  public create(asset: MediaAsset): MediaAsset {
    this.database.db.insert(mediaAssets).values(this.toRow(asset)).run();
    return asset;
  }
  public findByFingerprint(fingerprint: string): MediaAsset | undefined {
    const row = this.database.db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.fingerprint, fingerprint))
      .get();
    return row === undefined ? undefined : this.toAsset(row);
  }
  public list(): readonly MediaAsset[] {
    return this.database.db
      .select()
      .from(mediaAssets)
      .orderBy(desc(mediaAssets.createdAt))
      .all()
      .map((row) => this.toAsset(row));
  }
  private toRow(asset: MediaAsset) {
    return {
      id: asset.id,
      path: asset.path,
      fingerprint: asset.fingerprint,
      sizeBytes: asset.sizeBytes,
      modifiedAt: asset.modifiedAt,
      state: asset.state,
      durationMillis:
        asset.metadata.durationSeconds === undefined
          ? null
          : Math.round(asset.metadata.durationSeconds * 1000),
      videoCodec: asset.metadata.videoCodec ?? null,
      audioCodec: asset.metadata.audioCodec ?? null,
      width: asset.metadata.width ?? null,
      height: asset.metadata.height ?? null,
      frameRateMilli:
        asset.metadata.frameRate === undefined ? null : Math.round(asset.metadata.frameRate * 1000),
      hasAudio: asset.metadata.hasAudio,
      createdAt: asset.createdAt,
    };
  }
  private toAsset(row: typeof mediaAssets.$inferSelect): MediaAsset {
    return {
      id: row.id,
      path: row.path,
      fingerprint: row.fingerprint,
      sizeBytes: row.sizeBytes,
      modifiedAt: row.modifiedAt,
      state: row.state,
      createdAt: row.createdAt,
      metadata: {
        hasAudio: row.hasAudio,
        ...(row.durationMillis === null ? {} : { durationSeconds: row.durationMillis / 1000 }),
        ...(row.videoCodec === null ? {} : { videoCodec: row.videoCodec }),
        ...(row.audioCodec === null ? {} : { audioCodec: row.audioCodec }),
        ...(row.width === null ? {} : { width: row.width }),
        ...(row.height === null ? {} : { height: row.height }),
        ...(row.frameRateMilli === null ? {} : { frameRate: row.frameRateMilli / 1000 }),
      },
    };
  }
}
