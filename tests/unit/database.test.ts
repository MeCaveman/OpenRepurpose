import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations, SettingsRepository } from '../../packages/db/src/index.js';
import { createTemporaryDatabase } from '../../packages/testkit/src/index.js';
import type { TemporaryDatabase } from '../../packages/testkit/src/index.js';

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
});
