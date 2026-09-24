import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCli } from '../../apps/cli/src/index.js';
import { JobService, WorkflowService } from '@openrepurpose/core';
import {
  createPortableBackup,
  openDatabase,
  restorePortableBackup,
  runMigrations,
  SettingsRepository,
  SqliteAccountRepository,
  SqliteJobRepository,
  SqliteWorkflowRepository,
} from '@openrepurpose/db';

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'openrepurpose-backup-test-'));
  directories.push(directory);
  return directory;
}

describe('portable backup and restore', () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('round-trips settings and workflows while excluding credentials and external content', async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, 'data', 'openrepurpose.sqlite');
    const backupPath = join(directory, 'exports', 'portable.orpbackup');
    let database = openDatabase(databasePath);
    runMigrations(database);
    new SettingsRepository(database).set('library.mode', 'referenced');
    new SqliteAccountRepository(database).upsert({
      capabilities: ['youtube.video.upload'],
      connectedAt: new Date(0),
      displayName: 'Channel',
      externalId: 'channel-1',
      id: 'account-1',
      provider: 'youtube',
      status: 'connected',
      updatedAt: new Date(0),
    });
    const workflow = new WorkflowService(
      new SqliteWorkflowRepository(database),
      new JobService(new SqliteJobRepository(database)),
      () => new Date(1_000),
    ).create({
      accountId: 'account-1',
      descriptionTemplate: 'description',
      name: 'Backup workflow',
      privacy: 'unlisted',
      sourceDirectory: join(directory, 'external-media'),
      titleTemplate: '{{file.stem}}',
    });
    database.client
      .prepare(
        `INSERT INTO api_tokens
         (id, name, verifier, permissions_json, created_at, last_used_at, revoked_at)
         VALUES ('token-1', 'admin', 'sensitive-verifier', '["control"]', 0, NULL, NULL)`,
      )
      .run();

    const created = await createPortableBackup({
      database,
      includeMetadata: true,
      now: () => new Date('2026-09-24T10:00:00.000Z'),
      outputPath: backupPath,
      temporaryDirectory: join(directory, 'temp'),
    });
    expect(created.manifest.contents).toEqual({
      database: true,
      derivatives: false,
      media: false,
      models: false,
      secrets: false,
    });
    expect(created.manifest.externalReferences?.entries).toContainEqual({
      kind: 'workflow-source',
      path: join(directory, 'external-media'),
    });
    expect((await readFile(backupPath)).includes(Buffer.from('sensitive-verifier'))).toBe(false);

    new SettingsRepository(database).set('library.mode', 'managed');
    database.close();
    const restored = await restorePortableBackup({
      backupPath,
      databasePath,
      now: () => new Date('2026-09-24T11:00:00.000Z'),
    });
    expect(restored.preRestoreBackupPath).toBeDefined();
    expect(existsSync(restored.preRestoreBackupPath!)).toBe(true);

    database = openDatabase(databasePath);
    expect(new SettingsRepository(database).get('library.mode')).toBe('referenced');
    expect(new SqliteWorkflowRepository(database).findById(workflow.id)?.name).toBe(
      'Backup workflow',
    );
    expect(new SqliteAccountRepository(database).findById('account-1')?.status).toBe(
      'reauthorization_required',
    );
    expect(database.client.prepare('SELECT COUNT(*) AS count FROM api_tokens').get()).toEqual({
      count: 0,
    });
    database.close();
  });

  it('rejects a corrupted backup before changing the current database', async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, 'openrepurpose.sqlite');
    const backupPath = join(directory, 'backup.orpbackup');
    const database = openDatabase(databasePath);
    runMigrations(database);
    new SettingsRepository(database).set('restore.guard', 'original');
    await createPortableBackup({ database, outputPath: backupPath });
    database.close();
    const bytes = readFileSync(backupPath);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    writeFileSync(backupPath, bytes);

    await expect(restorePortableBackup({ backupPath, databasePath })).rejects.toThrow('checksum');
    const unchanged = openDatabase(databasePath);
    expect(new SettingsRepository(unchanged).get('restore.guard')).toBe('original');
    unchanged.close();
  });

  it.skipIf(process.platform === 'win32')('refuses a symbolic-link backup input', async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, 'openrepurpose.sqlite');
    const backupPath = join(directory, 'backup.orpbackup');
    const linkedPath = join(directory, 'linked.orpbackup');
    const database = openDatabase(databasePath);
    runMigrations(database);
    await createPortableBackup({ database, outputPath: backupPath });
    database.close();
    await symlink(backupPath, linkedPath);

    await expect(restorePortableBackup({ backupPath: linkedPath, databasePath })).rejects.toThrow(
      'regular file',
    );
  });

  it('exposes create and restore through the documented CLI command family', async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, 'data', 'openrepurpose.sqlite');
    const backupPath = join(directory, 'portable.orpbackup');
    const environment = {
      APP_CONFIG_DIR: join(directory, 'config'),
      APP_DATA_DIR: join(directory, 'data'),
      APP_TEMP_DIR: join(directory, 'temp'),
      DATABASE_URL: databasePath,
    };
    let database = openDatabase(databasePath);
    runMigrations(database);
    new SettingsRepository(database).set('cli.roundtrip', 'backed-up');
    database.close();
    const output: string[] = [];

    await createCli({ environment, write: (value) => output.push(value) }).parseAsync([
      'node',
      'openrepurpose',
      'backup',
      'create',
      '--output',
      backupPath,
    ]);
    expect(output.join('')).toContain('secrets\texcluded');

    database = openDatabase(databasePath);
    new SettingsRepository(database).set('cli.roundtrip', 'changed');
    database.close();
    await createCli({ environment, write: (value) => output.push(value) }).parseAsync([
      'node',
      'openrepurpose',
      'backup',
      'restore',
      backupPath,
    ]);
    database = openDatabase(databasePath);
    expect(new SettingsRepository(database).get('cli.roundtrip')).toBe('backed-up');
    database.close();
  });
});
