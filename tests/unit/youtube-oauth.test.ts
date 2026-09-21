import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  SqliteAccountRepository,
  SqliteOAuthAuthorizationRequestRepository,
} from '@openrepurpose/db';
import { EncryptedFileSecretStore } from '@openrepurpose/local-secrets';
import type { SecretReference } from '@openrepurpose/platform-sdk';
import { InMemorySecretStore, createTemporaryDatabase } from '@openrepurpose/testkit';
import type { TemporaryDatabase } from '@openrepurpose/testkit';
import {
  YOUTUBE_READONLY_SCOPE,
  YOUTUBE_UPLOAD_SCOPE,
  YouTubeOAuthService,
  youtubeRefreshTokenReference,
} from '@openrepurpose/youtube';
import type { OAuthHttpClient } from '@openrepurpose/youtube';
import { buildServer } from '@openrepurpose/server';
import type { ApplicationConfig } from '@openrepurpose/shared';

const tokenEndpoint = 'https://oauth.test/token';
const channelsEndpoint = 'https://youtube.test/channels';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

function testConfig(directory: string): ApplicationConfig {
  return {
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

function mockedGoogleHttp() {
  const tokenForms: URLSearchParams[] = [];
  const authorizationHeaders: string[] = [];
  let refreshes = 0;
  let failRefresh = false;
  const http: OAuthHttpClient = async (input, init) => {
    const url = input.toString();
    if (url === tokenEndpoint) {
      const form = init?.body;
      if (!(form instanceof URLSearchParams)) throw new Error('Expected form body.');
      tokenForms.push(form);
      if (form.get('grant_type') === 'authorization_code') {
        return jsonResponse({
          access_token: 'initial-access-token',
          expires_in: 3_600,
          refresh_token: 'initial-refresh-token',
          scope: `${YOUTUBE_READONLY_SCOPE} ${YOUTUBE_UPLOAD_SCOPE}`,
          token_type: 'Bearer',
        });
      }
      refreshes += 1;
      if (failRefresh) return jsonResponse({ error: 'invalid_grant' }, 400);
      return jsonResponse({
        access_token: `refreshed-access-token-${refreshes}`,
        expires_in: 3_600,
        refresh_token: 'rotated-refresh-token',
        token_type: 'Bearer',
      });
    }
    if (url.startsWith(channelsEndpoint)) {
      const headers = new Headers(init?.headers);
      authorizationHeaders.push(headers.get('authorization') ?? '');
      return jsonResponse({ items: [{ id: 'UC-channel', snippet: { title: 'Creator Channel' } }] });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  return {
    authorizationHeaders,
    http,
    setFailRefresh: () => {
      failRefresh = true;
    },
    tokenForms,
  };
}

describe('encrypted local secret store', () => {
  let temporary: TemporaryDatabase | undefined;

  afterEach(() => temporary?.dispose());

  it('persists authenticated ciphertext without writing the secret value', async () => {
    temporary = createTemporaryDatabase();
    const keyPath = join(temporary.directory, 'config', 'secret.key');
    const vaultPath = join(temporary.directory, 'data', 'secrets.json');
    const store = new EncryptedFileSecretStore(vaultPath, keyPath);
    const reference: SecretReference = {
      name: 'refresh-token',
      ownerId: 'account-1',
      scope: 'account',
    };

    await store.set(reference, 'refresh-token-plaintext');
    expect(await new EncryptedFileSecretStore(vaultPath, keyPath).get(reference)).toBe(
      'refresh-token-plaintext',
    );
    expect(await readFile(vaultPath, 'utf8')).not.toContain('refresh-token-plaintext');
    expect(await store.delete(reference)).toBe(true);
    expect(await store.get(reference)).toBeUndefined();
  });
});

describe('YouTube OAuth service', () => {
  let temporary: TemporaryDatabase | undefined;

  afterEach(() => temporary?.dispose());

  it('uses one-time state and S256 PKCE, stores refresh tokens, and refreshes server-side', async () => {
    temporary = createTemporaryDatabase();
    const secrets = new InMemorySecretStore();
    const google = mockedGoogleHttp();
    const accounts = new SqliteAccountRepository(temporary.database);
    const requests = new SqliteOAuthAuthorizationRequestRepository(temporary.database);
    const service = new YouTubeOAuthService(
      accounts,
      requests,
      secrets,
      new URL('http://127.0.0.1:3000'),
      {
        endpoints: { channels: channelsEndpoint, token: tokenEndpoint },
        http: google.http,
        now: () => new Date('2026-09-17T10:00:00.000Z'),
      },
    );
    await service.configureCredentials({
      clientId: 'desktop-client.apps.googleusercontent.com',
      clientSecret: 'desktop-client-secret',
    });
    await service.configureCredentials({
      clientId: 'desktop-client.apps.googleusercontent.com',
    });
    expect(await service.credentialStatus()).toMatchObject({ clientSecretConfigured: true });

    const browserBinding = 'browser-session-binding';
    const start = await service.beginAuthorization(browserBinding);
    const authorizationUrl = new URL(start.authorizationUrl);
    const state = authorizationUrl.searchParams.get('state');
    const challenge = authorizationUrl.searchParams.get('code_challenge');
    expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('scope')?.split(' ')).toEqual([
      YOUTUBE_READONLY_SCOPE,
      YOUTUBE_UPLOAD_SCOPE,
    ]);
    const persistedState = temporary.database.client
      .prepare('SELECT state_hash FROM oauth_authorization_requests')
      .get() as { state_hash: string };
    expect(persistedState.state_hash).not.toBe(state);

    await expect(
      service.completeAuthorization({
        browserBinding: 'different-browser-session',
        code: 'stolen-code',
        state: state!,
      }),
    ).rejects.toMatchObject({ code: 'YOUTUBE_OAUTH_STATE_INVALID' });

    const account = await service.completeAuthorization({
      browserBinding,
      code: 'authorization-code',
      state: state!,
    });
    expect(account).toMatchObject({
      capabilities: ['youtube.identity.read', 'youtube.video.upload'],
      displayName: 'Creator Channel',
      externalId: 'UC-channel',
      status: 'connected',
    });
    const exchange = google.tokenForms[0]!;
    const verifier = exchange.get('code_verifier');
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(createHash('sha256').update(verifier!).digest('base64url')).toBe(challenge);
    expect(exchange.get('client_secret')).toBe('desktop-client-secret');
    expect(google.authorizationHeaders).toEqual(['Bearer initial-access-token']);
    expect(await secrets.get(youtubeRefreshTokenReference(account.id))).toBe(
      'initial-refresh-token',
    );

    await expect(
      service.completeAuthorization({ browserBinding, code: 'replayed-code', state: state! }),
    ).rejects.toMatchObject({ code: 'YOUTUBE_OAUTH_STATE_INVALID' });
    expect(await service.refreshAccessToken(account.id)).toBe('refreshed-access-token-1');
    expect(await secrets.get(youtubeRefreshTokenReference(account.id))).toBe(
      'rotated-refresh-token',
    );

    google.setFailRefresh();
    await expect(service.refreshAccessToken(account.id)).rejects.toMatchObject({
      code: 'YOUTUBE_TOKEN_REFRESH_FAILED',
    });
    expect(accounts.findById(account.id)?.status).toBe('reauthorization_required');
  });

  it('rejects expired state before making an OAuth HTTP request and removes the verifier', async () => {
    temporary = createTemporaryDatabase();
    const secrets = new InMemorySecretStore();
    let now = new Date('2026-09-17T10:00:00.000Z');
    let httpCalls = 0;
    const service = new YouTubeOAuthService(
      new SqliteAccountRepository(temporary.database),
      new SqliteOAuthAuthorizationRequestRepository(temporary.database),
      secrets,
      new URL('http://127.0.0.1:3000'),
      {
        flowLifetimeMs: 1_000,
        http: async () => {
          httpCalls += 1;
          return jsonResponse({});
        },
        now: () => now,
      },
    );
    await service.configureCredentials({ clientId: 'desktop.apps.googleusercontent.com' });
    const browserBinding = 'browser-session-binding';
    const start = await service.beginAuthorization(browserBinding);
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    const row = temporary.database.client
      .prepare('SELECT id FROM oauth_authorization_requests')
      .get() as { id: string };
    const verifier: SecretReference = {
      name: 'code-verifier',
      ownerId: `youtube-oauth:${row.id}`,
      scope: 'application',
    };
    expect(await secrets.get(verifier)).toBeDefined();

    now = new Date('2026-09-17T10:00:02.000Z');
    await expect(
      service.completeAuthorization({ browserBinding, code: 'late', state }),
    ).rejects.toMatchObject({ code: 'YOUTUBE_OAUTH_STATE_EXPIRED' });
    expect(httpCalls).toBe(0);
    expect(await secrets.get(verifier)).toBeUndefined();
  });
});

describe('YouTube account HTTP flow', () => {
  let temporary: TemporaryDatabase | undefined;
  let server: FastifyInstance | undefined;

  afterEach(async () => {
    await server?.close();
    temporary?.dispose();
  });

  it('configures credentials, completes mocked OAuth, and exposes only safe account status', async () => {
    temporary = createTemporaryDatabase();
    const google = mockedGoogleHttp();
    const service = new YouTubeOAuthService(
      new SqliteAccountRepository(temporary.database),
      new SqliteOAuthAuthorizationRequestRepository(temporary.database),
      new InMemorySecretStore(),
      new URL('http://127.0.0.1:3000'),
      { endpoints: { channels: channelsEndpoint, token: tokenEndpoint }, http: google.http },
    );
    server = buildServer({
      config: testConfig(temporary.directory),
      sessionKey: Buffer.alloc(32, 5),
      staticRoot: false,
      youtubeOAuthService: service,
    });
    const host = { host: '127.0.0.1:3000' };
    const session = await server.inject({ method: 'GET', url: '/api/session', headers: host });
    const cookie = String(session.headers['set-cookie']);
    expect(cookie).toContain('SameSite=Lax');
    const csrf = session.json<{ csrfToken: string }>().csrfToken;
    const mutationHeaders = {
      ...host,
      cookie,
      origin: 'http://127.0.0.1:3000',
      'x-csrf-token': csrf,
    };

    const configured = await server.inject({
      method: 'POST',
      url: '/api/accounts/youtube/credentials',
      headers: { ...mutationHeaders, 'content-type': 'application/json' },
      payload: {
        clientId: 'desktop-client.apps.googleusercontent.com',
        clientSecret: 'never-return-this-secret',
      },
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.body).not.toContain('never-return-this-secret');

    const started = await server.inject({
      method: 'POST',
      url: '/api/accounts/youtube/oauth/start',
      headers: mutationHeaders,
    });
    const authorizationUrl = new URL(started.json<{ authorizationUrl: string }>().authorizationUrl);
    const callback = await server.inject({
      method: 'GET',
      url: `/api/accounts/youtube/oauth/callback?state=${encodeURIComponent(authorizationUrl.searchParams.get('state')!)}&code=mock-code`,
      headers: { ...host, cookie },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('http://127.0.0.1:3000/accounts?youtube=connected');

    const listed = await server.inject({ method: 'GET', url: '/api/accounts', headers: host });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      accounts: [{ displayName: 'Creator Channel', status: 'connected' }],
      youtube: { configured: true },
    });
    expect(listed.body).not.toContain('initial-refresh-token');
    expect(listed.body).not.toContain('never-return-this-secret');
  });
});
