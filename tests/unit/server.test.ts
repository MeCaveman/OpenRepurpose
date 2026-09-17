import { afterEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '@openrepurpose/server';
import type { ApplicationConfig } from '@openrepurpose/shared';

const config: ApplicationConfig = {
  appUrl: new URL('http://127.0.0.1:3000'),
  bindHost: '127.0.0.1',
  jobRunner: {
    baseRetryDelayMs: 1_000,
    concurrency: 2,
    leaseDurationMs: 30_000,
    maxRetryDelayMs: 60_000,
    pollIntervalMs: 250,
  },
  paths: {
    configDirectory: resolve('test-results/config'),
    dataDirectory: resolve('test-results/data'),
    databasePath: resolve('test-results/data/openrepurpose.sqlite'),
    secretKeyPath: resolve('test-results/config/secret-vault.key'),
    secretVaultPath: resolve('test-results/data/secrets.vault.json'),
    sessionKeyPath: resolve('test-results/config/session.key'),
    temporaryDirectory: resolve('test-results/temp'),
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
    return server;
  }

  it('serves health only to an allowed host and emits security headers', async () => {
    const app = createServer();
    const response = await app.inject({ method: 'GET', url: '/api/health', headers: allowedHost });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: 'openrepurpose', status: 'ok', version: '0.1.0' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');

    const rejected = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'evil.test' },
    });
    expect(rejected.statusCode).toBe(421);
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
});
