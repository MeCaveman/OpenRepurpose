import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import type {
  EnqueueJobInput,
  EnqueueJobResult,
  Job,
  JobAttempt,
  JobFailure,
  JobRepository,
  JobStatus,
  JsonValue,
  MediaAsset,
  MediaRepository,
} from '@openrepurpose/core';
import { migrations } from './migrations/index.js';
import type { Migration } from './migrations/types.js';
import { mediaAssets, settings } from './schema.js';

export { migrations } from './migrations/index.js';
export type { Migration } from './migrations/index.js';
export { jobAttempts, jobs, mediaAssets, settings } from './schema.js';

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

interface RawJobRow {
  readonly attempt_count: number;
  readonly available_at: number;
  readonly cancellation_requested_at: number | null;
  readonly completed_at: number | null;
  readonly created_at: number;
  readonly id: string;
  readonly idempotency_key: string | null;
  readonly input_json: string;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
  readonly lease_expires_at: number | null;
  readonly lease_owner: string | null;
  readonly max_attempts: number;
  readonly status: JobStatus;
  readonly type: string;
  readonly updated_at: number;
}

interface RawAttemptRow {
  readonly attempt_number: number;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly finished_at: number | null;
  readonly id: string;
  readonly job_id: string;
  readonly lease_owner: string;
  readonly retryable: number | null;
  readonly started_at: number;
  readonly status: JobAttempt['status'];
}

function jobFromRow(row: RawJobRow): Job {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    input: JSON.parse(row.input_json) as JsonValue,
    maxAttempts: row.max_attempts,
    attemptCount: row.attempt_count,
    availableAt: new Date(row.available_at),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: new Date(row.lease_expires_at) }),
    ...(row.cancellation_requested_at === null
      ? {}
      : { cancellationRequestedAt: new Date(row.cancellation_requested_at) }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    ...(row.last_error_message === null ? {} : { lastErrorMessage: row.last_error_message }),
    ...(row.completed_at === null ? {} : { completedAt: new Date(row.completed_at) }),
  };
}

function attemptFromRow(row: RawAttemptRow): JobAttempt {
  return {
    id: row.id,
    jobId: row.job_id,
    attemptNumber: row.attempt_number,
    status: row.status,
    leaseOwner: row.lease_owner,
    startedAt: new Date(row.started_at),
    ...(row.finished_at === null ? {} : { finishedAt: new Date(row.finished_at) }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    ...(row.retryable === null ? {} : { retryable: row.retryable === 1 }),
  };
}

/** Transactional SQLite job queue. Claims and terminal transitions are lease-owner guarded. */
export class SqliteJobRepository implements JobRepository {
  public constructor(private readonly database: OpenRepurposeDatabase) {}

  public enqueue(input: EnqueueJobInput): EnqueueJobResult {
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      if (input.idempotencyKey !== undefined) {
        const existing = client
          .prepare('SELECT * FROM jobs WHERE idempotency_key = ?')
          .get(input.idempotencyKey) as unknown as RawJobRow | undefined;
        if (existing !== undefined) {
          client.exec('COMMIT;');
          return { created: false, job: jobFromRow(existing) };
        }
      }
      const availableAt = input.availableAt ?? input.now;
      client
        .prepare(
          `INSERT INTO jobs (
            id, type, status, input_json, idempotency_key, max_attempts, attempt_count,
            available_at, lease_owner, lease_expires_at, cancellation_requested_at,
            last_error_code, last_error_message, created_at, updated_at, completed_at
          ) VALUES (?, ?, 'pending', ?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
        )
        .run(
          input.id,
          input.type,
          JSON.stringify(input.input),
          input.idempotencyKey ?? null,
          input.maxAttempts,
          availableAt.getTime(),
          input.now.getTime(),
          input.now.getTime(),
        );
      const row = client
        .prepare('SELECT * FROM jobs WHERE id = ?')
        .get(input.id) as unknown as RawJobRow;
      client.exec('COMMIT;');
      return { created: true, job: jobFromRow(row) };
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }

  public findById(id: string): Job | undefined {
    const row = this.database.client.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
      RawJobRow | undefined;
    return row === undefined ? undefined : jobFromRow(row);
  }

  public list(status?: JobStatus): readonly Job[] {
    const rows =
      status === undefined
        ? this.database.client.prepare('SELECT * FROM jobs ORDER BY created_at DESC, id DESC').all()
        : this.database.client
            .prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC, id DESC')
            .all(status);
    return (rows as unknown as RawJobRow[]).map(jobFromRow);
  }

  public listAttempts(jobId: string): readonly JobAttempt[] {
    return (
      this.database.client
        .prepare('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY attempt_number ASC')
        .all(jobId) as unknown as RawAttemptRow[]
    ).map(attemptFromRow);
  }

  public claimNext(
    supportedTypes: readonly string[],
    workerId: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Job | undefined {
    if (supportedTypes.length === 0) return undefined;
    const client = this.database.client;
    const placeholders = supportedTypes.map(() => '?').join(', ');
    client.exec('BEGIN IMMEDIATE;');
    try {
      const candidate = client
        .prepare(
          `SELECT id FROM jobs
           WHERE status IN ('pending', 'retrying')
             AND available_at <= ?
             AND cancellation_requested_at IS NULL
             AND type IN (${placeholders})
           ORDER BY available_at ASC, created_at ASC, id ASC
           LIMIT 1`,
        )
        .get(now.getTime(), ...supportedTypes) as { id: string } | undefined;
      if (candidate === undefined) {
        client.exec('COMMIT;');
        return undefined;
      }
      client
        .prepare(
          `UPDATE jobs
           SET status = 'running', attempt_count = attempt_count + 1, lease_owner = ?,
               lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('pending', 'retrying')`,
        )
        .run(workerId, leaseExpiresAt.getTime(), now.getTime(), candidate.id);
      const row = client
        .prepare('SELECT * FROM jobs WHERE id = ?')
        .get(candidate.id) as unknown as RawJobRow;
      client
        .prepare(
          `INSERT INTO job_attempts (
             id, job_id, attempt_number, status, lease_owner, started_at,
             finished_at, error_code, error_message, retryable
           ) VALUES (?, ?, ?, 'running', ?, ?, NULL, NULL, NULL, NULL)`,
        )
        .run(randomUUID(), row.id, row.attempt_count, workerId, now.getTime());
      client.exec('COMMIT;');
      return jobFromRow(row);
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }

  public heartbeat(jobId: string, workerId: string, now: Date, leaseExpiresAt: Date): boolean {
    const result = this.database.client
      .prepare(
        `UPDATE jobs SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?`,
      )
      .run(leaseExpiresAt.getTime(), now.getTime(), jobId, workerId);
    return Number(result.changes) === 1;
  }

  public complete(jobId: string, workerId: string, now: Date): boolean {
    return this.finish(jobId, workerId, now, 'succeeded');
  }

  public cancelRunning(jobId: string, workerId: string, now: Date): boolean {
    return this.finish(jobId, workerId, now, 'cancelled');
  }

  private finish(
    jobId: string,
    workerId: string,
    now: Date,
    status: 'succeeded' | 'cancelled',
  ): boolean {
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      const cancellationGuard =
        status === 'succeeded' ? 'AND cancellation_requested_at IS NULL' : '';
      const result = client
        .prepare(
          `UPDATE jobs SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
             updated_at = ?, completed_at = ?
           WHERE id = ? AND status = 'running' AND lease_owner = ? ${cancellationGuard}`,
        )
        .run(status, now.getTime(), now.getTime(), jobId, workerId);
      if (Number(result.changes) === 1) {
        client
          .prepare(
            `UPDATE job_attempts SET status = ?, finished_at = ?
             WHERE job_id = ? AND status = 'running' AND lease_owner = ?`,
          )
          .run(status, now.getTime(), jobId, workerId);
      }
      client.exec('COMMIT;');
      return Number(result.changes) === 1;
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }

  public fail(
    jobId: string,
    workerId: string,
    failure: JobFailure,
    now: Date,
    retryAt?: Date,
  ): boolean {
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      const status = retryAt === undefined ? 'failed' : 'retrying';
      const result = client
        .prepare(
          `UPDATE jobs SET status = ?, available_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, last_error_code = ?, last_error_message = ?,
             updated_at = ?, completed_at = ?
           WHERE id = ? AND status = 'running' AND lease_owner = ?`,
        )
        .run(
          status,
          (retryAt ?? now).getTime(),
          failure.code,
          failure.message,
          now.getTime(),
          retryAt === undefined ? now.getTime() : null,
          jobId,
          workerId,
        );
      if (Number(result.changes) === 1) {
        client
          .prepare(
            `UPDATE job_attempts
             SET status = 'failed', finished_at = ?, error_code = ?, error_message = ?, retryable = ?
             WHERE job_id = ? AND status = 'running' AND lease_owner = ?`,
          )
          .run(
            now.getTime(),
            failure.code,
            failure.message,
            failure.retryable ? 1 : 0,
            jobId,
            workerId,
          );
      }
      client.exec('COMMIT;');
      return Number(result.changes) === 1;
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }

  public isCancellationRequested(jobId: string): boolean {
    const row = this.database.client
      .prepare('SELECT cancellation_requested_at FROM jobs WHERE id = ?')
      .get(jobId) as { cancellation_requested_at: number | null } | undefined;
    return row?.cancellation_requested_at !== null && row?.cancellation_requested_at !== undefined;
  }

  public requestCancellation(id: string, now: Date): Job | undefined {
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      const existing = client.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
        RawJobRow | undefined;
      if (existing === undefined) {
        client.exec('COMMIT;');
        return undefined;
      }
      if (existing.status === 'pending' || existing.status === 'retrying') {
        client
          .prepare(
            `UPDATE jobs SET status = 'cancelled', cancellation_requested_at = ?,
               updated_at = ?, completed_at = ? WHERE id = ?`,
          )
          .run(now.getTime(), now.getTime(), now.getTime(), id);
      } else if (existing.status === 'running' && existing.cancellation_requested_at === null) {
        client
          .prepare('UPDATE jobs SET cancellation_requested_at = ?, updated_at = ? WHERE id = ?')
          .run(now.getTime(), now.getTime(), id);
      }
      const updated = client
        .prepare('SELECT * FROM jobs WHERE id = ?')
        .get(id) as unknown as RawJobRow;
      client.exec('COMMIT;');
      return jobFromRow(updated);
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }

  public recoverExpiredLeases(now: Date): number {
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      const expired = client
        .prepare(
          `SELECT id, attempt_count, max_attempts, cancellation_requested_at
           FROM jobs WHERE status = 'running' AND lease_expires_at <= ?`,
        )
        .all(now.getTime()) as unknown as Array<{
        id: string;
        attempt_count: number;
        max_attempts: number;
        cancellation_requested_at: number | null;
      }>;
      for (const job of expired) {
        const cancelled = job.cancellation_requested_at !== null;
        const retrying = !cancelled && job.attempt_count < job.max_attempts;
        const status = cancelled ? 'cancelled' : retrying ? 'retrying' : 'failed';
        client
          .prepare(
            `UPDATE jobs SET status = ?, available_at = ?, lease_owner = NULL,
               lease_expires_at = NULL, last_error_code = ?, last_error_message = ?,
               updated_at = ?, completed_at = ? WHERE id = ? AND status = 'running'`,
          )
          .run(
            status,
            now.getTime(),
            cancelled ? null : 'LEASE_EXPIRED',
            cancelled ? null : 'The previous worker stopped before completing this attempt.',
            now.getTime(),
            retrying ? null : now.getTime(),
            job.id,
          );
        client
          .prepare(
            `UPDATE job_attempts SET status = ?, finished_at = ?, error_code = ?,
               error_message = ?, retryable = ?
             WHERE job_id = ? AND status = 'running'`,
          )
          .run(
            cancelled ? 'cancelled' : 'failed',
            now.getTime(),
            cancelled ? null : 'LEASE_EXPIRED',
            cancelled ? null : 'The previous worker stopped before completing this attempt.',
            cancelled ? null : 1,
            job.id,
          );
      }
      client.exec('COMMIT;');
      return expired.length;
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }
}
