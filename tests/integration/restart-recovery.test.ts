import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JobExecutionError, JobRunner, JobService, WorkflowService } from '@openrepurpose/core';
import {
  openDatabase,
  runMigrations,
  SqliteDestinationJobRepository,
  SqliteJobRepository,
  SqliteMediaRepository,
  SqliteMetaCredentialRepository,
  SqliteWorkflowRepository,
} from '@openrepurpose/db';
import { FacebookReelsJobHandler } from '@openrepurpose/meta';
import { InMemorySecretStore } from '@openrepurpose/testkit';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

describe('restart recovery', () => {
  it('restores queue mode and account circuit state from SQLite', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-controls-restart-'));
    const databasePath = join(directory, 'openrepurpose.sqlite');
    const now = new Date('2026-01-01T00:00:00.000Z');
    const firstDatabase = openDatabase(databasePath);
    runMigrations(firstDatabase);
    const firstRepository = new SqliteJobRepository(firstDatabase);
    const firstService = new JobService(firstRepository, () => now);
    const job = firstService.create({
      type: 'youtube.upload',
      input: { accountId: 'restart-account', mediaId: 'restart-media' },
      maxAttempts: 1,
    }).job;
    firstRepository.claimNext(
      ['youtube.upload'],
      'first-worker',
      now,
      new Date(now.getTime() + 1_000),
    );
    firstRepository.fail(
      job.id,
      'first-worker',
      {
        category: 'authentication',
        code: 'YOUTUBE_TOKEN_REVOKED',
        message: 'Reconnect the YouTube account.',
        retryable: false,
      },
      now,
      undefined,
      1,
    );
    firstService.pauseQueue();
    firstDatabase.close();

    const secondDatabase = openDatabase(databasePath);
    try {
      runMigrations(secondDatabase);
      const repository = new SqliteJobRepository(secondDatabase);
      const service = new JobService(repository, () => new Date(now.getTime() + 1));
      expect(service.queueState().mode).toBe('paused');
      expect(service.accountControl('youtube', 'restart-account')).toMatchObject({
        authFailureCount: 1,
        status: 'paused',
      });
      expect(service.show(job.id)?.job).toMatchObject({
        accountId: 'restart-account',
        platformId: 'youtube',
        status: 'failed',
      });

      service.resumeQueue();
      service.resumeAccount('youtube', 'restart-account');
      service.retry(job.id);
      await new JobRunner(
        repository,
        [{ type: 'youtube.upload', execute: async () => undefined }],
        { concurrency: 1, now: () => new Date(now.getTime() + 1) },
      ).runOnce();
      expect(service.show(job.id)?.job.status).toBe('succeeded');
    } finally {
      secondDatabase.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

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

  it('reopens SQLite and resumes a partially uploaded Facebook Reel from Meta confirmed progress', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-meta-restart-'));
    const databasePath = join(directory, 'openrepurpose.sqlite');
    const mediaPath = join(directory, 'partial.mp4');
    writeFileSync(mediaPath, Buffer.alloc(16, 3));
    const now = new Date('2026-09-18T10:00:00.000Z');
    const secrets = new InMemorySecretStore();
    await secrets.set(
      { name: 'meta-page-token', ownerId: 'facebook-target', scope: 'account' },
      'page-token',
    );
    let startCalls = 0;
    let uploadCalls = 0;
    let finishCalls = 0;
    const resumedUploads: { offset: string | null; received: number }[] = [];
    const http = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/v26.0/page-restart/video_reels') {
        const form = init?.body?.toString() ?? '';
        if (form.includes('upload_phase=start')) {
          startCalls += 1;
          return json({
            upload_url: 'https://rupload.facebook.com/video-upload/restart',
            video_id: 'video-restart',
          });
        }
        finishCalls += 1;
        return json({ success: true });
      }
      if (url.hostname === 'rupload.facebook.com') {
        uploadCalls += 1;
        if (uploadCalls === 1) throw new Error('worker stopped during upload');
        let received = 0;
        for await (const part of init?.body as AsyncIterable<Uint8Array>) received += part.length;
        resumedUploads.push({ offset: new Headers(init?.headers).get('offset'), received });
        return json({ success: true });
      }
      if (url.pathname === '/v26.0/video-restart')
        return uploadCalls === 1
          ? json({ status: { bytes_transfered: 6, video_status: 'uploading' } })
          : json({ status: { video_status: 'published' } });
      throw new Error(`Unexpected request: ${url}`);
    };

    const firstDatabase = openDatabase(databasePath);
    runMigrations(firstDatabase);
    const media = new SqliteMediaRepository(firstDatabase);
    media.create({
      createdAt: now,
      fingerprint: 'sha256:facebook-restart',
      id: 'media-restart',
      metadata: { durationSeconds: 10, frameRate: 30, hasAudio: true, height: 1920, width: 1080 },
      modifiedAt: now,
      path: mediaPath,
      sizeBytes: 16,
      state: 'available',
    });
    const targets = new SqliteMetaCredentialRepository(firstDatabase);
    targets.upsertCredential({
      connectedAt: now,
      displayName: 'Restart Creator',
      externalId: 'person-restart',
      id: 'credential-restart',
      scopes: ['pages_manage_posts'],
      status: 'connected',
      tokenExpiresAt: new Date(now.getTime() + 86_400_000),
      updatedAt: now,
    });
    targets.upsertTarget({
      availability: 'available',
      credentialId: 'credential-restart',
      displayName: 'Restart Page',
      enabled: true,
      externalId: 'page-restart',
      id: 'facebook-target',
      kind: 'facebook_page',
      pageId: 'page-restart',
      updatedAt: now,
    });
    const firstJobRepository = new SqliteJobRepository(firstDatabase);
    const job = new JobService(firstJobRepository, () => now).create({
      maxAttempts: 3,
      type: 'facebook.reels.publish',
      input: { mediaId: 'media-restart', targetId: 'facebook-target' },
    }).job;
    await new JobRunner(
      firstJobRepository,
      [
        new FacebookReelsJobHandler(
          media,
          new SqliteDestinationJobRepository(firstDatabase),
          targets,
          secrets,
          { http, now: () => now },
        ),
      ],
      { baseRetryDelayMs: 0, maxRetryDelayMs: 0, now: () => now },
    ).runOnce();
    expect(new JobService(firstJobRepository).show(job.id)?.job.status).toBe('retrying');
    firstDatabase.close();

    const secondDatabase = openDatabase(databasePath);
    try {
      runMigrations(secondDatabase);
      const secondRepository = new SqliteJobRepository(secondDatabase);
      await new JobRunner(
        secondRepository,
        [
          new FacebookReelsJobHandler(
            new SqliteMediaRepository(secondDatabase),
            new SqliteDestinationJobRepository(secondDatabase),
            new SqliteMetaCredentialRepository(secondDatabase),
            secrets,
            { http, now: () => now },
          ),
        ],
        { baseRetryDelayMs: 0, maxRetryDelayMs: 0, now: () => now },
      ).runOnce();

      expect(new JobService(secondRepository).show(job.id)?.job.status).toBe('succeeded');
      expect(startCalls).toBe(1);
      expect(finishCalls).toBe(1);
      expect(resumedUploads).toEqual([{ offset: '6', received: 10 }]);
      expect(new SqliteDestinationJobRepository(secondDatabase).find(job.id)).toMatchObject({
        remoteId: 'video-restart',
        remoteStatus: 'published',
        uploadedBytes: 16,
      });
    } finally {
      secondDatabase.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps another destination successful when Meta fails and preserves per-destination idempotency after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-fanout-restart-'));
    const databasePath = join(directory, 'openrepurpose.sqlite');
    const firstDatabase = openDatabase(databasePath);
    runMigrations(firstDatabase);
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
          destinationId: 'instagram',
          accountId: 'instagram-target',
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
          type: 'instagram.reels.publish',
          execute: async (_input, context) => {
            calls.push('instagram');
            checkpoints.save({
              destinationId: 'instagram',
              jobId: context.jobId,
              remoteId: 'instagram-container',
              remoteStatus: 'failed',
              uploadedBytes: 10,
              updatedAt: new Date(),
            });
            throw new JobExecutionError(
              'INSTAGRAM_CONTAINER_ERROR',
              false,
              'Instagram could not process the Reel.',
            );
          },
        },
      ],
      { concurrency: 2 },
    );
    await runner.runOnce();
    const firstStates = Object.fromEntries(firstJobs.list().map((job) => [job.type, job.status]));
    expect(firstStates).toEqual({
      'instagram.reels.publish': 'failed',
      'youtube.upload': 'succeeded',
    });
    expect(new Set(firstJobs.list().map((job) => job.idempotencyKey)).size).toBe(2);
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
      expect(calls).toEqual(['youtube', 'instagram']);
    } finally {
      secondDatabase.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
