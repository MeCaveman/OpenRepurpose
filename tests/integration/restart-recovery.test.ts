import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JobExecutionError, JobRunner, JobService, WorkflowService } from '@openrepurpose/core';
import {
  openDatabase,
  runMigrations,
  SqliteAccountRepository,
  SqliteDestinationJobRepository,
  SqliteJobRepository,
  SqliteWorkflowRepository,
} from '@openrepurpose/db';

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

  it('keeps a successful destination when another fails and does not republish after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-fanout-restart-'));
    const databasePath = join(directory, 'openrepurpose.sqlite');
    const firstDatabase = openDatabase(databasePath);
    runMigrations(firstDatabase);
    const accounts = new SqliteAccountRepository(firstDatabase);
    for (const account of [
      { id: 'youtube-account', provider: 'youtube' as const },
      { id: 'tiktok-account', provider: 'tiktok' as const },
    ])
      accounts.upsert({
        ...account,
        externalId: account.id,
        displayName: account.id,
        status: 'connected',
        capabilities:
          account.provider === 'youtube' ? ['youtube.video.upload'] : ['tiktok.video.publish'],
        connectedAt: new Date(0),
        updatedAt: new Date(0),
      });
    const firstJobs = new JobService(new SqliteJobRepository(firstDatabase));
    const workflows = new WorkflowService(new SqliteWorkflowRepository(firstDatabase), firstJobs);
    const workflow = workflows.create({
      name: 'Independent fan-out',
      sourceDirectory: directory,
      titleTemplate: '{{file.stem}}',
      destinations: [
        {
          destinationId: 'youtube',
          accountId: 'youtube-account',
          privacy: 'private',
        },
        {
          destinationId: 'tiktok',
          accountId: 'tiktok-account',
          privacyLevel: 'SELF_ONLY',
        },
      ],
    });
    const media = {
      id: 'media-1',
      path: join(directory, 'clip.mp4'),
      fingerprint: 'sha256:clip',
      sizeBytes: 10,
      modifiedAt: new Date(0),
      createdAt: new Date(0),
      state: 'available' as const,
      metadata: { hasAudio: true },
    };
    const created = workflows.executeWatchedMedia(workflow.id, media);
    expect(created?.destinations.every((destination) => destination.created)).toBe(true);
    const checkpoints = new SqliteDestinationJobRepository(firstDatabase);
    const calls: string[] = [];
    const runner = new JobRunner(
      new SqliteJobRepository(firstDatabase),
      [
        {
          type: 'youtube.upload',
          execute: async (_input, context) => {
            calls.push('youtube');
            checkpoints.save({
              destinationId: 'youtube',
              jobId: context.jobId,
              remoteId: 'youtube-video',
              remoteStatus: 'succeeded',
              uploadedBytes: 10,
              updatedAt: new Date(),
            });
          },
        },
        {
          type: 'tiktok.direct-post',
          execute: async (_input, context) => {
            calls.push('tiktok');
            checkpoints.save({
              destinationId: 'tiktok',
              jobId: context.jobId,
              remoteId: 'tiktok-publish',
              remoteStatus: 'failed',
              uploadedBytes: 10,
              updatedAt: new Date(),
            });
            throw new JobExecutionError('TIKTOK_REJECTED', false, 'TikTok rejected the post.');
          },
        },
      ],
      { concurrency: 2 },
    );
    await runner.runOnce();
    const firstStates = Object.fromEntries(firstJobs.list().map((job) => [job.type, job.status]));
    expect(firstStates).toEqual({ 'tiktok.direct-post': 'failed', 'youtube.upload': 'succeeded' });
    firstDatabase.close();

    const secondDatabase = openDatabase(databasePath);
    try {
      runMigrations(secondDatabase);
      const secondJobs = new JobService(new SqliteJobRepository(secondDatabase));
      const resumedWorkflows = new WorkflowService(
        new SqliteWorkflowRepository(secondDatabase),
        secondJobs,
      );
      const repeated = resumedWorkflows.executeWatchedMedia(workflow.id, media);
      expect(repeated?.destinations.every((destination) => !destination.created)).toBe(true);
      expect(secondJobs.list()).toHaveLength(2);
      const successful = secondJobs.list().find((job) => job.type === 'youtube.upload')!;
      expect(successful.status).toBe('succeeded');
      expect(new SqliteDestinationJobRepository(secondDatabase).find(successful.id)).toMatchObject({
        remoteId: 'youtube-video',
        remoteStatus: 'succeeded',
      });
      expect(calls).toEqual(['youtube', 'tiktok']);
    } finally {
      secondDatabase.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
