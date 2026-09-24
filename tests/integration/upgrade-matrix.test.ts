import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPortableBackup,
  migrations,
  openDatabase,
  restorePortableBackup,
  runMigrations,
  SettingsRepository,
} from '@openrepurpose/db';
import type { Migration, OpenRepurposeDatabase } from '@openrepurpose/db';

interface UpgradeFixtureRecord {
  readonly file: string;
  readonly history: string;
  readonly id: string;
  readonly migrationIds: readonly string[];
  readonly schemaVersion: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly sourceCommit: string;
}

interface UpgradeFixtureManifest {
  readonly fixtures: readonly UpgradeFixtureRecord[];
  readonly provenance: {
    readonly note: string;
    readonly v09SourceCommit: string;
  };
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureDirectory = join(repositoryRoot, 'tests', 'fixtures', 'upgrade');
const manifest = JSON.parse(
  readFileSync(join(fixtureDirectory, 'manifest.json'), 'utf8'),
) as UpgradeFixtureManifest;
const temporaryDirectories: string[] = [];

function fixtureRecord(id: string): UpgradeFixtureRecord {
  const fixture = manifest.fixtures.find((candidate) => candidate.id === id);
  if (fixture === undefined) throw new Error(`Missing upgrade fixture ${id}.`);
  return fixture;
}

function fixturePath(fixture: UpgradeFixtureRecord): string {
  return resolve(repositoryRoot, fixture.file);
}

function temporaryFixtureCopy(fixture: UpgradeFixtureRecord): {
  readonly backupDirectory: string;
  readonly databasePath: string;
  readonly directory: string;
} {
  const directory = mkdtempSync(join(tmpdir(), `openrepurpose-${fixture.id}-`));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, 'openrepurpose.sqlite');
  copyFileSync(fixturePath(fixture), databasePath);
  return { backupDirectory: join(directory, 'backups'), databasePath, directory };
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function tableExists(database: OpenRepurposeDatabase, table: string): boolean {
  return (
    database.client
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(table) !== undefined
  );
}

function preservationSnapshot(database: OpenRepurposeDatabase): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    accounts: database.client
      .prepare(
        `SELECT id, provider, external_id, display_name, status, capabilities_json,
          connected_at, updated_at FROM accounts ORDER BY id`,
      )
      .all(),
    destinationCheckpoints: database.client
      .prepare(
        `SELECT job_id, destination_id, remote_id, remote_url, remote_status,
          uploaded_bytes, updated_at FROM destination_job_records ORDER BY job_id`,
      )
      .all(),
    executionDestinations: database.client
      .prepare(
        `SELECT id, execution_id, destination_key, destination_id, required, job_id,
          idempotency_key, status, remote_id, remote_url, attempt_count, completed_at
          FROM source_execution_destinations ORDER BY id`,
      )
      .all(),
    executions: database.client
      .prepare(
        `SELECT id, source_item_id, workflow_id, workflow_key, workflow_version, status,
          snapshot_json, retention_policy, retention_duration_seconds, cleanup_status,
          cleanup_eligible_at, completed_at FROM source_workflow_executions ORDER BY id`,
      )
      .all(),
    jobs: database.client
      .prepare(
        `SELECT id, type, status, input_json, idempotency_key, max_attempts, attempt_count,
          available_at, created_at, updated_at, completed_at FROM jobs ORDER BY id`,
      )
      .all(),
    settings: database.client.prepare('SELECT key, value FROM settings ORDER BY key').all(),
    sourceConnections: database.client
      .prepare(
        `SELECT id, adapter_id, account_id, external_source_id, display_name, configuration_json,
          status, cursor_json, watermark_published_at, watermark_external_id,
          last_poll_at, last_successful_poll_at, consecutive_poll_failures, next_poll_at
          FROM source_connections ORDER BY id`,
      )
      .all(),
    sourceCursors: database.client
      .prepare(
        `SELECT workflow_id, source_key, path, size_bytes, modified_at, observed_at, state,
          media_id FROM source_cursors ORDER BY workflow_id, source_key`,
      )
      .all(),
    workflows: database.client
      .prepare(
        `SELECT id, name, enabled, source_directory, title_template, description_template,
          failure_policy, created_at, updated_at FROM workflows ORDER BY id`,
      )
      .all(),
  };
  if (tableExists(database, 'schedules')) {
    snapshot.schedules = database.client
      .prepare(
        `SELECT id, status, revision, target_json, definition_json, time_zone,
          next_occurrence_at, last_occurrence_at, created_at, updated_at
          FROM schedules ORDER BY id`,
      )
      .all();
    snapshot.scheduleOccurrences = database.client
      .prepare(
        `SELECT id, schedule_id, schedule_revision, scheduled_for_utc, target_json,
          dispatch_status, error_message, created_at, updated_at
          FROM schedule_occurrences ORDER BY id`,
      )
      .all();
  }
  if (tableExists(database, 'api_tokens'))
    snapshot.apiTokens = database.client
      .prepare(
        `SELECT id, name, verifier, permissions_json, created_at, last_used_at, revoked_at
          FROM api_tokens ORDER BY id`,
      )
      .all();
  if (tableExists(database, 'webhook_destinations'))
    snapshot.webhooks = database.client
      .prepare(
        `SELECT id, name, url, events_json, enabled, created_at, updated_at
          FROM webhook_destinations ORDER BY id`,
      )
      .all();
  return snapshot;
}

function migrationIds(database: OpenRepurposeDatabase | DatabaseSync): readonly string[] {
  const client = database instanceof DatabaseSync ? database : database.client;
  return (
    client.prepare('SELECT id FROM __openrepurpose_migrations ORDER BY rowid').all() as unknown as {
      id: string;
    }[]
  ).map((row) => row.id);
}

function expectHealthy(database: OpenRepurposeDatabase | DatabaseSync): void {
  const client = database instanceof DatabaseSync ? database : database.client;
  expect(client.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  expect(client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
}

function expectV09RequiredState(database: OpenRepurposeDatabase, secretFree = false): void {
  expect(new SettingsRepository(database).get('fixture.release')).toBe('v0.9-latest');
  expect(
    database.client
      .prepare(
        `SELECT external_id, display_name, status, capabilities_json
          FROM accounts WHERE id = 'account-v0.9-latest'`,
      )
      .get(),
  ).toEqual({
    capabilities_json: '["youtube.video.upload","youtube.channel.read"]',
    display_name: 'v0.9-latest creator',
    external_id: 'channel-v0.9-latest',
    status: secretFree ? 'reauthorization_required' : 'connected',
  });
  expect(
    database.client
      .prepare(
        `SELECT name, definition_json, execution_plan_json FROM workflows
          WHERE id = 'workflow-v0.9-latest'`,
      )
      .get(),
  ).toMatchObject({ name: 'v0.9-latest workflow' });
  expect(
    database.client.prepare("SELECT input_json FROM jobs WHERE id = 'job-v0.9-latest'").get(),
  ).toEqual({
    input_json:
      '{"accountId":"account-v0.9-latest","immutable":"job-input-v0.9-latest","mediaId":"media-v0.9-latest"}',
  });
  expect(
    database.client
      .prepare(
        `SELECT state, media_id FROM source_cursors
          WHERE workflow_id = 'workflow-v0.9-latest' AND source_key = 'cursor-v0.9-latest'`,
      )
      .get(),
  ).toEqual({ media_id: 'media-v0.9-latest', state: 'processed' });
  expect(
    database.client
      .prepare(
        `SELECT revision, target_json, definition_json, time_zone FROM schedules
          WHERE id = 'schedule-v0.9-latest'`,
      )
      .get(),
  ).toEqual({
    definition_json: '{"hour":9,"kind":"daily","minute":30}',
    revision: 3,
    target_json: '{"kind":"source_poll","sourceConnectionId":"source-v0.9-latest"}',
    time_zone: 'Asia/Riyadh',
  });
  expect(
    database.client
      .prepare(
        `SELECT snapshot_json, workflow_version FROM source_workflow_executions
          WHERE id = 'execution-v0.9-latest'`,
      )
      .get(),
  ).toMatchObject({ workflow_version: 'v0.9-latest-snapshot-v1' });
  expect(
    database.client
      .prepare(
        `SELECT cursor_json, watermark_external_id, status FROM source_connections
          WHERE id = 'source-v0.9-latest'`,
      )
      .get(),
  ).toEqual({
    cursor_json: '{"pageToken":"v0.9-latest-cursor"}',
    status: secretFree ? 'authorization_failed' : 'active',
    watermark_external_id: 'item-v0.9-latest',
  });
  expect(database.client.prepare('SELECT COUNT(*) AS count FROM api_tokens').get()).toEqual({
    count: secretFree ? 0 : 1,
  });
  expect(
    database.client
      .prepare("SELECT enabled FROM webhook_destinations WHERE id = 'webhook-v0.9-latest'")
      .get(),
  ).toEqual({ enabled: secretFree ? 0 : 1 });
}

describe('v1.0 stored database upgrade matrix', () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0))
      rmSync(directory, { force: true, maxRetries: 3, recursive: true });
  });

  it('pins immutable, healthy fixtures to explicit historical boundaries', () => {
    expect(manifest.provenance.v09SourceCommit).toBe('fa974d48b86881159506094b33058c55433aee3c');
    expect(manifest.provenance.note).toContain('no release tag');
    expect(manifest.fixtures.map((fixture) => fixture.id)).toEqual([
      'v0.4-migrated-chain',
      'v0.8-latest',
      'v0.9-latest',
    ]);

    for (const fixture of manifest.fixtures) {
      const path = fixturePath(fixture);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path)).toHaveLength(fixture.sizeBytes);
      expect(sha256(path)).toBe(fixture.sha256);
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        expectHealthy(database);
        expect(migrationIds(database)).toEqual(fixture.migrationIds);
        expect(fixture.migrationIds.at(-1)).toBe(fixture.schemaVersion);
      } finally {
        database.close();
      }
    }
  });

  it.each(manifest.fixtures)(
    'upgrades $id through the full v1 chain without data loss',
    (fixture) => {
      const { backupDirectory, databasePath } = temporaryFixtureCopy(fixture);
      const database = openDatabase(databasePath);
      try {
        const before = preservationSnapshot(database);
        const result = runMigrations(database, migrations, {
          backupDirectory,
          now: () => new Date('2026-09-24T12:00:00.000Z'),
        });
        expect(result.applied).toEqual(
          migrations.slice(fixture.migrationIds.length).map(({ id }) => id),
        );
        expect(result.backupPath).toBeDefined();
        expect(existsSync(result.backupPath!)).toBe(true);
        expect(migrationIds(database).at(-1)).toBe('0027_v1_compatibility');
        const after = preservationSnapshot(database);
        expect(Object.fromEntries(Object.keys(before).map((key) => [key, after[key]]))).toEqual(
          before,
        );
        expectHealthy(database);

        const recoveryCopy = new DatabaseSync(result.backupPath!, { readOnly: true });
        try {
          expectHealthy(recoveryCopy);
          expect(migrationIds(recoveryCopy)).toEqual(fixture.migrationIds);
        } finally {
          recoveryCopy.close();
        }
      } finally {
        database.close();
      }
    },
  );

  it('rolls a successful v0.9 upgrade back to its exact recovery copy and upgrades again', () => {
    const fixture = fixtureRecord('v0.9-latest');
    const { backupDirectory, databasePath } = temporaryFixtureCopy(fixture);
    let database = openDatabase(databasePath);
    const before = preservationSnapshot(database);
    const upgraded = runMigrations(database, migrations, { backupDirectory });
    expect(upgraded.applied).toEqual(['0027_v1_compatibility']);
    expectV09RequiredState(database);
    database.close();

    copyFileSync(upgraded.backupPath!, databasePath);
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    database = openDatabase(databasePath);
    try {
      expect(migrationIds(database).at(-1)).toBe('0026_webhooks');
      expect(preservationSnapshot(database)).toEqual(before);
      expectV09RequiredState(database);
      expect(runMigrations(database, migrations, { backupDirectory }).applied).toEqual([
        '0027_v1_compatibility',
      ]);
      expectHealthy(database);
    } finally {
      database.close();
    }
  });

  it('keeps a failed migration atomic and recovers the pre-upgrade v0.9 database', () => {
    const fixture = fixtureRecord('v0.9-latest');
    const { backupDirectory, databasePath } = temporaryFixtureCopy(fixture);
    const failureProbe: Migration = {
      id: '0028_packet8_failure_probe',
      sql: `
        CREATE TABLE packet8_failure_probe (value TEXT NOT NULL);
        INSERT INTO packet8_failure_probe (value) VALUES ('must-roll-back');
        INSERT INTO table_that_does_not_exist (value) VALUES ('fail');
      `,
    };
    let database = openDatabase(databasePath);
    const before = preservationSnapshot(database);
    expect(() =>
      runMigrations(database, [...migrations, failureProbe], { backupDirectory }),
    ).toThrow('no such table');
    expect(migrationIds(database).at(-1)).toBe('0027_v1_compatibility');
    expect(tableExists(database, 'packet8_failure_probe')).toBe(false);
    expect(preservationSnapshot(database)).toEqual(before);
    database.close();

    const recoveryFiles = readdirSync(backupDirectory).filter((file) => file.endsWith('.bak'));
    expect(recoveryFiles).toHaveLength(1);
    copyFileSync(join(backupDirectory, recoveryFiles[0]!), databasePath);
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    database = openDatabase(databasePath);
    try {
      expect(migrationIds(database).at(-1)).toBe('0026_webhooks');
      expect(preservationSnapshot(database)).toEqual(before);
      expectV09RequiredState(database);
      expectHealthy(database);
    } finally {
      database.close();
    }
  });

  it('round-trips the upgraded v0.9 fixture through portable backup and preserves rollback state', async () => {
    const fixture = fixtureRecord('v0.9-latest');
    const { databasePath, directory } = temporaryFixtureCopy(fixture);
    const portablePath = join(directory, 'v1.orpbackup');
    let database = openDatabase(databasePath);
    runMigrations(database);
    expectV09RequiredState(database);
    await createPortableBackup({
      database,
      now: () => new Date('2026-09-24T13:00:00.000Z'),
      outputPath: portablePath,
      temporaryDirectory: join(directory, 'temporary'),
    });
    new SettingsRepository(database).set('fixture.release', 'mutated-after-backup');
    database.close();

    const restored = await restorePortableBackup({
      backupDirectory: join(directory, 'restore-backups'),
      backupPath: portablePath,
      databasePath,
      now: () => new Date('2026-09-24T14:00:00.000Z'),
    });
    expect(restored.manifest.database.schemaVersion).toBe('0027_v1_compatibility');
    expect(restored.preRestoreBackupPath).toBeDefined();

    const displaced = openDatabase(restored.preRestoreBackupPath!, {
      createParentDirectory: false,
    });
    try {
      expect(new SettingsRepository(displaced).get('fixture.release')).toBe('mutated-after-backup');
    } finally {
      displaced.close();
    }

    database = openDatabase(databasePath);
    try {
      expect(runMigrations(database).applied).toEqual([]);
      expectV09RequiredState(database, true);
      expectHealthy(database);
    } finally {
      database.close();
    }
  });
});
