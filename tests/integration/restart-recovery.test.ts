import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JobRunner, JobService } from '@openrepurpose/core';
import { openDatabase, runMigrations, SqliteJobRepository } from '@openrepurpose/db';

describe('restart recovery', () => {
  it('reopens the same SQLite database and resumes an abandoned running job', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-restart-'));
    const databasePath = join(directory, 'openrepurpose.sqlite');
    const firstDatabase = openDatabase(databasePath);
    runMigrations(firstDatabase);
    const firstRepository = new SqliteJobRepository(firstDatabase);
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    const created = new JobService(firstRepository, () => startedAt).create({
      type: 'fake.restart',
      input: { source: 'watched-folder' },
      maxAttempts: 2,
    }).job;
    expect(
      firstRepository.claimNext(
        ['fake.restart'],
        'crashed-worker',
        startedAt,
        new Date(startedAt.getTime() + 10),
      ),
    ).toMatchObject({ id: created.id, status: 'running' });
    firstDatabase.close();

    const secondDatabase = openDatabase(databasePath);
    try {
      runMigrations(secondDatabase);
      const repository = new SqliteJobRepository(secondDatabase);
      const service = new JobService(repository, () => new Date('2026-01-01T00:00:00.020Z'));
      expect(repository.recoverExpiredLeases(new Date('2026-01-01T00:00:00.011Z'))).toBe(1);
      const runner = new JobRunner(
        repository,
        [{ type: 'fake.restart', execute: async () => undefined }],
        {
          concurrency: 1,
          leaseDurationMs: 1_000,
          pollIntervalMs: 10,
          now: () => new Date('2026-01-01T00:00:00.020Z'),
        },
      );
      await runner.runOnce();
      expect(service.show(created.id)?.job.status).toBe('succeeded');
      expect(service.show(created.id)?.attempts.map((attempt) => attempt.errorCode)).toEqual([
        'LEASE_EXPIRED',
        undefined,
      ]);
    } finally {
      secondDatabase.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
