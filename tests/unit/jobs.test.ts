import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { JobExecutionError, JobRunner, JobService } from '@openrepurpose/core';
import type { JobHandler } from '@openrepurpose/core';
import { SqliteJobRepository } from '@openrepurpose/db';
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
      baseRetryDelayMs: 1,
      concurrency: 2,
      leaseDurationMs: 1_000,
      maxRetryDelayMs: 10,
      pollIntervalMs: 25,
    },
    paths: {
      configDirectory: join(directory, 'config'),
      dataDirectory: directory,
      databasePath: join(directory, 'openrepurpose.sqlite'),
      sessionKeyPath: join(directory, 'config', 'session.key'),
      temporaryDirectory: join(directory, 'temp'),
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
    const service = new JobService(new SqliteJobRepository(temporary.database));
    const job = service.create({ type: 'fake.http', input: { source: 'test' } }).job;
    const config = testConfig(temporary.directory);
    server = buildServer({
      config,
      jobService: service,
      sessionKey: Buffer.alloc(32, 7),
      staticRoot: false,
    });
    const headers = { host: '127.0.0.1:3000' };

    const list = await server.inject({ method: 'GET', url: '/api/jobs', headers });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ jobs: Array<{ id: string }> }>().jobs[0]?.id).toBe(job.id);

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
});
