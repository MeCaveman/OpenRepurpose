import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { JobExecutionError, JobRunner, JobService, TransformService } from '@openrepurpose/core';
import type { JobHandler } from '@openrepurpose/core';
import {
  SqliteJobRepository,
  SqliteMediaRepository,
  SqliteTransformDerivativeRepository,
} from '@openrepurpose/db';
import { buildServer } from '@openrepurpose/server';
import { createTemporaryDatabase } from '@openrepurpose/testkit';
import type { TemporaryDatabase } from '@openrepurpose/testkit';
import { createCli } from '../../apps/cli/src/index.js';
import type { ApplicationConfig, Environment } from '@openrepurpose/shared';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function testConfig(directory: string): ApplicationConfig {
  return {
    appUrl: new URL('http://127.0.0.1:3000'),
    bindHost: '127.0.0.1',
    jobRunner: {
      accountConcurrency: 1,
      authFailureThreshold: 3,
      baseRetryDelayMs: 1,
      concurrency: 2,
      leaseDurationMs: 1_000,
      maxRetryDelayMs: 10,
      pollIntervalMs: 25,
      platformConcurrency: 2,
    },
    paths: {
      configDirectory: join(directory, 'config'),
      dataDirectory: directory,
      databasePath: join(directory, 'openrepurpose.sqlite'),
      secretKeyPath: join(directory, 'config', 'secret-vault.key'),
      secretVaultPath: join(directory, 'secrets.vault.json'),
      sessionKeyPath: join(directory, 'config', 'session.key'),
      temporaryDirectory: join(directory, 'temp'),
      transcriptionModelDirectory: join(directory, 'models', 'whisper-cpp'),
    },
    port: 3000,
  };
}

describe('persistent jobs', () => {
  let temporary: TemporaryDatabase | undefined;
  let server: FastifyInstance | undefined;

  afterEach(async () => {
    await server?.close();
    temporary?.dispose();
    server = undefined;
  });

  it('persists an immutable input snapshot and deduplicates by idempotency key', () => {
    temporary = createTemporaryDatabase();
    const repository = new SqliteJobRepository(temporary.database);
    const service = new JobService(repository);
    const input = { mediaId: 'media-1', destination: { privacy: 'private' } };

    const first = service.create({
      type: 'fake.publish',
      input,
      idempotencyKey: 'workflow-1:source-1:destination-1',
    });
    input.destination.privacy = 'public';
    const duplicate = service.create({
      type: 'fake.publish',
      input: { mediaId: 'different' },
      idempotencyKey: 'workflow-1:source-1:destination-1',
    });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);
    expect(repository.findById(first.job.id)?.input).toEqual({
      mediaId: 'media-1',
      destination: { privacy: 'private' },
    });
  });

  it('does not claim a dependent job until its prerequisite succeeds', async () => {
    temporary = createTemporaryDatabase();
    const repository = new SqliteJobRepository(temporary.database);
    const service = new JobService(repository, () => new Date(1_000));
    const prerequisite = service.create({ type: 'transform', input: {} });
    const dependent = service.create({
      type: 'publish',
      input: {},
      dependsOnJobId: prerequisite.job.id,
    });
    const handled: string[] = [];
    const runner = new JobRunner(
      repository,
      [
        { type: 'transform', execute: async () => handled.push('transform') },
        { type: 'publish', execute: async () => handled.push('publish') },
      ],
      { now: () => new Date(1_000), leaseDurationMs: 1_000 },
    );
    await runner.runOnce();
    await runner.runOnce();
    expect(handled).toEqual(['transform', 'publish']);
    expect(repository.findById(dependent.job.id)?.status).toBe('succeeded');
  });

  it('bounds concurrency and persists successful attempt history', async () => {
    temporary = createTemporaryDatabase();
    const repository = new SqliteJobRepository(temporary.database);
    const service = new JobService(repository);
    for (let index = 0; index < 3; index += 1)
      service.create({ type: 'fake.work', input: { index } });

    let active = 0;
    let maximumActive = 0;
    const handler: JobHandler = {
      type: 'fake.work',
      execute: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
      },
    };
    const runner = new JobRunner(repository, [handler], {
      concurrency: 2,
      leaseDurationMs: 1_000,
      pollIntervalMs: 25,
    });

    await runner.runOnce();
    await runner.runOnce();

    expect(maximumActive).toBe(2);
    expect(service.list().map((job) => job.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    for (const job of service.list())
      expect(service.show(job.id)?.attempts).toMatchObject([{ status: 'succeeded' }]);
  });

  it('enforces persisted global, platform, and account concurrency scopes', async () => {
    temporary = createTemporaryDatabase();
    const repository = new SqliteJobRepository(temporary.database);
    const service = new JobService(repository);
    for (const accountId of ['youtube-a', 'youtube-a', 'youtube-b'])
      service.create({ type: 'youtube.upload', input: { accountId, mediaId: accountId } });
    service.create({
      type: 'tiktok.direct-post',
      input: { accountId: 'tiktok-a', mediaId: 'tiktok-a' },
    });
    const activeByPlatform = new Map<string, number>();
    const activeByAccount = new Map<string, number>();
    let activeGlobal = 0;
    let maximumGlobal = 0;
    let maximumYouTube = 0;
    let maximumYouTubeA = 0;
    const execute = async (input: unknown, platform: string) => {
      const accountId = (input as { accountId: string }).accountId;
      activeGlobal += 1;
      activeByPlatform.set(platform, (activeByPlatform.get(platform) ?? 0) + 1);
      activeByAccount.set(accountId, (activeByAccount.get(accountId) ?? 0) + 1);
      maximumGlobal = Math.max(maximumGlobal, activeGlobal);
      maximumYouTube = Math.max(maximumYouTube, activeByPlatform.get('youtube') ?? 0);
      maximumYouTubeA = Math.max(maximumYouTubeA, activeByAccount.get('youtube-a') ?? 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeGlobal -= 1;
      activeByPlatform.set(platform, (activeByPlatform.get(platform) ?? 1) - 1);
      activeByAccount.set(accountId, (activeByAccount.get(accountId) ?? 1) - 1);
    };
    const runner = new JobRunner(
      repository,
      [
        { type: 'youtube.upload', execute: (input) => execute(input, 'youtube') },
        { type: 'tiktok.direct-post', execute: (input) => execute(input, 'tiktok') },
      ],
      {
        accountConcurrency: 1,
        concurrency: 3,
        platformConcurrency: 2,
        leaseDurationMs: 1_000,
        pollIntervalMs: 25,
      },
    );

    await runner.runOnce();
    await runner.runOnce();

    expect(maximumGlobal).toBe(3);
    expect(maximumYouTube).toBe(2);
    expect(maximumYouTubeA).toBe(1);
    expect(service.list().every((job) => job.status === 'succeeded')).toBe(true);
    expect(service.list().find((job) => job.type === 'youtube.upload')).toMatchObject({
      platformId: 'youtube',
    });
  });

  it('retries only classified failures with exponential backoff foundations', async () => {
    temporary = createTemporaryDatabase();
    const repository = new SqliteJobRepository(temporary.database);
    let now = new Date('2026-01-01T00:00:00.000Z');
    const service = new JobService(repository, () => now);
    const created = service.create({ type: 'fake.retry', input: {}, maxAttempts: 2 }).job;
    let executions = 0;
    const handler: JobHandler = {
      type: 'fake.retry',
      execute: async () => {
        executions += 1;
        if (executions === 1)
          throw new JobExecutionError('FAKE_TRANSIENT', true, 'Temporary fake failure.');
      },
    };
    const runner = new JobRunner(repository, [handler], {
      baseRetryDelayMs: 100,
      concurrency: 1,
      leaseDurationMs: 1_000,
      maxRetryDelayMs: 1_000,
      now: () => now,
      pollIntervalMs: 25,
      random: () => 0,
    });

    await runner.runOnce();
    expect(service.show(created.id)?.job).toMatchObject({
      status: 'retrying',
      lastErrorCode: 'FAKE_TRANSIENT',
    });
    now = new Date(now.getTime() + 50);
    await runner.runOnce();

    const details = service.show(created.id);
    expect(details?.job.status).toBe('succeeded');
    expect(details?.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'succeeded']);
    expect(details?.attempts[0]).toMatchObject({ retryable: true, errorCode: 'FAKE_TRANSIENT' });
  });

  it('persists Retry-After cooldowns that block other work on the same platform', async () => {
    temporary = createTemporaryDatabase();
    const repository = new SqliteJobRepository(temporary.database);
    let now = new Date('2026-01-01T00:00:00.000Z');
    const service = new JobService(repository, () => now);
    service.create({
      type: 'youtube.upload',
      input: { accountId: 'account-a', mediaId: 'media-a' },
      maxAttempts: 2,
    });
    service.create({
      type: 'youtube.upload',
      input: { accountId: 'account-b', mediaId: 'media-b' },
    });
    const executions: string[] = [];
    let firstAccount: string | undefined;
    const runner = new JobRunner(
      repository,
      [
        {
          type: 'youtube.upload',
          execute: async (input) => {
            const accountId = (input as { accountId: string }).accountId;
            executions.push(accountId);
            if (executions.length === 1) {
              firstAccount = accountId;
              throw new JobExecutionError(
                'YOUTUBE_UPLOAD_RATE_LIMITED',
                true,
                'YouTube asked this client to wait.',
                1_000,
                'rate_limit',
              );
            }
          },
        },
      ],
      {
        baseRetryDelayMs: 0,
        concurrency: 1,
        leaseDurationMs: 1_000,
        maxRetryDelayMs: 0,
        now: () => now,
        pollIntervalMs: 25,
      },
    );

    await runner.runOnce();
    expect(
      service
        .list()
        .map((job) => job.status)
        .sort(),
    ).toEqual(['pending', 'retrying']);
    expect(
      temporary.database.client
        .prepare('SELECT platform_id, cooldown_until FROM job_platform_controls')
        .all(),
    ).toEqual([{ platform_id: 'youtube', cooldown_until: now.getTime() + 1_000 }]);
    now = new Date(now.getTime() + 999);
    await new JobRunner(repository, [{ type: 'youtube.upload', execute: async () => undefined }], {
      concurrency: 1,
      leaseDurationMs: 1_000,
      now: () => now,
      pollIntervalMs: 25,
    }).runOnce();
    expect(service.list().filter((job) => job.status === 'pending')).toHaveLength(1);

    now = new Date(now.getTime() + 1);
    await runner.runOnce();
    expect(executions).toHaveLength(2);
    expect(new Set(executions)).toEqual(new Set(['account-a', 'account-b']));
    expect(firstAccount).toBeDefined();
  });

  it('pauses an account after repeated auth failures until it is manually resumed', async () => {
    temporary = createTemporaryDatabase();
    const repository = new SqliteJobRepository(temporary.database);
    const service = new JobService(repository);
    const failed = service.create({
      type: 'youtube.upload',
      input: { accountId: 'auth-account', mediaId: 'media-auth' },
      maxAttempts: 1,
    }).job;
    let executions = 0;
    const runner = new JobRunner(
      repository,
      [
        {
          type: 'youtube.upload',
          execute: async () => {
            executions += 1;
            if (executions <= 3)
              throw new JobExecutionError(
                'YOUTUBE_TOKEN_EXPIRED',
                false,
                'Reconnect the YouTube account.',
              );
          },
        },
      ],
      { authFailureThreshold: 3, concurrency: 1, leaseDurationMs: 1_000, pollIntervalMs: 25 },
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) expect(service.retry(failed.id)?.status).toBe('pending');
      await runner.runOnce();
    }
    expect(service.accountControl('youtube', 'auth-account')).toMatchObject({
      authFailureCount: 3,
      pauseReason: 'YOUTUBE_TOKEN_EXPIRED',
      status: 'paused',
    });
    expect(service.retry(failed.id)?.status).toBe('pending');
    await runner.runOnce();
    expect(executions).toBe(3);

    service.resumeAccount('youtube', 'auth-account');
    await runner.runOnce();
    expect(executions).toBe(4);
    expect(service.show(failed.id)?.job.status).toBe('succeeded');
  });

  it('persists queue pause/resume and drains active work before returning', async () => {
    temporary = createTemporaryDatabase();
    const repository = new SqliteJobRepository(temporary.database);
    const service = new JobService(repository);
    service.create({ type: 'fake.queue-control', input: {} });
    let executions = 0;
    const began = deferred();
    const release = deferred();
    const runner = new JobRunner(
      repository,
      [
        {
          type: 'fake.queue-control',
          execute: async () => {
            executions += 1;
            began.resolve();
            await release.promise;
          },
        },
      ],
      { concurrency: 1, leaseDurationMs: 1_000, pollIntervalMs: 25 },
    );

    expect(service.pauseQueue().mode).toBe('paused');
    expect(new JobService(new SqliteJobRepository(temporary.database)).queueState().mode).toBe(
      'paused',
    );
    await runner.runOnce();
    expect(executions).toBe(0);
    service.resumeQueue();
    const running = runner.runOnce();
    await began.promise;
    let drained = false;
    const draining = runner.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(service.queueState().mode).toBe('draining');
    release.resolve();
    await Promise.all([running, draining]);
    expect(drained).toBe(true);
  });

  it('recovers an expired lease without losing attempt history', async () => {
    temporary = createTemporaryDatabase();
    const repository = new SqliteJobRepository(temporary.database);
    const start = new Date('2026-01-01T00:00:00.000Z');
    const service = new JobService(repository, () => start);
    const created = service.create({ type: 'fake.recover', input: {}, maxAttempts: 2 }).job;
    repository.claimNext(['fake.recover'], 'stopped-worker', start, new Date(start.getTime() + 50));

    const recoveredAt = new Date(start.getTime() + 51);
    expect(repository.recoverExpiredLeases(recoveredAt)).toBe(1);
    expect(service.show(created.id)?.job.status).toBe('retrying');
    expect(service.show(created.id)?.attempts[0]).toMatchObject({
      status: 'failed',
      errorCode: 'LEASE_EXPIRED',
      retryable: true,
    });

    const runner = new JobRunner(
      repository,
      [{ type: 'fake.recover', execute: async () => undefined }],
      { concurrency: 1, leaseDurationMs: 1_000, now: () => recoveredAt, pollIntervalMs: 25 },
    );
    await runner.runOnce();
    expect(service.show(created.id)?.job.status).toBe('succeeded');
    expect(service.show(created.id)?.attempts).toHaveLength(2);
  });

  it('cooperatively cancels a running job and waits gracefully for active work', async () => {
    temporary = createTemporaryDatabase();
    const repository = new SqliteJobRepository(temporary.database);
    const service = new JobService(repository);
    const created = service.create({ type: 'fake.long', input: {} }).job;
    const began = deferred();
    const handler: JobHandler = {
      type: 'fake.long',
      execute: async (_input, context) => {
        began.resolve();
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      },
    };
    const runner = new JobRunner(repository, [handler], {
      concurrency: 1,
      leaseDurationMs: 30,
      pollIntervalMs: 10,
    });

    const running = runner.runOnce();
    await began.promise;
    expect(service.cancel(created.id)?.status).toBe('running');
    await running;

    expect(service.show(created.id)?.job.status).toBe('cancelled');
    expect(service.show(created.id)?.attempts).toMatchObject([{ status: 'cancelled' }]);
  });

  it('waits for an active handler during graceful shutdown', async () => {
    temporary = createTemporaryDatabase();
    const repository = new SqliteJobRepository(temporary.database);
    const service = new JobService(repository);
    service.create({ type: 'fake.shutdown', input: {} });
    const began = deferred();
    const release = deferred();
    const runner = new JobRunner(
      repository,
      [
        {
          type: 'fake.shutdown',
          execute: async () => {
            began.resolve();
            await release.promise;
          },
        },
      ],
      { concurrency: 1, leaseDurationMs: 1_000, pollIntervalMs: 25 },
    );

    runner.start();
    await began.promise;
    let stopped = false;
    const stopping = runner.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release.resolve();
    await stopping;

    expect(stopped).toBe(true);
    expect(service.list()[0]?.status).toBe('succeeded');
  });

  it('does not persist details from unclassified errors', async () => {
    temporary = createTemporaryDatabase();
    const repository = new SqliteJobRepository(temporary.database);
    const service = new JobService(repository);
    const created = service.create({ type: 'fake.secret', input: {} }).job;
    const runner = new JobRunner(
      repository,
      [
        {
          type: 'fake.secret',
          execute: async () => {
            throw new Error('Authorization: Bearer should-never-be-persisted');
          },
        },
      ],
      { concurrency: 1, leaseDurationMs: 1_000, pollIntervalMs: 25 },
    );

    await runner.runOnce();

    expect(service.show(created.id)?.job).toMatchObject({
      status: 'failed',
      lastErrorCode: 'UNEXPECTED_JOB_ERROR',
      lastErrorMessage: 'Job execution failed.',
    });
    expect(JSON.stringify(service.show(created.id))).not.toContain('should-never-be-persisted');
  });

  it('exposes job history and cancellation through protected HTTP routes', async () => {
    temporary = createTemporaryDatabase();
    const repository = new SqliteJobRepository(temporary.database);
    const service = new JobService(repository);
    const job = service.create({ type: 'fake.http', input: { source: 'test' } }).job;
    const mediaRepository = new SqliteMediaRepository(temporary.database);
    mediaRepository.create({
      id: 'media-http-transform',
      path: 'C:\\Media\\http-transform.mp4',
      fingerprint: 'sha256:http-transform',
      sizeBytes: 100,
      modifiedAt: new Date(0),
      createdAt: new Date(0),
      state: 'available',
      metadata: { hasAudio: true },
    });
    const derivativeRepository = new SqliteTransformDerivativeRepository(temporary.database);
    const transformService = new TransformService(mediaRepository, derivativeRepository, service, {
      encoder: 'libx264',
      ffmpegVersion: 'test-ffmpeg',
    });
    const transform = transformService.run('media-http-transform', {
      user: { steps: [{ type: 'fit', mode: 'crop', width: 1080, height: 1920 }] },
    });
    const failed = service.create({ type: 'fake.failed', input: {} }).job;
    repository.claimNext(
      ['fake.failed'],
      'http-test-worker',
      new Date(),
      new Date(Date.now() + 1_000),
    );
    repository.fail(
      failed.id,
      'http-test-worker',
      { code: 'TEST_FAILURE', message: 'Safe test failure.', retryable: false },
      new Date(),
    );
    const config = testConfig(temporary.directory);
    server = buildServer({
      config,
      jobService: service,
      transformService,
      sessionKey: Buffer.alloc(32, 7),
      staticRoot: false,
    });
    const headers = { host: '127.0.0.1:3000' };

    const list = await server.inject({ method: 'GET', url: '/api/jobs', headers });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ jobs: Array<{ id: string }> }>().jobs).toContainEqual(
      expect.objectContaining({ id: job.id }),
    );
    expect(
      list
        .json<{ jobs: Array<{ id: string; transform?: { id: string } }> }>()
        .jobs.find((listed) => listed.id === transform.job?.id)?.transform,
    ).toMatchObject({ id: transform.derivative.id });

    const derivative = await server.inject({
      method: 'GET',
      url: `/api/transforms/${transform.derivative.id}`,
      headers,
    });
    expect(derivative.statusCode).toBe(200);
    expect(derivative.json<{ derivative: { id: string } }>().derivative.id).toBe(
      transform.derivative.id,
    );

    const session = await server.inject({ method: 'GET', url: '/api/session', headers });
    const { csrfToken } = session.json<{ csrfToken: string }>();
    const cancelled = await server.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/cancel`,
      headers: {
        ...headers,
        origin: config.appUrl.origin,
        cookie: String(session.headers['set-cookie']),
        'x-csrf-token': csrfToken,
      },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<{ job: { status: string } }>().job.status).toBe('cancelled');

    const mutationHeaders = {
      ...headers,
      origin: config.appUrl.origin,
      cookie: String(session.headers['set-cookie']),
      'x-csrf-token': csrfToken,
    };
    const transformCancelled = await server.inject({
      method: 'POST',
      url: `/api/jobs/${transform.job!.id}/cancel`,
      headers: mutationHeaders,
    });
    expect(transformCancelled.statusCode).toBe(200);
    expect(transformService.inspect(transform.derivative.id)?.status).toBe('cancelled');
    const retried = await server.inject({
      method: 'POST',
      url: `/api/jobs/${failed.id}/retry`,
      headers: mutationHeaders,
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json<{ job: { status: string } }>().job.status).toBe('pending');
    const paused = await server.inject({
      method: 'POST',
      url: '/api/jobs/queue/pause',
      headers: mutationHeaders,
    });
    expect(paused.json<{ queue: { mode: string } }>().queue.mode).toBe('paused');
    const queue = await server.inject({ method: 'GET', url: '/api/jobs/queue', headers });
    expect(queue.json<{ queue: { mode: string } }>().queue.mode).toBe('paused');
    const resumed = await server.inject({
      method: 'POST',
      url: '/api/jobs/queue/resume',
      headers: mutationHeaders,
    });
    expect(resumed.json<{ queue: { mode: string } }>().queue.mode).toBe('running');
  });

  it('supports JSON jobs list/show through the CLI without a running server', async () => {
    temporary = createTemporaryDatabase();
    const repository = new SqliteJobRepository(temporary.database);
    const created = new JobService(repository).create({ type: 'fake.cli', input: {} }).job;
    const databasePath = testConfig(temporary.directory).paths.databasePath;
    const environment: Environment = {
      APP_CONFIG_DIR: join(temporary.directory, 'config'),
      APP_DATA_DIR: temporary.directory,
      APP_TEMP_DIR: join(temporary.directory, 'temp'),
      DATABASE_URL: databasePath,
    };
    const output: string[] = [];

    await createCli({ environment, write: (value) => output.push(value) }).parseAsync([
      'node',
      'openrepurpose',
      'jobs',
      'list',
      '--json',
    ]);
    expect(JSON.parse(output.at(-1) ?? '[]')).toMatchObject([{ id: created.id }]);

    await createCli({ environment, write: (value) => output.push(value) }).parseAsync([
      'node',
      'openrepurpose',
      'jobs',
      'show',
      created.id,
      '--json',
    ]);
    expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({ job: { id: created.id } });
  });

  it('supports CLI retry and persistent queue pause/resume controls', async () => {
    temporary = createTemporaryDatabase();
    const repository = new SqliteJobRepository(temporary.database);
    const created = new JobService(repository).create({ type: 'fake.cli', input: {} }).job;
    const now = new Date();
    expect(
      repository.claimNext(['fake.cli'], 'cli-test-worker', now, new Date(now.getTime() + 1_000)),
    ).toBeDefined();
    repository.fail(
      created.id,
      'cli-test-worker',
      { code: 'TEST_FAILURE', message: 'Test failure', retryable: false },
      now,
    );
    const environment: Environment = {
      APP_CONFIG_DIR: join(temporary.directory, 'config'),
      APP_DATA_DIR: temporary.directory,
      APP_TEMP_DIR: join(temporary.directory, 'temp'),
      DATABASE_URL: testConfig(temporary.directory).paths.databasePath,
    };
    const output: string[] = [];

    await createCli({ environment, write: (value) => output.push(value) }).parseAsync([
      'node',
      'openrepurpose',
      'jobs',
      'retry',
      created.id,
      '--json',
    ]);
    expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({ id: created.id, status: 'pending' });

    await createCli({ environment, write: (value) => output.push(value) }).parseAsync([
      'node',
      'openrepurpose',
      'jobs',
      'pause',
      '--json',
    ]);
    expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({ mode: 'paused' });

    await createCli({ environment, write: (value) => output.push(value) }).parseAsync([
      'node',
      'openrepurpose',
      'jobs',
      'resume',
      '--json',
    ]);
    expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({ mode: 'running' });
  });
});
