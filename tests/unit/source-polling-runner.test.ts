import { afterEach, describe, expect, it } from 'vitest';
import { JobService, SourcePollingRunner, type SourceConnection } from '@openrepurpose/core';
import { SqliteJobRepository, SqliteSourcePollingRepository } from '@openrepurpose/db';
import {
  PlatformError,
  SourceRegistry,
  createRedactingLogger,
  type SourceAdapter,
} from '@openrepurpose/platform-sdk';
import {
  createTemporaryDatabase,
  InMemorySecretStore,
  MockSourceAdapter,
} from '@openrepurpose/testkit';
import type { TemporaryDatabase } from '@openrepurpose/testkit';

describe('source polling runner', () => {
  let temporary: TemporaryDatabase | undefined;
  afterEach(() => temporary?.dispose());

  it('persists observations and a normal handoff job before advancing the source cursor', async () => {
    temporary = createTemporaryDatabase();
    const database = temporary.database;
    insertConnection(database.client, 'source-1');
    const now = 1_000;
    const jobs = new JobService(new SqliteJobRepository(database), () => new Date(now));
    const runner = createRunner(
      new SqliteSourcePollingRepository(database),
      new SourceRegistry([new MockSourceAdapter()]),
      jobs,
      () => new Date(now),
    );

    await runner.runOnce();

    const item = database.client
      .prepare(
        `SELECT external_id, lifecycle_status, resolution_status, metadata_json,
         media_descriptor_json FROM source_items`,
      )
      .get() as {
      external_id: string;
      lifecycle_status: string;
      resolution_status: string;
      metadata_json: string;
      media_descriptor_json: string;
    };
    expect(item).toEqual({
      external_id: 'item-1',
      lifecycle_status: 'observed',
      resolution_status: 'unresolved',
      metadata_json: '{"title":"First item"}',
      media_descriptor_json:
        '{"availability":"available","resolutionStrategies":["local_original","official_download"],"rightsRequirement":"connection_authorization"}',
    });
    expect(jobs.list()).toHaveLength(1);
    expect(jobs.list()[0]).toMatchObject({
      type: 'source.item.observed',
      input: { sourceConnectionId: 'source-1' },
    });
    expect(
      database.client
        .prepare('SELECT cursor_json, last_successful_poll_at FROM source_connections WHERE id = ?')
        .get('source-1'),
    ).toMatchObject({
      cursor_json: 'cursor-1',
      last_successful_poll_at: now,
    });
  });

  it('dedupes a repeated page after restart while updating its observation history', async () => {
    temporary = createTemporaryDatabase();
    const database = temporary.database;
    insertConnection(database.client, 'source-1');
    let now = 1_000;
    const repository = new SqliteSourcePollingRepository(database);
    const jobs = new JobService(new SqliteJobRepository(database), () => new Date(now));
    const registry = new SourceRegistry([new MockSourceAdapter()]);
    await createRunner(repository, registry, jobs, () => new Date(now)).runOnce();
    now += 5_000;
    database.client
      .prepare('UPDATE source_connections SET next_poll_at = NULL WHERE id = ?')
      .run('source-1');

    await createRunner(repository, registry, jobs, () => new Date(now)).runOnce();

    expect(database.client.prepare('SELECT COUNT(*) AS count FROM source_items').get()).toEqual({
      count: 1,
    });
    expect(jobs.list()).toHaveLength(1);
    expect(
      database.client.prepare('SELECT first_observed_at, last_observed_at FROM source_items').get(),
    ).toEqual({
      first_observed_at: 1_000,
      last_observed_at: 6_000,
    });
  });

  it('persists poll errors and pauses a source after repeated authentication failures', async () => {
    temporary = createTemporaryDatabase();
    const database = temporary.database;
    insertConnection(database.client, 'source-1');
    let now = 1_000;
    const failingAdapter: SourceAdapter = {
      id: 'mock-source',
      displayName: 'Failing source',
      capabilities: async () => ({ eventIds: false, mediaResolution: [], polling: true }),
      poll: async () => {
        throw new PlatformError({
          category: 'authentication',
          code: 'SOURCE_TOKEN_EXPIRED',
          publicMessage: 'The source needs to be reconnected.',
          retryable: false,
        });
      },
    };
    const repository = new SqliteSourcePollingRepository(database);
    const jobs = new JobService(new SqliteJobRepository(database), () => new Date(now));
    const runner = createRunner(
      repository,
      new SourceRegistry([failingAdapter]),
      jobs,
      () => new Date(now),
      2,
    );

    await runner.runOnce();
    now += 1_000;
    database.client
      .prepare('UPDATE source_connections SET next_poll_at = NULL WHERE id = ?')
      .run('source-1');
    await runner.runOnce();

    expect(
      database.client
        .prepare(
          'SELECT status, consecutive_poll_failures, last_poll_error_code, next_poll_at FROM source_connections WHERE id = ?',
        )
        .get('source-1'),
    ).toEqual({
      status: 'authorization_failed',
      consecutive_poll_failures: 2,
      last_poll_error_code: 'SOURCE_TOKEN_EXPIRED',
      next_poll_at: null,
    });
  });
});

function createRunner(
  repository: SqliteSourcePollingRepository,
  registry: SourceRegistry,
  jobs: JobService,
  now: () => Date,
  authFailurePauseThreshold = 3,
): SourcePollingRunner {
  return new SourcePollingRunner(repository, registry, jobs, {
    now,
    random: () => 0,
    intervalMs: 60_000,
    pollIntervalMs: 25,
    authFailurePauseThreshold,
    sourceContext: {
      logger: createRedactingLogger({ subsystem: 'source-poll-test', write: () => undefined }),
      secretStore: new InMemorySecretStore(),
    },
  });
}

function insertConnection(
  client: TemporaryDatabase['database']['client'],
  id: string,
): SourceConnection {
  const connection: SourceConnection = {
    id,
    adapterId: 'mock-source',
    externalSourceId: 'channel-1',
    displayName: 'Channel one',
    configuration: {},
    cursor: null,
    status: 'active',
    consecutivePollFailures: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  client
    .prepare(
      `INSERT INTO source_connections (
        id, adapter_id, account_id, external_source_id, display_name, configuration_json, status,
        cursor_json, watermark_published_at, watermark_external_id, last_poll_at,
        last_successful_poll_at, last_poll_error_code, last_poll_error_message,
        consecutive_poll_failures, next_poll_at, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, ?, ?)`,
    )
    .run(
      connection.id,
      connection.adapterId,
      connection.externalSourceId,
      connection.displayName,
      JSON.stringify(connection.configuration),
      connection.status,
      connection.createdAt.getTime(),
      connection.updatedAt.getTime(),
    );
  return connection;
}
