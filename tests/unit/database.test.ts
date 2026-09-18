import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  migrations,
  openDatabase,
  runMigrations,
  SettingsRepository,
  SqliteWorkflowRepository,
} from '../../packages/db/src/index.js';
import { createTemporaryDatabase } from '../../packages/testkit/src/index.js';
import type { TemporaryDatabase } from '../../packages/testkit/src/index.js';
import { createV02DatabaseFixture } from '../fixtures/v02-database.js';

describe('SQLite migrations and repositories', () => {
  let temporaryDatabase: TemporaryDatabase | undefined;

  afterEach(() => temporaryDatabase?.dispose());

  it('migrates a temporary database and persists settings', () => {
    temporaryDatabase = createTemporaryDatabase();
    const settings = new SettingsRepository(temporaryDatabase.database);
    settings.set('library.mode', 'referenced');
    settings.set('library.mode', 'managed');

    expect(settings.get('library.mode')).toBe('managed');
    expect(
      temporaryDatabase.database.client.prepare('SELECT id FROM __openrepurpose_migrations').all(),
    ).toEqual([
      { id: '0001_initial_settings' },
      { id: '0002_media_assets' },
      { id: '0003_persistent_jobs' },
      { id: '0004_youtube_oauth' },
      { id: '0005_destination_job_records' },
      { id: '0006_workflows' },
      { id: '0007_tiktok_oauth' },
      { id: '0008_workflow_destinations' },
      { id: '0009_meta_credentials_targets' },
      { id: '0010_meta_workflow_destinations' },
      { id: '0011_source_domain' },
      { id: '0012_media_resolution' },
      { id: '0013_source_workflow_integration' },
    ]);
  });
  it('rejects a modified migration after it has been applied', () => {
    temporaryDatabase = createTemporaryDatabase();
    expect(() =>
      runMigrations(temporaryDatabase.database, [
        { id: '0001_initial_settings', sql: 'CREATE TABLE settings (key TEXT PRIMARY KEY);' },
      ]),
    ).toThrow('does not match its recorded checksum');
  });
  it('upgrades a populated v0.1 schema and preserves YouTube workflow references', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-v01-migration-'));
    const database = openDatabase(join(directory, 'openrepurpose.sqlite'));
    temporaryDatabase = {
      directory,
      database,
      dispose: () => {
        database.close();
        rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
      },
    };
    runMigrations(database, migrations.slice(0, 6));
    database.client
      .prepare(
        `INSERT INTO accounts (
          id, provider, external_id, display_name, status, capabilities_json,
          connected_at, updated_at
        ) VALUES (?, 'youtube', ?, ?, 'connected', ?, ?, ?)`,
      )
      .run('youtube-account', 'youtube-channel', 'Creator', '[]', 1, 1);
    database.client
      .prepare(
        `INSERT INTO workflows (
          id, name, enabled, source_directory, account_id, title_template,
          description_template, privacy, category, created_at, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, '', 'private', NULL, ?, ?)`,
      )
      .run('workflow-1', 'Existing workflow', 'C:\\Media', 'youtube-account', '{{filename}}', 1, 1);

    runMigrations(database);

    expect(database.client.prepare('SELECT failure_policy FROM workflows').get()).toEqual({
      failure_policy: 'best_effort',
    });
    expect(
      database.client
        .prepare('SELECT destination_id, account_id, configuration_json FROM workflow_destinations')
        .get(),
    ).toEqual({
      account_id: 'youtube-account',
      configuration_json: '{"privacy":"private","category":null}',
      destination_id: 'youtube',
    });
    expect(new SqliteWorkflowRepository(database).findById('workflow-1')).toMatchObject({
      destinations: [
        { accountId: 'youtube-account', destinationId: 'youtube', privacy: 'private' },
      ],
      failurePolicy: 'best_effort',
    });
    expect(() =>
      database.client
        .prepare(
          `INSERT INTO accounts (
            id, provider, external_id, display_name, status, capabilities_json,
            connected_at, updated_at
          ) VALUES (?, 'tiktok', ?, ?, 'connected', ?, ?, ?)`,
        )
        .run('tiktok-account', 'open-id', 'TikTok Creator', '[]', 2, 2),
    ).not.toThrow();
  });
  it('upgrades a populated v0.2 fixture and preserves both destination records', () => {
    const fixture = createV02DatabaseFixture();
    temporaryDatabase = fixture;

    runMigrations(fixture.database);

    expect(
      fixture.database.client.prepare('SELECT id FROM __openrepurpose_migrations').all(),
    ).toHaveLength(13);
    expect(
      fixture.database.client.prepare('SELECT provider FROM accounts ORDER BY provider').all(),
    ).toEqual([{ provider: 'tiktok' }, { provider: 'youtube' }]);
    expect(new SqliteWorkflowRepository(fixture.database).findById('workflow-v02')).toMatchObject({
      name: 'v0.2 watched uploads',
      destinations: [
        { destinationId: 'youtube', accountId: 'youtube-v02', privacy: 'private' },
        { destinationId: 'tiktok', accountId: 'tiktok-v02', privacyLevel: 'SELF_ONLY' },
      ],
    });
    expect(
      fixture.database.client
        .prepare('SELECT name FROM sqlite_master WHERE name IN (?, ?) ORDER BY name')
        .all('meta_credentials', 'meta_publish_targets'),
    ).toEqual([{ name: 'meta_credentials' }, { name: 'meta_publish_targets' }]);
  });
  it('upgrades a populated v0.3 database without changing existing job checkpoints', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-v03-migration-'));
    const database = openDatabase(join(directory, 'openrepurpose.sqlite'));
    temporaryDatabase = {
      directory,
      database,
      dispose: () => {
        database.close();
        rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
      },
    };
    runMigrations(database, migrations.slice(0, 10));
    database.client
      .prepare(
        `INSERT INTO jobs (
          id, type, status, input_json, idempotency_key, max_attempts, attempt_count,
          available_at, created_at, updated_at, completed_at
        ) VALUES ('v03-job', 'facebook.reels.publish', 'succeeded', '{}', 'v03-idempotency',
          3, 1, 1, 1, 2, 2)`,
      )
      .run();
    database.client
      .prepare(
        `INSERT INTO destination_job_records (
          job_id, destination_id, remote_id, remote_status, uploaded_bytes, updated_at
        ) VALUES ('v03-job', 'facebook', 'remote-v03', 'published', 42, 2)`,
      )
      .run();

    runMigrations(database);

    expect(
      database.client
        .prepare(
          `SELECT destination_id, remote_id, remote_status
           FROM destination_job_records WHERE job_id = 'v03-job'`,
        )
        .get(),
    ).toEqual({ destination_id: 'facebook', remote_id: 'remote-v03', remote_status: 'published' });
    expect(
      database.client
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name LIKE 'source_%'
           ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: 'source_connections' },
      { name: 'source_cursors' },
      { name: 'source_execution_destinations' },
      { name: 'source_items' },
      { name: 'source_media_artifacts' },
      { name: 'source_media_resolutions' },
      { name: 'source_workflow_executions' },
    ]);
  });
});
