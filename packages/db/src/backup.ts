import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream, existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { backup as backupSqlite, DatabaseSync } from 'node:sqlite';
import type { OpenRepurposeDatabase } from './index.js';
import { migrations } from './migrations/index.js';
import { migrationChecksum } from './migrations/types.js';

const BACKUP_MAGIC = Buffer.from('OPENREPURPOSE-BACKUP\n', 'ascii');
const BACKUP_FORMAT_VERSION = 1 as const;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_EXTERNAL_REFERENCES = 5_000;

export interface BackupExternalReference {
  readonly kind: 'media' | 'workflow-source';
  readonly path: string;
  readonly sizeBytes?: number;
  readonly state?: 'available' | 'missing';
}

export interface BackupManifest {
  readonly contents: {
    readonly database: true;
    readonly derivatives: false;
    readonly media: false;
    readonly models: false;
    readonly secrets: false;
  };
  readonly createdAt: string;
  readonly database: {
    readonly byteLength: number;
    readonly migrations: readonly MigrationRow[];
    readonly schemaVersion: string;
    readonly sha256: string;
  };
  readonly externalReferences?: {
    readonly entries: readonly BackupExternalReference[];
    readonly truncated: boolean;
  };
  readonly format: 'openrepurpose-backup';
  readonly formatVersion: 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).every((key) => keys.includes(key));
}

function parseManifest(candidate: unknown): BackupManifest {
  if (
    !isRecord(candidate) ||
    !hasOnlyKeys(candidate, [
      'contents',
      'createdAt',
      'database',
      'externalReferences',
      'format',
      'formatVersion',
    ]) ||
    candidate.format !== 'openrepurpose-backup' ||
    candidate.formatVersion !== BACKUP_FORMAT_VERSION ||
    typeof candidate.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    !isRecord(candidate.contents) ||
    !hasOnlyKeys(candidate.contents, ['database', 'derivatives', 'media', 'models', 'secrets']) ||
    candidate.contents.database !== true ||
    candidate.contents.derivatives !== false ||
    candidate.contents.media !== false ||
    candidate.contents.models !== false ||
    candidate.contents.secrets !== false ||
    !isRecord(candidate.database) ||
    !hasOnlyKeys(candidate.database, ['byteLength', 'migrations', 'schemaVersion', 'sha256']) ||
    !Number.isSafeInteger(candidate.database.byteLength) ||
    (candidate.database.byteLength as number) < 1 ||
    typeof candidate.database.schemaVersion !== 'string' ||
    candidate.database.schemaVersion.length < 1 ||
    candidate.database.schemaVersion.length > 128 ||
    typeof candidate.database.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(candidate.database.sha256) ||
    !Array.isArray(candidate.database.migrations)
  )
    throw new Error('The backup manifest is invalid or unsupported.');
  const migrationRecords: MigrationRow[] = [];
  for (const record of candidate.database.migrations) {
    if (
      !isRecord(record) ||
      !hasOnlyKeys(record, ['checksum', 'id']) ||
      typeof record.id !== 'string' ||
      record.id.length < 1 ||
      record.id.length > 128 ||
      typeof record.checksum !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(record.checksum)
    )
      throw new Error('The backup manifest is invalid or unsupported.');
    migrationRecords.push({ checksum: record.checksum, id: record.id });
  }
  let externalReferences: BackupManifest['externalReferences'];
  if (candidate.externalReferences !== undefined) {
    if (
      !isRecord(candidate.externalReferences) ||
      !hasOnlyKeys(candidate.externalReferences, ['entries', 'truncated']) ||
      !Array.isArray(candidate.externalReferences.entries) ||
      candidate.externalReferences.entries.length > MAX_EXTERNAL_REFERENCES ||
      typeof candidate.externalReferences.truncated !== 'boolean'
    )
      throw new Error('The backup manifest is invalid or unsupported.');
    const entries: BackupExternalReference[] = [];
    for (const reference of candidate.externalReferences.entries) {
      if (
        !isRecord(reference) ||
        !hasOnlyKeys(reference, ['kind', 'path', 'sizeBytes', 'state']) ||
        (reference.kind !== 'media' && reference.kind !== 'workflow-source') ||
        typeof reference.path !== 'string' ||
        reference.path.length < 1 ||
        (reference.sizeBytes !== undefined &&
          (!Number.isSafeInteger(reference.sizeBytes) || (reference.sizeBytes as number) < 0)) ||
        (reference.state !== undefined &&
          reference.state !== 'available' &&
          reference.state !== 'missing')
      )
        throw new Error('The backup manifest is invalid or unsupported.');
      entries.push({
        kind: reference.kind,
        path: reference.path,
        ...(reference.sizeBytes === undefined ? {} : { sizeBytes: reference.sizeBytes as number }),
        ...(reference.state === undefined ? {} : { state: reference.state }),
      });
    }
    externalReferences = { entries, truncated: candidate.externalReferences.truncated };
  }
  return {
    contents: { database: true, derivatives: false, media: false, models: false, secrets: false },
    createdAt: candidate.createdAt,
    database: {
      byteLength: candidate.database.byteLength as number,
      migrations: migrationRecords,
      schemaVersion: candidate.database.schemaVersion,
      sha256: candidate.database.sha256,
    },
    ...(externalReferences === undefined ? {} : { externalReferences }),
    format: 'openrepurpose-backup',
    formatVersion: 1,
  };
}

export interface CreatePortableBackupOptions {
  readonly database: OpenRepurposeDatabase;
  readonly includeMetadata?: boolean;
  readonly now?: () => Date;
  readonly outputPath: string;
  readonly temporaryDirectory?: string;
}

export interface PortableBackupResult {
  readonly manifest: BackupManifest;
  readonly path: string;
}

export interface RestorePortableBackupOptions {
  readonly backupDirectory?: string;
  readonly backupPath: string;
  readonly databasePath: string;
  readonly now?: () => Date;
}

export interface RestorePortableBackupResult extends PortableBackupResult {
  readonly preRestoreBackupPath?: string;
}

export interface MigrationRow {
  readonly checksum: string;
  readonly id: string;
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replaceAll(':', '-');
}

async function restrictPermissions(path: string): Promise<void> {
  try {
    await chmod(path, 0o600);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

async function sha256File(path: string, start = 0): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { start })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function sha256Handle(handle: FileHandle, start: number): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of handle.createReadStream({ autoClose: false, start }))
    hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function readMigrationLedger(database: DatabaseSync): readonly MigrationRow[] {
  const hasLedger = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = '__openrepurpose_migrations'",
    )
    .get();
  if (hasLedger === undefined) throw new Error('The backup database has no migration ledger.');
  const rows = database
    .prepare('SELECT id, checksum FROM __openrepurpose_migrations')
    .all() as unknown as MigrationRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered: MigrationRow[] = [];
  for (const migration of migrations) {
    const row = byId.get(migration.id);
    if (row === undefined) break;
    if (row.checksum !== migrationChecksum(migration))
      throw new Error(`Backup migration ${migration.id} does not match the supported checksum.`);
    ordered.push(row);
    byId.delete(migration.id);
  }
  if (byId.size > 0)
    throw new Error(`The backup uses unsupported migration ${byId.keys().next().value as string}.`);
  if (ordered.length !== rows.length)
    throw new Error('The backup migration ledger is not a supported contiguous history.');
  return ordered;
}

/** Marks browser-safe metadata for reconnect and removes transient/authentication verifiers. */
export function invalidateSecretDependentState(
  databaseOrConnection: OpenRepurposeDatabase | DatabaseSync,
  now: Date = new Date(),
): void {
  const database =
    databaseOrConnection instanceof DatabaseSync
      ? databaseOrConnection
      : databaseOrConnection.client;
  const timestamp = now.getTime();
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(
      'DELETE FROM oauth_authorization_requests; DELETE FROM api_idempotency_records; DELETE FROM api_tokens;',
    );
    database
      .prepare(
        "UPDATE accounts SET status = 'reauthorization_required', updated_at = ? WHERE status = 'connected'",
      )
      .run(timestamp);
    database
      .prepare(
        "UPDATE meta_credentials SET status = 'reauthorization_required', updated_at = ? WHERE status = 'connected'",
      )
      .run(timestamp);
    database
      .prepare(
        "UPDATE meta_publish_targets SET availability = 'blocked', blocker = 'Reconnect the Meta account after restore.', updated_at = ? WHERE availability = 'available'",
      )
      .run(timestamp);
    database
      .prepare(
        "UPDATE source_connections SET status = 'authorization_failed', last_poll_error_code = 'SECRETS_EXCLUDED_FROM_BACKUP', last_poll_error_message = 'Reconnect the source account after restore.', updated_at = ? WHERE account_id IS NOT NULL AND status = 'active'",
      )
      .run(timestamp);
    database
      .prepare('UPDATE webhook_destinations SET enabled = 0, updated_at = ? WHERE enabled = 1')
      .run(timestamp);
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
  // Deleted token verifiers and transient OAuth rows must not survive in free SQLite pages.
  database.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
}

function externalReferences(database: DatabaseSync): {
  readonly entries: readonly BackupExternalReference[];
  readonly truncated: boolean;
} {
  const media = database
    .prepare('SELECT path, size_bytes AS sizeBytes, state FROM media_assets ORDER BY path ASC')
    .all() as unknown as { path: string; sizeBytes: number; state: 'available' | 'missing' }[];
  const workflowSources = database
    .prepare(
      'SELECT DISTINCT source_directory AS path FROM workflows ORDER BY source_directory ASC',
    )
    .all() as unknown as { path: string }[];
  const all = [
    ...media.map((item) => ({ kind: 'media' as const, ...item })),
    ...workflowSources.map((item) => ({ kind: 'workflow-source' as const, ...item })),
  ];
  return {
    entries: all.slice(0, MAX_EXTERNAL_REFERENCES),
    truncated: all.length > MAX_EXTERNAL_REFERENCES,
  };
}

async function writePortableFile(
  databasePath: string,
  outputPath: string,
  manifest: BackupManifest,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  if (existsSync(outputPath)) throw new Error(`Backup output already exists: ${outputPath}`);
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  const encodedManifest = Buffer.from(JSON.stringify(manifest), 'utf8');
  if (encodedManifest.length > MAX_MANIFEST_BYTES)
    throw new Error('The backup manifest exceeds the supported size.');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(encodedManifest.length);
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.write(Buffer.concat([BACKUP_MAGIC, length, encodedManifest]));
  } finally {
    await handle.close();
  }
  try {
    await pipeline(
      createReadStream(databasePath),
      createWriteStream(temporaryPath, { flags: 'a', mode: 0o600 }),
    );
    await rename(temporaryPath, outputPath);
    await restrictPermissions(outputPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/** Creates a portable, secret-free snapshot without copying media, models, or derivatives. */
export async function createPortableBackup(
  options: CreatePortableBackupOptions,
): Promise<PortableBackupResult> {
  const temporaryRoot = options.temporaryDirectory ?? tmpdir();
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'openrepurpose-backup-'));
  const databasePath = join(directory, 'database.sqlite');
  try {
    await backupSqlite(options.database.client, databasePath);
    const snapshot = new DatabaseSync(databasePath);
    let migrationRows: readonly MigrationRow[];
    let references: ReturnType<typeof externalReferences> | undefined;
    try {
      invalidateSecretDependentState(snapshot);
      migrationRows = readMigrationLedger(snapshot);
      if (migrationRows.length === 0) throw new Error('Cannot back up an uninitialized database.');
      if (options.includeMetadata === true) references = externalReferences(snapshot);
      const integrity = snapshot.prepare('PRAGMA integrity_check').get() as {
        integrity_check: string;
      };
      if (integrity.integrity_check !== 'ok')
        throw new Error('The database snapshot failed integrity validation.');
    } finally {
      snapshot.close();
    }
    const databaseStats = await stat(databasePath);
    const manifest: BackupManifest = {
      contents: { database: true, derivatives: false, media: false, models: false, secrets: false },
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      database: {
        byteLength: databaseStats.size,
        migrations: [...migrationRows],
        schemaVersion: migrationRows.at(-1)!.id,
        sha256: await sha256File(databasePath),
      },
      ...(references === undefined ? {} : { externalReferences: references }),
      format: 'openrepurpose-backup',
      formatVersion: BACKUP_FORMAT_VERSION,
    };
    await writePortableFile(databasePath, options.outputPath, manifest);
    return { manifest, path: resolve(options.outputPath) };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readAndExtractBackup(
  backupPath: string,
  extractedDatabasePath: string,
): Promise<BackupManifest> {
  const sourceStats = await lstat(backupPath);
  if (sourceStats.isSymbolicLink() || !sourceStats.isFile())
    throw new Error('The selected backup must be a regular file, not a link or special file.');
  const handle = await open(backupPath, 'r');
  let manifest: BackupManifest;
  let payloadOffset: number;
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile())
      throw new Error('The selected backup must be a regular file, not a special file.');
    const prefix = Buffer.alloc(BACKUP_MAGIC.length + 4);
    const prefixRead = await handle.read(prefix, 0, prefix.length, 0);
    if (
      prefixRead.bytesRead !== prefix.length ||
      !prefix.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)
    )
      throw new Error('The selected file is not an OpenRepurpose backup.');
    const manifestLength = prefix.readUInt32BE(BACKUP_MAGIC.length);
    if (manifestLength < 2 || manifestLength > MAX_MANIFEST_BYTES)
      throw new Error('The backup manifest length is invalid.');
    const encoded = Buffer.alloc(manifestLength);
    const manifestRead = await handle.read(encoded, 0, manifestLength, prefix.length);
    if (manifestRead.bytesRead !== manifestLength)
      throw new Error('The backup manifest is truncated.');
    try {
      manifest = parseManifest(JSON.parse(encoded.toString('utf8')));
    } catch {
      throw new Error('The backup manifest is invalid or unsupported.');
    }
    payloadOffset = prefix.length + manifestLength;
    if (openedStats.size !== payloadOffset + manifest.database.byteLength)
      throw new Error('The backup database payload length does not match its manifest.');
    if ((await sha256Handle(handle, payloadOffset)) !== manifest.database.sha256)
      throw new Error('The backup database checksum does not match its manifest.');
    await pipeline(
      handle.createReadStream({ autoClose: false, start: payloadOffset }),
      createWriteStream(extractedDatabasePath, { flags: 'wx', mode: 0o600 }),
    );
  } finally {
    await handle.close();
  }
  const database = new DatabaseSync(extractedDatabasePath, { readOnly: true });
  try {
    const integrity = database.prepare('PRAGMA integrity_check').get() as {
      integrity_check: string;
    };
    if (integrity.integrity_check !== 'ok')
      throw new Error('The backup database failed integrity validation.');
    const ledger = readMigrationLedger(database);
    if (
      ledger.length !== manifest.database.migrations.length ||
      ledger.some(
        (record, index) =>
          record.id !== manifest.database.migrations[index]!.id ||
          record.checksum !== manifest.database.migrations[index]!.checksum,
      )
    )
      throw new Error('The backup database migration ledger does not match its manifest.');
    if (ledger.at(-1)?.id !== manifest.database.schemaVersion)
      throw new Error('The backup schema version does not match its manifest.');
  } finally {
    database.close();
  }
  return manifest;
}

async function moveIfPresent(from: string, to: string): Promise<boolean> {
  try {
    await rename(from, to);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function copyIfPresent(from: string, to: string): Promise<boolean> {
  try {
    await copyFile(from, to, constants.COPYFILE_EXCL);
    await restrictPermissions(to);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function isDatabaseBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  return (
    code === 'ERR_SQLITE_ERROR' &&
    /\b(?:busy|locked)\b/iu.test('message' in error ? String(error.message) : '')
  );
}

/** Validates the complete backup before atomically replacing the configured SQLite database. */
export async function restorePortableBackup(
  options: RestorePortableBackupOptions,
): Promise<RestorePortableBackupResult> {
  const targetPath = resolve(options.databasePath);
  await mkdir(dirname(targetPath), { recursive: true });
  const extractedPath = `${targetPath}.${process.pid}.${randomUUID()}.restore`;
  let displacedPath: string | undefined;
  let displacedWal = false;
  let displacedShm = false;
  try {
    const manifest = await readAndExtractBackup(resolve(options.backupPath), extractedPath);
    let preRestoreBackupPath: string | undefined;
    if (existsSync(targetPath)) {
      let current: DatabaseSync | undefined;
      try {
        current = new DatabaseSync(targetPath);
        current.exec(
          'PRAGMA busy_timeout = 1000; BEGIN EXCLUSIVE; COMMIT; PRAGMA wal_checkpoint(TRUNCATE);',
        );
      } catch (error) {
        if (isDatabaseBusy(error))
          throw new Error('The current database is busy. Stop OpenRepurpose before restoring.', {
            cause: error,
          });
        // A corrupt current database is still preserved byte-for-byte before the validated restore.
      } finally {
        current?.close();
      }
      const backupDirectory = options.backupDirectory ?? join(dirname(targetPath), 'backups');
      await mkdir(backupDirectory, { recursive: true });
      preRestoreBackupPath = join(
        backupDirectory,
        `${basename(targetPath)}.pre-restore-${safeTimestamp((options.now ?? (() => new Date()))())}-${randomUUID().slice(0, 8)}.bak`,
      );
      await copyFile(targetPath, preRestoreBackupPath, constants.COPYFILE_EXCL);
      await restrictPermissions(preRestoreBackupPath);
      await copyIfPresent(`${targetPath}-wal`, `${preRestoreBackupPath}-wal`);
      await copyIfPresent(`${targetPath}-shm`, `${preRestoreBackupPath}-shm`);
      displacedPath = `${targetPath}.${process.pid}.${randomUUID()}.replaced`;
      await rename(targetPath, displacedPath);
      displacedWal = await moveIfPresent(`${targetPath}-wal`, `${displacedPath}-wal`);
      displacedShm = await moveIfPresent(`${targetPath}-shm`, `${displacedPath}-shm`);
    }
    try {
      await rename(extractedPath, targetPath);
      await restrictPermissions(targetPath);
    } catch (error) {
      if (displacedPath !== undefined) {
        await rename(displacedPath, targetPath).catch(() => undefined);
        if (displacedWal)
          await rename(`${displacedPath}-wal`, `${targetPath}-wal`).catch(() => undefined);
        if (displacedShm)
          await rename(`${displacedPath}-shm`, `${targetPath}-shm`).catch(() => undefined);
      }
      throw error;
    }
    if (displacedPath !== undefined) {
      await rm(displacedPath, { force: true });
      if (displacedWal) await rm(`${displacedPath}-wal`, { force: true });
      if (displacedShm) await rm(`${displacedPath}-shm`, { force: true });
    }
    return {
      manifest,
      path: resolve(options.backupPath),
      ...(preRestoreBackupPath === undefined ? {} : { preRestoreBackupPath }),
    };
  } finally {
    await rm(extractedPath, { force: true }).catch(() => undefined);
  }
}
