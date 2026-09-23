import { afterEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer, createApiV1OpenApiDocument } from '@openrepurpose/server';
import { ApiIdempotencyService, ApiTokenService, JobService } from '@openrepurpose/core';
import {
  SqliteApiIdempotencyRepository,
  SqliteApiTokenRepository,
  SqliteDestinationJobRepository,
  SqliteJobRepository,
  SqliteMediaRepository,
} from '@openrepurpose/db';
import { createTemporaryDatabase, type TemporaryDatabase } from '@openrepurpose/testkit';
import type { ApplicationConfig } from '@openrepurpose/shared';

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

describe('API v1 boundary', () => {
  let server: FastifyInstance | undefined;
  let temporary: TemporaryDatabase | undefined;

  afterEach(async () => {
    await server?.close();
    temporary?.dispose();
  });

  function createServer() {
    temporary = createTemporaryDatabase();
    const media = new SqliteMediaRepository(temporary.database);
    const jobs = new JobService(new SqliteJobRepository(temporary.database));
    const destinations = new SqliteDestinationJobRepository(temporary.database);
    const tokens = new ApiTokenService(new SqliteApiTokenRepository(temporary.database));
    server = buildServer({
      apiIdempotencyService: new ApiIdempotencyService(
        new SqliteApiIdempotencyRepository(temporary.database),
      ),
      apiTokenService: tokens,
      config,
      destinationJobRepository: destinations,
      jobService: jobs,
      mediaRepository: media,
      sessionKey: Buffer.alloc(32, 9),
      staticRoot: false,
    });
    return { destinations, jobs, media, server, tokens };
  }

  async function browserHeaders(app: FastifyInstance) {
    const session = await app.inject({ method: 'GET', url: '/api/session', headers: host });
    const { csrfToken } = session.json<{ csrfToken: string }>();
    return {
      ...host,
      cookie: String(session.headers['set-cookie']),
      origin: config.appUrl.origin,
      'x-csrf-token': csrfToken,
    };
  }

  async function createToken(app: FastifyInstance, permissions: readonly ('control' | 'read')[]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/tokens',
      headers: await browserHeaders(app),
      payload: { name: 'Automation client', permissions },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ token: string }>().token;
  }

  it('publishes a generated OpenAPI 3.1 document from strict request schemas', async () => {
    const document = createApiV1OpenApiDocument() as {
      openapi: string;
      paths: Record<
        string,
        {
          post?: { requestBody?: { content: Record<string, { schema: Record<string, unknown> }> } };
        }
      >;
    };
    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths)).toContain('/publish');
    expect(
      document.paths['/auth/tokens']?.post?.requestBody?.content['application/json']?.schema,
    ).toMatchObject({ additionalProperties: false, type: 'object' });

    const { server: app } = createServer();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/openapi.json',
      headers: host,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ openapi: '3.1.0' });
  });

  it('requires authentication, separates read/control authority, and never lists token material', async () => {
    const { server: app } = createServer();
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/media', headers: host });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toMatchObject({
      error: { code: 'AUTHENTICATION_REQUIRED', requestId: expect.any(String) },
    });

    const readToken = await createToken(app, ['read']);
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/media',
      headers: { ...host, authorization: `Bearer ${readToken}` },
    });
    expect(listed.statusCode).toBe(200);

    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/publish',
      headers: {
        ...host,
        authorization: `Bearer ${readToken}`,
        'idempotency-key': 'publish-1',
      },
      payload: {
        platform: 'youtube',
        accountId: 'account-1',
        mediaId: 'media-1',
        metadata: { title: 'Title' },
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });

    const tokenList = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/tokens',
      headers: await browserHeaders(app),
    });
    expect(tokenList.statusCode).toBe(200);
    expect(tokenList.body).not.toContain(readToken);
    expect(tokenList.body).not.toContain('verifier');

    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/not-a-route',
      headers: { ...host, authorization: `Bearer ${readToken}` },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      error: { code: 'API_ROUTE_NOT_FOUND', requestId: expect.any(String) },
    });
  });

  it('stores only token verifiers and rejects revoked credentials', async () => {
    const { server: app } = createServer();
    const token = await createToken(app, ['control']);
    const row = temporary!.database.client.prepare('SELECT id, verifier FROM api_tokens').get() as {
      id: string;
      verifier: string;
    };
    expect(row.verifier).not.toContain(token);
    expect(row.verifier).toMatch(/^[a-f0-9]{64}$/u);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/tokens/${row.id}`,
      headers: await browserHeaders(app),
    });
    expect(revoked.statusCode).toBe(200);
    const rejected = await app.inject({
      method: 'GET',
      url: '/api/v1/media',
      headers: { ...host, authorization: `Bearer ${token}` },
    });
    expect(rejected.statusCode).toBe(401);
  });

  it('validates strictly, paginates, rejects malicious IDs, and replays publish creation safely', async () => {
    const { destinations, media, server: app } = createServer();
    for (const id of ['media-1', 'media-2'])
      media.create({
        createdAt: new Date('2026-01-01T00:00:00Z'),
        fingerprint: `fingerprint-${id}`,
        id,
        metadata: { hasAudio: true },
        modifiedAt: new Date('2026-01-01T00:00:00Z'),
        path: resolve(`test-results/${id}.mp4`),
        sizeBytes: 10,
        state: 'available',
      });
    const token = await createToken(app, ['control']);
    const authorization = { ...host, authorization: `Bearer ${token}` };
    const firstPage = await app.inject({
      method: 'GET',
      url: '/api/v1/media?limit=1',
      headers: authorization,
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json()).toMatchObject({
      data: [{ id: expect.any(String) }],
      page: { limit: 1, nextCursor: expect.any(String) },
    });
    expect(firstPage.body).not.toContain(resolve('test-results'));
    expect(firstPage.body).not.toContain('fingerprint-');

    const malicious = await app.inject({
      method: 'GET',
      url: '/api/v1/jobs/..%5Csecret',
      headers: authorization,
    });
    expect(malicious.statusCode).toBe(400);
    expect(malicious.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });

    const unknownField = await app.inject({
      method: 'POST',
      url: '/api/v1/publish',
      headers: { ...authorization, 'idempotency-key': 'publish-strict' },
      payload: {
        platform: 'youtube',
        accountId: 'account-1',
        mediaId: 'media-1',
        metadata: { title: 'Title' },
        surprise: true,
      },
    });
    expect(unknownField.statusCode).toBe(400);

    const payload = {
      platform: 'youtube',
      accountId: 'account-1',
      mediaId: 'media-1',
      metadata: { title: 'Title' },
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/publish',
      headers: { ...authorization, 'idempotency-key': 'publish-replay' },
      payload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/publish',
      headers: { ...authorization, 'idempotency-key': 'publish-replay' },
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(temporary!.database.client.prepare('SELECT count(*) AS count FROM jobs').get()).toEqual({
      count: 1,
    });

    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v1/publish',
      headers: { ...authorization, 'idempotency-key': 'publish-replay' },
      payload: { ...payload, metadata: { title: 'Changed' } },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });

    const jobId = first.json<{ job: { id: string } }>().job.id;
    destinations.save({
      destinationId: 'youtube',
      jobId,
      remoteStatus: 'uploading',
      resumableSessionUrl: 'https://upload.example.test/session-secret',
      updatedAt: new Date(),
      uploadedBytes: 5,
    });
    const jobs = await app.inject({
      method: 'GET',
      url: '/api/v1/jobs',
      headers: authorization,
    });
    expect(jobs.statusCode).toBe(200);
    expect(jobs.body).not.toContain('session-secret');
    expect(jobs.body).not.toContain('resumableSessionUrl');
  });
});
