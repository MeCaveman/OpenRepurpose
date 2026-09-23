import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiIdempotencyService,
  ApiTokenService,
  JobRunner,
  JobService,
  WebhookService,
  type JsonValue,
} from '@openrepurpose/core';
import {
  migrations,
  openDatabase,
  runMigrations,
  SqliteApiIdempotencyRepository,
  SqliteApiTokenRepository,
  SqliteDestinationJobRepository,
  SqliteJobRepository,
  SqliteMediaRepository,
  SqliteWebhookRepository,
  type OpenRepurposeDatabase,
} from '@openrepurpose/db';
import { buildServer, createMcpServer } from '@openrepurpose/server';
import { InMemorySecretStore } from '@openrepurpose/testkit';
import type { ApplicationConfig } from '@openrepurpose/shared';
import { WebhookNetworkPolicy } from '../../apps/server/src/webhooks.js';

const config: ApplicationConfig = {
  appUrl: new URL('http://127.0.0.1:3000'),
  bindHost: '127.0.0.1',
  jobRunner: {
    accountConcurrency: 1,
    authFailureThreshold: 3,
    baseRetryDelayMs: 1_000,
    concurrency: 2,
    leaseDurationMs: 30_000,
    maxRetryDelayMs: 60_000,
    pollIntervalMs: 250,
    platformConcurrency: 2,
  },
  paths: {
    configDirectory: resolve('test-results/config'),
    dataDirectory: resolve('test-results/data'),
    databasePath: resolve('test-results/data/openrepurpose.sqlite'),
    secretKeyPath: resolve('test-results/config/secret-vault.key'),
    secretVaultPath: resolve('test-results/data/secrets.vault.json'),
    sessionKeyPath: resolve('test-results/config/session.key'),
    temporaryDirectory: resolve('test-results/temp'),
    transcriptionModelDirectory: resolve('test-results/data/models/whisper-cpp'),
  },
  port: 3000,
  transformRunner: { killGraceMs: 5_000, stallTimeoutMs: 300_000, timeoutMs: 21_600_000 },
};

const host = { host: '127.0.0.1:3000' };

function createApiRuntime(database: OpenRepurposeDatabase) {
  const jobs = new JobService(new SqliteJobRepository(database));
  const media = new SqliteMediaRepository(database);
  const tokens = new ApiTokenService(new SqliteApiTokenRepository(database));
  const server = buildServer({
    apiIdempotencyService: new ApiIdempotencyService(new SqliteApiIdempotencyRepository(database)),
    apiTokenService: tokens,
    config,
    destinationJobRepository: new SqliteDestinationJobRepository(database),
    jobService: jobs,
    mediaRepository: media,
    sessionKey: Buffer.alloc(32, 7),
    staticRoot: false,
  });
  return { jobs, media, server, tokens };
}

function bearer(token: string) {
  return { ...host, authorization: `Bearer ${token}` };
}

function toolText(response: Awaited<ReturnType<ReturnType<typeof createMcpServer>['handle']>>) {
  const result = response?.result as { content?: readonly { text?: string }[] } | undefined;
  const text = result?.content?.[0]?.text;
  if (text === undefined) throw new Error('MCP tool response did not contain text.');
  return JSON.parse(text) as unknown;
}

describe('v0.9 API and MCP end-to-end acceptance', () => {
  const cleanup: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const dispose of cleanup.reverse()) await dispose();
    cleanup.length = 0;
  });

  it('upgrades v0.8 and preserves API authorization, idempotency, cancellation, and state across restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-v09-e2e-'));
    cleanup.push(() => rmSync(directory, { force: true, maxRetries: 3, recursive: true }));
    const databasePath = join(directory, 'openrepurpose.sqlite');
    let database = openDatabase(databasePath);
    cleanup.push(() => database.close());

    runMigrations(database, migrations.slice(0, 24));
    const v08Media = new SqliteMediaRepository(database);
    v08Media.create({
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      fingerprint: 'sha256:v09-e2e',
      id: 'media-v09',
      metadata: { hasAudio: true },
      modifiedAt: new Date('2026-09-01T00:00:00.000Z'),
      path: join(directory, 'private', 'source.mp4'),
      sizeBytes: 42,
      state: 'available',
    });
    runMigrations(database);
    expect(
      database.client
        .prepare('SELECT id FROM __openrepurpose_migrations ORDER BY id DESC LIMIT 2')
        .all(),
    ).toEqual([{ id: '0026_webhooks' }, { id: '0025_api_v1' }]);

    let runtime = createApiRuntime(database);
    cleanup.push(() => runtime.server.close());
    const activeToken = runtime.tokens.create('Packet 7 client', ['control']).token;
    const revokedToken = runtime.tokens.create('Revoked client', ['read']).token;

    const unauthorized = await runtime.server.inject({
      method: 'GET',
      url: '/api/v1/jobs',
      headers: host,
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toMatchObject({ error: { code: 'AUTHENTICATION_REQUIRED' } });

    const crossOrigin = await runtime.server.inject({
      method: 'POST',
      url: '/api/v1/publish',
      headers: { ...host, origin: 'http://malicious-local-page.test' },
      payload: {},
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json()).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });

    const maliciousPath = await runtime.server.inject({
      method: 'GET',
      url: '/api/v1/jobs/..%5C..%5Csecrets.vault.json',
      headers: bearer(activeToken),
    });
    expect(maliciousPath.statusCode).toBe(400);
    expect(maliciousPath.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });

    const publishPayload = {
      accountId: 'account-v09',
      mediaId: 'media-v09',
      metadata: { privacy: 'private', title: 'Packet 7 publish' },
      platform: 'youtube',
    };
    const firstPublish = await runtime.server.inject({
      method: 'POST',
      url: '/api/v1/publish',
      headers: { ...bearer(activeToken), 'idempotency-key': 'packet-7-publish' },
      payload: publishPayload,
    });
    const replay = await runtime.server.inject({
      method: 'POST',
      url: '/api/v1/publish',
      headers: { ...bearer(activeToken), 'idempotency-key': 'packet-7-publish' },
      payload: publishPayload,
    });
    expect(firstPublish.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(firstPublish.json());
    expect(runtime.jobs.list()).toHaveLength(1);

    let handlerStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      handlerStarted = resolveStarted;
    });
    const runner = new JobRunner(
      new SqliteJobRepository(database),
      [
        {
          type: 'youtube.upload',
          execute: async (_input, context) => {
            handlerStarted();
            await new Promise<void>((resolveAbort, reject) => {
              const timeout = setTimeout(
                () => reject(new Error('Cancellation did not reach the destination handler.')),
                1_000,
              );
              context.signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(timeout);
                  resolveAbort();
                },
                { once: true },
              );
            });
          },
        },
      ],
      { concurrency: 1, leaseDurationMs: 30, pollIntervalMs: 10 },
    );
    const execution = runner.runOnce();
    await started;
    const jobId = firstPublish.json<{ job: { id: string } }>().job.id;
    const cancellation = await runtime.server.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/cancel`,
      headers: bearer(activeToken),
    });
    expect(cancellation.statusCode).toBe(200);
    await execution;
    expect(runtime.jobs.show(jobId)?.job.status).toBe('cancelled');

    const revokedId = runtime.tokens.authenticate(revokedToken)?.id;
    expect(revokedId).toBeDefined();
    runtime.tokens.revoke(revokedId!);
    const revoked = await runtime.server.inject({
      method: 'GET',
      url: '/api/v1/jobs',
      headers: bearer(revokedToken),
    });
    expect(revoked.statusCode).toBe(401);

    await runtime.server.close();
    database.close();
    database = openDatabase(databasePath);
    runMigrations(database);
    runtime = createApiRuntime(database);

    const replayAfterRestart = await runtime.server.inject({
      method: 'POST',
      url: '/api/v1/publish',
      headers: { ...bearer(activeToken), 'idempotency-key': 'packet-7-publish' },
      payload: publishPayload,
    });
    expect(replayAfterRestart.statusCode).toBe(201);
    expect(replayAfterRestart.headers['idempotency-replayed']).toBe('true');
    expect(replayAfterRestart.json()).toEqual(firstPublish.json());
    expect(runtime.jobs.list()).toHaveLength(1);
    expect(runtime.jobs.show(jobId)?.job.status).toBe('cancelled');
    expect(runtime.media.findById('media-v09')).toBeDefined();
  });

  it('publishes through MCP to a mock destination and rejects path-like tool arguments', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-v09-mcp-'));
    cleanup.push(() => rmSync(directory, { force: true, maxRetries: 3, recursive: true }));
    const database = openDatabase(join(directory, 'openrepurpose.sqlite'));
    cleanup.push(() => database.close());
    runMigrations(database);
    const media = new SqliteMediaRepository(database);
    media.create({
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      fingerprint: 'sha256:mcp-e2e',
      id: 'media-mcp',
      metadata: { hasAudio: true },
      modifiedAt: new Date('2026-09-01T00:00:00.000Z'),
      path: join(directory, 'private', 'mcp-source.mp4'),
      sizeBytes: 84,
      state: 'available',
    });
    const repository = new SqliteJobRepository(database);
    const jobs = new JobService(repository);
    const mcp = createMcpServer({ jobService: jobs, mediaRepository: media });
    const publish = await mcp.handle({
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: {
          accountId: 'mock-account',
          idempotencyKey: 'mock-publish',
          mediaId: 'media-mcp',
          metadata: { privacy: 'unlisted', title: 'Mocked MCP publish' },
          platform: 'youtube',
        },
        name: 'publish_media',
      },
    });
    expect(toolText(publish)).toMatchObject({ created: true, job: { status: 'pending' } });

    const destination = vi.fn(async (input: JsonValue) => {
      expect(input).toEqual({
        accountId: 'mock-account',
        mediaId: 'media-mcp',
        metadata: { privacy: 'unlisted', title: 'Mocked MCP publish' },
      });
    });
    await new JobRunner(repository, [{ type: 'youtube.upload', execute: destination }], {
      concurrency: 1,
    }).runOnce();
    expect(destination).toHaveBeenCalledOnce();

    const createdJob = jobs.list()[0]!;
    const job = await mcp.handle({
      id: 2,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { jobId: createdJob.id }, name: 'get_job' },
    });
    expect(toolText(job)).toMatchObject({ job: { id: createdJob.id, status: 'succeeded' } });

    const maliciousPath = await mcp.handle({
      id: 3,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: {
          accountId: 'mock-account',
          idempotencyKey: 'malicious-path',
          mediaId: '../../private/source.mp4',
          metadata: { privacy: 'private', title: 'Rejected' },
          platform: 'youtube',
        },
        name: 'publish_media',
      },
    });
    expect(toolText(maliciousPath)).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(jobs.list()).toHaveLength(1);
  });

  it('blocks metadata and link-local webhook destinations before persisting them', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-v09-webhook-'));
    cleanup.push(() => rmSync(directory, { force: true, maxRetries: 3, recursive: true }));
    const database = openDatabase(join(directory, 'openrepurpose.sqlite'));
    cleanup.push(() => database.close());
    runMigrations(database);
    const repository = new SqliteWebhookRepository(database);
    const secrets = new InMemorySecretStore();
    const service = new WebhookService(
      repository,
      new JobService(new SqliteJobRepository(database)),
      secrets,
      new WebhookNetworkPolicy(),
      2,
    );

    for (const [id, url] of [
      ['metadata', new URL('http://169.254.169.254/latest/meta-data/')],
      ['link-local', new URL('http://[fe80::1]/events')],
    ] as const) {
      await expect(
        service.configure([
          {
            events: ['job.failed'],
            id,
            name: `Blocked ${id}`,
            secret: 'packet-7-test-signing-secret',
            url,
          },
        ]),
      ).rejects.toMatchObject({ code: 'WEBHOOK_TARGET_BLOCKED', retryable: false });
    }
    expect(repository.listDestinations()).toEqual([]);
    expect(
      await secrets.get({
        name: 'signing-secret',
        ownerId: 'webhook:metadata',
        scope: 'application',
      }),
    ).toBeUndefined();
    expect(
      await secrets.get({
        name: 'signing-secret',
        ownerId: 'webhook:link-local',
        scope: 'application',
      }),
    ).toBeUndefined();
  });
});
