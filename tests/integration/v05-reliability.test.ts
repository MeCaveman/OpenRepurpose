import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeClock,
  JobExecutionError,
  JobRunner,
  JobService,
  nextCronOccurrence,
  resolveOneTimeLocal,
  ScheduleService,
  SourcePollingRunner,
  WorkflowService,
  type JobHandler,
} from '@openrepurpose/core';
import {
  openDatabase,
  runMigrations,
  SqliteJobRepository,
  SqliteScheduleRepository,
  SqliteSourcePollingRepository,
  SqliteWorkflowRepository,
  type OpenRepurposeDatabase,
} from '@openrepurpose/db';
import {
  InMemorySecretStore,
  MockDestinationAdapter,
  MockSourceAdapter,
  createTemporaryDatabase,
  type TemporaryDatabase,
} from '@openrepurpose/testkit';
import {
  SourceRegistry,
  createRedactingLogger,
  type DestinationAdapter,
  type PublishRequest,
} from '@openrepurpose/platform-sdk';

const publishRequest: PublishRequest = {
  accountId: 'account-1',
  media: {
    id: 'media-1',
    kind: 'video',
    path: 'fixture-video.mp4',
    sizeBytes: 100,
  },
  metadata: { title: 'Reliability fixture' },
};

function destinationHandler(
  type: string,
  adapter: DestinationAdapter,
  afterPublish?: () => void,
): JobHandler {
  return {
    type,
    execute: async (_input, context) => {
      await adapter.publish(publishRequest, {
        idempotencyKey: context.idempotencyKey ?? context.jobId,
        logger: createRedactingLogger({ subsystem: 'v05-reliability', write: () => undefined }),
        secretStore: new InMemorySecretStore(),
        signal: context.signal,
      });
      afterPublish?.();
    },
  };
}

function occurrenceCount(database: OpenRepurposeDatabase): number {
  return (
    database.client.prepare('SELECT count(*) AS count FROM schedule_occurrences').get() as {
      count: number;
    }
  ).count;
}

function createScheduledSource(database: OpenRepurposeDatabase, clock: FakeClock): string {
  const sources = new SqliteSourcePollingRepository(database);
  const source = sources.createConnection({
    adapterId: 'mock-source',
    configuration: {},
    displayName: 'Scheduled source',
    externalSourceId: 'scheduled-channel',
    now: clock.now(),
  });
  new ScheduleService(new SqliteScheduleRepository(database), sources, clock).create({
    definition: { kind: 'once', requestedLocalTime: '2026-01-01T00:01' },
    timeZone: 'Etc/UTC',
    target: { kind: 'source_poll', version: 1, sourceConnectionId: source.id },
  });
  return source.id;
}

describe('v0.5 deterministic reliability', () => {
  let temporary: TemporaryDatabase | undefined;

  afterEach(() => temporary?.dispose());

  it('does not dispatch when restarted one second before due and dispatches exactly once at due', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-before-due-'));
    const databasePath = join(directory, 'openrepurpose.sqlite');
    let database = openDatabase(databasePath);
    const clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
    try {
      runMigrations(database);
      createScheduledSource(database, clock);
      database.close();

      clock.set(new Date('2026-01-01T00:00:59.000Z'));
      database = openDatabase(databasePath);
      runMigrations(database);
      const sourcesBefore = new SqliteSourcePollingRepository(database);
      await new ScheduleService(
        new SqliteScheduleRepository(database),
        sourcesBefore,
        clock,
      ).runOnce();
      expect(occurrenceCount(database)).toBe(0);
      database.close();

      clock.advance(1_000);
      database = openDatabase(databasePath);
      runMigrations(database);
      const sourcesAtDue = new SqliteSourcePollingRepository(database);
      const schedulesAtDue = new SqliteScheduleRepository(database);
      await new ScheduleService(schedulesAtDue, sourcesAtDue, clock).runOnce();
      await new ScheduleService(schedulesAtDue, sourcesAtDue, clock).runOnce();
      expect(occurrenceCount(database)).toBe(1);
      expect(sourcesAtDue.listDue(clock.now())).toHaveLength(1);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('catches up exactly once when restarted one second after due', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-after-due-'));
    const databasePath = join(directory, 'openrepurpose.sqlite');
    let database = openDatabase(databasePath);
    const clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
    try {
      runMigrations(database);
      createScheduledSource(database, clock);
      database.close();

      clock.set(new Date('2026-01-01T00:01:01.000Z'));
      database = openDatabase(databasePath);
      runMigrations(database);
      const sources = new SqliteSourcePollingRepository(database);
      await new ScheduleService(new SqliteScheduleRepository(database), sources, clock).runOnce();
      expect(occurrenceCount(database)).toBe(1);
      database.close();

      database = openDatabase(databasePath);
      runMigrations(database);
      await new ScheduleService(
        new SqliteScheduleRepository(database),
        new SqliteSourcePollingRepository(database),
        clock,
      ).runOnce();
      expect(occurrenceCount(database)).toBe(1);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('rejects a DST spring-forward gap and skips it for recurring schedules', () => {
    expect(() => resolveOneTimeLocal('2026-03-08T02:30', 'America/New_York')).toThrow(
      'does not exist',
    );
    expect(
      nextCronOccurrence('30 2 * * *', 'America/New_York', new Date('2026-03-07T07:30:00.000Z')),
    ).toEqual(new Date('2026-03-09T06:30:00.000Z'));
  });

  it('chooses the earlier DST fall-back instant and runs a recurring overlap once', () => {
    expect(resolveOneTimeLocal('2026-11-01T01:30', 'America/New_York')).toEqual(
      new Date('2026-11-01T05:30:00.000Z'),
    );
    const first = nextCronOccurrence(
      '30 1 * * *',
      'America/New_York',
      new Date('2026-11-01T04:00:00.000Z'),
    );
    expect(first).toEqual(new Date('2026-11-01T05:30:00.000Z'));
    expect(nextCronOccurrence('30 1 * * *', 'America/New_York', first)).toEqual(
      new Date('2026-11-02T06:30:00.000Z'),
    );
  });

  it('honors remote 429 Retry-After without calling the adapter during cooldown', async () => {
    temporary = createTemporaryDatabase();
    const clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
    const repository = new SqliteJobRepository(temporary.database);
    const jobs = new JobService(repository, () => clock.now());
    jobs.create({
      type: 'mock.publish',
      input: {},
      maxAttempts: 2,
      platformId: 'mock-platform',
      accountId: 'account-a',
    });
    jobs.create({
      type: 'mock.publish',
      input: {},
      platformId: 'mock-platform',
      accountId: 'account-b',
    });
    const adapter = new MockDestinationAdapter({ id: 'mock-platform' });
    const handler = destinationHandler('mock.publish', adapter, () => {
      if (adapter.publishCalls.length === 1)
        throw new JobExecutionError(
          'REMOTE_RATE_LIMITED',
          true,
          'The remote API asked this client to wait.',
          30_000,
          'rate_limit',
        );
    });
    const runner = new JobRunner(repository, [handler], {
      baseRetryDelayMs: 0,
      concurrency: 1,
      leaseDurationMs: 1_000,
      maxRetryDelayMs: 0,
      now: () => clock.now(),
      pollIntervalMs: 25,
      random: () => 0,
    });

    await runner.runOnce();
    expect(adapter.publishCalls).toHaveLength(1);
    clock.advance(29_999);
    await runner.runOnce();
    expect(adapter.publishCalls).toHaveLength(1);
    clock.advance(1);
    await runner.runOnce();
    await runner.runOnce();
    expect(adapter.publishCalls).toHaveLength(3);
    expect(jobs.list().every((job) => job.status === 'succeeded')).toBe(true);
  });

  it('pauses one account after repeated adapter auth failures until manual resume', async () => {
    temporary = createTemporaryDatabase();
    const clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
    const repository = new SqliteJobRepository(temporary.database);
    const jobs = new JobService(repository, () => clock.now());
    for (let index = 0; index < 4; index += 1)
      jobs.create({
        type: 'mock.auth-publish',
        input: { index },
        maxAttempts: 1,
        platformId: 'mock-platform',
        accountId: 'auth-account',
      });
    const adapter = new MockDestinationAdapter({ id: 'mock-platform' });
    let authorized = false;
    const handler = destinationHandler('mock.auth-publish', adapter, () => {
      if (!authorized)
        throw new JobExecutionError(
          'REMOTE_TOKEN_EXPIRED',
          false,
          'Reconnect the destination account.',
          undefined,
          'authentication',
        );
    });
    const runner = new JobRunner(repository, [handler], {
      authFailureThreshold: 3,
      concurrency: 1,
      leaseDurationMs: 1_000,
      now: () => clock.now(),
      pollIntervalMs: 25,
    });

    await runner.runOnce();
    await runner.runOnce();
    await runner.runOnce();
    expect(jobs.accountControl('mock-platform', 'auth-account')).toMatchObject({
      authFailureCount: 3,
      status: 'paused',
    });
    await runner.runOnce();
    expect(adapter.publishCalls).toHaveLength(3);

    authorized = true;
    jobs.resumeAccount('mock-platform', 'auth-account');
    await runner.runOnce();
    expect(adapter.publishCalls).toHaveLength(4);
    expect(jobs.list().filter((job) => job.status === 'pending')).toHaveLength(0);
  });

  it('manually retries only the failed workflow destination', async () => {
    temporary = createTemporaryDatabase();
    const repository = new SqliteJobRepository(temporary.database);
    const jobs = new JobService(repository);
    const workflows = new WorkflowService(new SqliteWorkflowRepository(temporary.database), jobs);
    const workflow = workflows.create({
      name: 'Destination retry',
      sourceDirectory: temporary.directory,
      titleTemplate: '{{file.stem}}',
      destinations: [
        { destinationId: 'youtube', accountId: 'youtube-account', privacy: 'private' },
        { destinationId: 'facebook', accountId: 'facebook-page' },
      ],
    });
    workflows.executeWatchedMedia(workflow.id, {
      id: 'media-1',
      path: join(temporary.directory, 'clip.mp4'),
      fingerprint: 'sha256:clip',
      sizeBytes: 100,
      modifiedAt: new Date(0),
      createdAt: new Date(0),
      state: 'available',
      metadata: { hasAudio: true },
    });
    const youtube = new MockDestinationAdapter({ id: 'youtube' });
    const facebook = new MockDestinationAdapter({ id: 'facebook' });
    const runner = new JobRunner(
      repository,
      [
        destinationHandler('youtube.upload', youtube),
        destinationHandler('facebook.reels.publish', facebook, () => {
          if (facebook.publishCalls.length === 1)
            throw new JobExecutionError(
              'FACEBOOK_REMOTE_FAILURE',
              false,
              'Facebook rejected the first publish attempt.',
            );
        }),
      ],
      { concurrency: 2 },
    );

    await runner.runOnce();
    const failed = jobs.list().find((job) => job.type === 'facebook.reels.publish');
    expect(failed?.status).toBe('failed');
    expect(jobs.retry(failed!.id)?.status).toBe('pending');
    await runner.runOnce();

    expect(youtube.publishCalls).toHaveLength(1);
    expect(facebook.publishCalls).toHaveLength(2);
    expect(jobs.list().every((job) => job.status === 'succeeded')).toBe(true);
  });

  it('runs a source poll and publish due at the same fake-clock instant once each', async () => {
    temporary = createTemporaryDatabase();
    const clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
    const sources = new SqliteSourcePollingRepository(temporary.database);
    const source = sources.createConnection({
      adapterId: 'mock-source',
      configuration: {},
      displayName: 'Simultaneous source',
      externalSourceId: 'simultaneous-channel',
      now: clock.now(),
    });
    const schedules = new ScheduleService(
      new SqliteScheduleRepository(temporary.database),
      sources,
      clock,
    );
    schedules.create({
      definition: { kind: 'once', requestedLocalTime: '2026-01-01T00:01' },
      timeZone: 'Etc/UTC',
      target: { kind: 'source_poll', version: 1, sourceConnectionId: source.id },
    });
    const jobsRepository = new SqliteJobRepository(temporary.database);
    const jobs = new JobService(jobsRepository, () => clock.now());
    jobs.create({
      type: 'mock.simultaneous-publish',
      input: {},
      availableAt: new Date('2026-01-01T00:01:00.000Z'),
      platformId: 'mock-platform',
      accountId: 'account-1',
    });
    const sourceAdapter = new MockSourceAdapter({
      pollResults: [{ cursor: 'cursor-1', hasMore: false, items: [] }],
    });
    const destinationAdapter = new MockDestinationAdapter({ id: 'mock-platform' });
    const sourceRunner = new SourcePollingRunner(
      sources,
      new SourceRegistry([sourceAdapter]),
      jobs,
      {
        now: () => clock.now(),
        random: () => 0,
        intervalMs: 60_000,
        pollIntervalMs: 25,
        sourceContext: {
          logger: createRedactingLogger({
            subsystem: 'v05-simultaneous-source',
            write: () => undefined,
          }),
          secretStore: new InMemorySecretStore(),
        },
      },
    );
    const publishRunner = new JobRunner(
      jobsRepository,
      [destinationHandler('mock.simultaneous-publish', destinationAdapter)],
      {
        concurrency: 1,
        leaseDurationMs: 1_000,
        now: () => clock.now(),
        pollIntervalMs: 25,
      },
    );

    clock.set(new Date('2026-01-01T00:01:00.000Z'));
    await schedules.runOnce();
    await Promise.all([sourceRunner.runOnce(), publishRunner.runOnce()]);
    await schedules.runOnce();
    await Promise.all([sourceRunner.runOnce(), publishRunner.runOnce()]);

    expect(sourceAdapter.pollCalls).toHaveLength(1);
    expect(destinationAdapter.publishCalls).toHaveLength(1);
    expect(occurrenceCount(temporary.database)).toBe(1);
  });
});
