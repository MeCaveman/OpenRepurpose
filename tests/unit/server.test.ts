import { afterEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '@openrepurpose/server';
import {
  ApiTokenService,
  createTranscriptionCacheIdentity,
  TranscriptService,
} from '@openrepurpose/core';
import {
  SqliteApiTokenRepository,
  SqliteMediaRepository,
  SqliteTranscriptRepository,
} from '@openrepurpose/db';
import { createTemporaryDatabase } from '@openrepurpose/testkit';
import type { ApplicationConfig } from '@openrepurpose/shared';
import type {
  TranscriptionModelManager,
  WhisperModelManagerView,
  WhisperModelView,
} from '@openrepurpose/media';

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
};

const allowedHost = { host: '127.0.0.1:3000' };

describe('Fastify local security boundary', () => {
  let server: FastifyInstance | undefined;

  afterEach(async () => server?.close());

  function createServer(staticRoot: false | string = false) {
    server = buildServer({ config, sessionKey: Buffer.alloc(32, 7), staticRoot });
    server.post('/api/test-state', async () => ({ updated: true }));
    server.post('/api/v1/test-state', async () => ({ updated: true }));
    return server;
  }

  it('serves health only to an allowed host and emits security headers', async () => {
    const app = createServer();
    const response = await app.inject({ method: 'GET', url: '/api/health', headers: allowedHost });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: 'openrepurpose', status: 'ok', version: '1.0.0' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');

    const rejected = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'evil.test' },
    });
    expect(rejected.statusCode).toBe(421);
  });

  it('requires a separate LAN browser token for every non-health resource', async () => {
    const temporary = createTemporaryDatabase();
    const tokenService = new ApiTokenService(new SqliteApiTokenRepository(temporary.database));
    const apiToken = tokenService.create('LAN API', ['control']).token;
    const lanConfig: ApplicationConfig = {
      ...config,
      appUrl: new URL('http://192.0.2.10:3000'),
      bindHost: '0.0.0.0',
      network: { lanEnabled: true, lanAccessToken: 'a'.repeat(32), trustedProxy: false },
    };
    server = buildServer({
      apiTokenService: tokenService,
      config: lanConfig,
      sessionKey: Buffer.alloc(32, 7),
      staticRoot: false,
    });
    const host = { host: '192.0.2.10:3000' };
    expect(
      (await server.inject({ method: 'GET', url: '/api/health', headers: host })).statusCode,
    ).toBe(200);
    expect(
      (await server.inject({ method: 'GET', url: '/api/session', headers: host })).statusCode,
    ).toBe(401);
    const browserBasic = `Basic ${Buffer.from(`openrepurpose:${'a'.repeat(32)}`).toString('base64')}`;
    const authorized = await server.inject({
      method: 'GET',
      url: '/api/session',
      headers: {
        ...host,
        authorization: browserBasic,
      },
    });
    expect(authorized.statusCode).toBe(200);
    const browserCookie = authorized.headers['set-cookie'];
    const { csrfToken } = authorized.json<{ csrfToken: string }>();

    const legacyWithApiToken = await server.inject({
      method: 'GET',
      url: '/api/session',
      headers: { ...host, authorization: `Bearer ${apiToken}` },
    });
    expect(legacyWithApiToken.statusCode).toBe(401);
    const apiWithApiToken = await server.inject({
      method: 'GET',
      url: '/api/v1/auth/tokens',
      headers: { ...host, authorization: `Bearer ${apiToken}` },
    });
    expect(apiWithApiToken.statusCode).toBe(200);

    const browserMutation = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/tokens',
      headers: {
        ...host,
        authorization: browserBasic,
        cookie: String(browserCookie),
        origin: lanConfig.appUrl.origin,
        'x-csrf-token': csrfToken,
      },
      payload: { name: 'Browser-created token', permissions: ['read'] },
    });
    expect(browserMutation.statusCode).toBe(201);
    temporary.dispose();
  });

  it('requires an allowed Origin and a session-bound CSRF token for mutations', async () => {
    const app = createServer();
    const missingOrigin = await app.inject({
      method: 'POST',
      url: '/api/test-state',
      headers: allowedHost,
    });
    expect(missingOrigin.statusCode).toBe(403);
    expect(missingOrigin.json()).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });

    for (const authorization of ['Basic dXNlcjpwYXNz', 'Bearer']) {
      const attemptedBypass = await app.inject({
        method: 'POST',
        url: '/api/v1/test-state',
        headers: { ...allowedHost, authorization },
      });
      expect(attemptedBypass.statusCode).toBe(403);
      expect(attemptedBypass.json()).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });
    }

    const session = await app.inject({ method: 'GET', url: '/api/session', headers: allowedHost });
    const { csrfToken } = session.json<{ csrfToken: string }>();
    const cookie = session.headers['set-cookie'];
    expect(typeof cookie).toBe('string');

    const wrongOrigin = await app.inject({
      method: 'POST',
      url: '/api/test-state',
      headers: {
        ...allowedHost,
        origin: 'http://evil.test',
        cookie: String(cookie),
        'x-csrf-token': csrfToken,
      },
    });
    expect(wrongOrigin.statusCode).toBe(403);

    const wrongToken = await app.inject({
      method: 'POST',
      url: '/api/test-state',
      headers: {
        ...allowedHost,
        origin: config.appUrl.origin,
        cookie: String(cookie),
        'x-csrf-token': 'wrong',
      },
    });
    expect(wrongToken.statusCode).toBe(403);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/test-state',
      headers: {
        ...allowedHost,
        origin: config.appUrl.origin,
        cookie: String(cookie),
        'x-csrf-token': csrfToken,
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ updated: true });
  });

  it('serves the production shell for client-side routes without masking API 404s', async () => {
    const app = createServer(resolve('tests/fixtures/web-dist'));
    const page = await app.inject({
      method: 'GET',
      url: '/settings',
      headers: { ...allowedHost, accept: 'text/html' },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('fixture shell');

    const missingApi = await app.inject({
      method: 'GET',
      url: '/api/missing',
      headers: allowedHost,
    });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.json()).toMatchObject({ code: 'API_ROUTE_NOT_FOUND' });
  });

  it('redacts sensitive structured fields and raw errors from server logs', async () => {
    const chunks: string[] = [];
    server = buildServer({
      config,
      logger: true,
      loggerDestination: { write: (chunk) => chunks.push(chunk) },
      sessionKey: Buffer.alloc(32, 7),
      staticRoot: false,
    });
    server.get('/api/log-redaction', async (request) => {
      request.log.info(
        {
          authorization: 'Bearer request-secret',
          credentials: { clientSecret: 'client-secret-value' },
        },
        'Structured log test',
      );
      request.log.error({ err: new Error('refresh token: raw-error-secret') }, 'Safe error');
      return { ok: true };
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/log-redaction',
      headers: allowedHost,
    });

    expect(response.statusCode).toBe(200);
    const output = chunks.join('');
    expect(output).not.toContain('request-secret');
    expect(output).not.toContain('client-secret-value');
    expect(output).not.toContain('raw-error-secret');
    expect(output).toContain('[REDACTED]');
  });

  it('lists models without downloading and protects explicit model mutations with CSRF', async () => {
    const calls: string[] = [];
    const model = (status: WhisperModelView['status']): WhisperModelView => ({
      checksum: { algorithm: 'sha1', value: 'a'.repeat(40) },
      description: 'Fixture model',
      diskRequiredBytes: 2,
      diskWarning: false,
      displayName: 'Fixture model',
      id: 'fixture',
      integrity: status === 'installed' ? 'verified' : 'not-installed',
      languageSupport: 'multilingual',
      performance: 'fast',
      sizeBytes: 1,
      sourceUrl: 'https://models.example.test/fixture.bin',
      status,
      version: 'sha1-aaaaaaaaaaaa',
    });
    const snapshot: WhisperModelManagerView = {
      availableBytes: 100,
      models: [model('not-installed')],
      reserveBytes: 1,
      storagePath: resolve('test-results/models'),
    };
    const manager: TranscriptionModelManager = {
      list: async () => {
        calls.push('list');
        return snapshot;
      },
      startDownload: async (id) => {
        calls.push(`download:${id}`);
        return model('downloading');
      },
      download: async () => model('installed'),
      verify: async (id) => {
        calls.push(`verify:${id}`);
        return model('installed');
      },
      delete: async (id) => {
        calls.push(`delete:${id}`);
        return model('not-installed');
      },
    };
    server = buildServer({
      config,
      modelManager: manager,
      sessionKey: Buffer.alloc(32, 7),
      staticRoot: false,
    });

    const listed = await server.inject({
      method: 'GET',
      url: '/api/transcription/models',
      headers: allowedHost,
    });
    expect(listed.statusCode).toBe(200);
    expect(calls).toEqual(['list']);

    const session = await server.inject({
      method: 'GET',
      url: '/api/session',
      headers: allowedHost,
    });
    const { csrfToken } = session.json<{ csrfToken: string }>();
    const mutationHeaders = {
      ...allowedHost,
      origin: config.appUrl.origin,
      cookie: String(session.headers['set-cookie']),
      'x-csrf-token': csrfToken,
    };
    const started = await server.inject({
      method: 'POST',
      url: '/api/transcription/models/fixture/download',
      headers: mutationHeaders,
    });
    expect(started.statusCode).toBe(202);
    const deleted = await server.inject({
      method: 'DELETE',
      url: '/api/transcription/models/fixture',
      headers: mutationHeaders,
    });
    expect(deleted.statusCode).toBe(200);
    expect(calls).toEqual(['list', 'download:fixture', 'delete:fixture']);
  });

  it('lists, edits, and exports persisted transcripts through the shared service', async () => {
    const fixture = createTemporaryDatabase();
    try {
      new SqliteMediaRepository(fixture.database).create({
        id: 'media-transcript-api',
        path: '/media/clip.mp4',
        fingerprint: 'sha256:media-api',
        sizeBytes: 100,
        modifiedAt: new Date(0),
        state: 'available',
        createdAt: new Date(0),
        metadata: { hasAudio: true },
      });
      const repository = new SqliteTranscriptRepository(fixture.database);
      repository.reserve({
        id: 'transcript-api',
        identity: createTranscriptionCacheIdentity({
          model: { id: 'base', version: 'v1' },
          providerId: 'whisper-cpp',
          sourceAudioFingerprint: 'sha256:audio-api',
        }),
        now: new Date(1),
        source: { kind: 'media', mediaId: 'media-transcript-api' },
      });
      repository.replaceGeneratedCues(
        'transcript-api',
        [{ startMs: 0, endMs: 1_000, text: 'Original' }],
        new Date(2),
      );
      server = buildServer({
        config,
        sessionKey: Buffer.alloc(32, 7),
        staticRoot: false,
        transcriptService: new TranscriptService(repository, () => new Date(3)),
      });

      const listed = await server.inject({
        method: 'GET',
        url: '/api/media/media-transcript-api/transcripts',
        headers: allowedHost,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toMatchObject({
        transcripts: [{ id: 'transcript-api', revision: 1, cues: [{ text: 'Original' }] }],
      });

      const session = await server.inject({
        method: 'GET',
        url: '/api/session',
        headers: allowedHost,
      });
      const { csrfToken } = session.json<{ csrfToken: string }>();
      const updated = await server.inject({
        method: 'PUT',
        url: '/api/transcripts/transcript-api',
        headers: {
          ...allowedHost,
          origin: config.appUrl.origin,
          cookie: String(session.headers['set-cookie']),
          'content-type': 'application/json',
          'x-csrf-token': csrfToken,
        },
        payload: { expectedRevision: 1, cues: [{ startMs: 25, endMs: 1_100, text: 'Edited' }] },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({
        transcript: { hasUserEdits: true, revision: 2, cues: [{ text: 'Edited' }] },
      });

      const exported = await server.inject({
        method: 'GET',
        url: '/api/transcripts/transcript-api/export?format=vtt',
        headers: allowedHost,
      });
      expect(exported.statusCode).toBe(200);
      expect(exported.headers['content-type']).toContain('text/vtt');
      expect(exported.headers['content-disposition']).toBe('attachment; filename="transcript.vtt"');
      expect(exported.body).toBe('WEBVTT\n\n00:00:00.025 --> 00:00:01.100\nEdited\n');
    } finally {
      await server?.close();
      server = undefined;
      fixture.dispose();
    }
  });
});
