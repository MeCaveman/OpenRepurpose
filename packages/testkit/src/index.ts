import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, runMigrations } from '@openrepurpose/db';
import type { OpenRepurposeDatabase } from '@openrepurpose/db';

export interface TemporaryDatabase {
  readonly directory: string;
  readonly database: OpenRepurposeDatabase;
  dispose(): void;
}

/** Creates an isolated, migrated SQLite database for repository and service tests. */
export function createTemporaryDatabase(): TemporaryDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-test-'));
  const database = openDatabase(join(directory, 'openrepurpose.sqlite'));
  runMigrations(database);
  return {
    directory,
    database,
    dispose: () => {
      database.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
