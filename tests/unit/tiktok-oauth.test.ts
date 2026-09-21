import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  SqliteAccountRepository,
  SqliteOAuthAuthorizationRequestRepository,
} from '@openrepurpose/db';
import { buildServer } from '@openrepurpose/server';
import type { ApplicationConfig } from '@openrepurpose/shared';
import { InMemorySecretStore, createTemporaryDatabase } from '@openrepurpose/testkit';
import type { TemporaryDatabase } from '@openrepurpose/testkit';
import {
  TIKTOK_IDENTITY_SCOPE,
  TIKTOK_PUBLISH_SCOPE,
  TikTokOAuthService,
  tiktokTokenBundleReference,
} from '@openrepurpose/tiktok';
import type { TikTokHttpClient } from '@openrepurpose/tiktok';

const tokenEndpoint = 'https://tiktok.test/token';
const userEndpoint = 'https://tiktok.test/user';
const creatorEndpoint = 'https://tiktok.test/creator';

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

function mockedTikTokHttp() {
  const tokenForms: URLSearchParams[] = [];
  const authorizationHeaders: string[] = [];
  let failRefresh = false;
  const http: TikTokHttpClient = async (input, init) => {
    const url = input.toString();
    if (url === tokenEndpoint) {
      if (!(init?.body instanceof URLSearchParams)) throw new Error('Expected form body.');
      tokenForms.push(init.body);
      if (init.body.get('grant_type') === 'authorization_code')
        return jsonResponse({
          access_token: 'initial-access-token',
          expires_in: 86_400,
          open_id: 'creator-open-id',
          refresh_expires_in: 31_536_000,
          refresh_token: 'initial-refresh-token',
          scope: `${TIKTOK_IDENTITY_SCOPE},${TIKTOK_PUBLISH_SCOPE}`,
          token_type: 'Bearer',
        });
      if (failRefresh) return jsonResponse({ error: 'invalid_grant' }, 400);
      return jsonResponse({
        access_token: 'refreshed-access-token',
        expires_in: 86_400,
        open_id: 'creator-open-id',
        refresh_expires_in: 31_536_000,
        refresh_token: 'rotated-refresh-token',
        scope: `${TIKTOK_IDENTITY_SCOPE},${TIKTOK_PUBLISH_SCOPE}`,
        token_type: 'Bearer',
      });
    }
    const headers = new Headers(init?.headers);
    authorizationHeaders.push(headers.get('authorization') ?? '');
    if (url.startsWith(userEndpoint))
      return jsonResponse({
        data: { user: { display_name: 'TikTok Creator', open_id: 'creator-open-id' } },
        error: { code: 'ok', log_id: 'safe-log-id', message: '' },
      });
    if (url === creatorEndpoint)
      return jsonResponse({
        data: {
          comment_disabled: false,
          creator_nickname: 'TikTok Creator',
          creator_username: 'creator_handle',
          duet_disabled: true,
          max_video_post_duration_sec: 300,
          privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
          stitch_disabled: false,
        },
        error: { code: 'ok', log_id: 'safe-log-id', message: '' },
      });
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

describe('TikTok OAuth and creator capability service', () => {
  let temporary: TemporaryDatabase | undefined;

  afterEach(() => temporary?.dispose());

  it('uses one-time state and TikTok desktop PKCE, stores an atomic token bundle, and rotates it', async () => {
    temporary = createTemporaryDatabase();
    const secrets = new InMemorySecretStore();
    const remote = mockedTikTokHttp();
    const accounts = new SqliteAccountRepository(temporary.database);
    const service = new TikTokOAuthService(
      accounts,
      new SqliteOAuthAuthorizationRequestRepository(temporary.database),
      secrets,
      new URL('http://127.0.0.1:3000'),
      {
        endpoints: { creatorInfo: creatorEndpoint, token: tokenEndpoint, userInfo: userEndpoint },
        http: remote.http,
        now: () => new Date('2026-09-18T10:00:00.000Z'),
      },
    );
    await service.configureCredentials({ clientKey: 'client-key', clientSecret: 'client-secret' });
    expect(await service.credentialStatus()).toMatchObject({ configured: true, flow: 'desktop' });

    const browserBinding = 'browser-session-binding';
    const start = await service.beginAuthorization(browserBinding);
    const authorizationUrl = new URL(start.authorizationUrl);
    const state = authorizationUrl.searchParams.get('state')!;
    const challenge = authorizationUrl.searchParams.get('code_challenge');
    expect(challenge).toMatch(/^[a-f0-9]{64}$/);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('scope')).toBe(
      `${TIKTOK_IDENTITY_SCOPE},${TIKTOK_PUBLISH_SCOPE}`,
    );

    await expect(
      service.completeAuthorization({
        browserBinding: 'another-session',
        code: 'stolen-code',
        state,
      }),
    ).rejects.toMatchObject({ code: 'TIKTOK_OAUTH_STATE_INVALID' });

    const account = await service.completeAuthorization({
      browserBinding,
      code: 'authorization-code',
      state,
    });
    expect(account).toMatchObject({
      capabilities: ['tiktok.identity.read', 'tiktok.video.publish'],
      displayName: 'TikTok Creator',
      externalId: 'creator-open-id',
      provider: 'tiktok',
      status: 'connected',
    });
    const verifier = remote.tokenForms[0]!.get('code_verifier');
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(createHash('sha256').update(verifier!).digest('hex')).toBe(challenge);
    expect(remote.tokenForms[0]!.get('client_secret')).toBe('client-secret');

    const stored = await secrets.get(tiktokTokenBundleReference(account.id));
    expect(stored).toContain('initial-access-token');
    expect(stored).toContain('initial-refresh-token');
    const capabilities = await service.getAccountCapabilities(account.id);
    expect(capabilities).toMatchObject({
      directPostAvailable: true,
      grantedScopes: [TIKTOK_IDENTITY_SCOPE, TIKTOK_PUBLISH_SCOPE],
      media: { maxVideoDurationSeconds: 300 },
      privacyLevelOptions: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
      publicPostingAvailability: 'requires_audit_confirmation',
    });
    expect(capabilities.audit.unauditedClientsPrivateOnly).toBe(true);

    expect(await service.refreshAccessToken(account.id)).toBe('refreshed-access-token');
    const rotated = await secrets.get(tiktokTokenBundleReference(account.id));
    expect(rotated).toContain('rotated-refresh-token');
    expect(rotated).not.toContain('initial-refresh-token');

    await expect(
      service.completeAuthorization({ browserBinding, code: 'replayed-code', state }),
    ).rejects.toMatchObject({ code: 'TIKTOK_OAUTH_STATE_INVALID' });
    remote.setFailRefresh();
    await expect(service.refreshAccessToken(account.id)).rejects.toMatchObject({
      code: 'TIKTOK_TOKEN_REFRESH_FAILED',
    });
    expect(accounts.findById(account.id)?.status).toBe('reauthorization_required');
    expect(remote.authorizationHeaders).toEqual([
      'Bearer initial-access-token',
      'Bearer initial-access-token',
    ]);
  });

  it('uses the confidential web flow without PKCE for a registered HTTPS callback', async () => {
    temporary = createTemporaryDatabase();
    const remote = mockedTikTokHttp();
    const service = new TikTokOAuthService(
      new SqliteAccountRepository(temporary.database),
      new SqliteOAuthAuthorizationRequestRepository(temporary.database),
      new InMemorySecretStore(),
      new URL('https://repurpose.example.test'),
      { endpoints: { token: tokenEndpoint, userInfo: userEndpoint }, http: remote.http },
    );
    await service.configureCredentials({ clientKey: 'web-key', clientSecret: 'web-secret' });
    const start = await service.beginAuthorization('browser-binding');
    const authorizationUrl = new URL(start.authorizationUrl);
    expect(authorizationUrl.searchParams.has('code_challenge')).toBe(false);
    expect((await service.credentialStatus()).flow).toBe('web');
    await service.completeAuthorization({
      browserBinding: 'browser-binding',
      code: 'web-code',
      state: authorizationUrl.searchParams.get('state')!,
    });
    expect(remote.tokenForms[0]!.has('code_verifier')).toBe(false);
    expect(remote.tokenForms[0]!.get('redirect_uri')).toBe(
      'https://repurpose.example.test/api/accounts/tiktok/oauth/callback',
    );
  });
});

describe('TikTok account HTTP flow', () => {
  let temporary: TemporaryDatabase | undefined;
  let server: FastifyInstance | undefined;

  afterEach(async () => {
    await server?.close();
    temporary?.dispose();
  });

  it('connects with mocked OAuth and returns safe live capabilities without credentials or tokens', async () => {
    temporary = createTemporaryDatabase();
    const remote = mockedTikTokHttp();
    const service = new TikTokOAuthService(
      new SqliteAccountRepository(temporary.database),
      new SqliteOAuthAuthorizationRequestRepository(temporary.database),
      new InMemorySecretStore(),
      new URL('http://127.0.0.1:3000'),
      {
        endpoints: { creatorInfo: creatorEndpoint, token: tokenEndpoint, userInfo: userEndpoint },
        http: remote.http,
      },
    );
    server = buildServer({
      config: testConfig(temporary.directory),
      sessionKey: Buffer.alloc(32, 6),
      staticRoot: false,
      tiktokOAuthService: service,
    });
    const host = { host: '127.0.0.1:3000' };
    const session = await server.inject({ method: 'GET', url: '/api/session', headers: host });
    const cookie = String(session.headers['set-cookie']);
    const csrf = session.json<{ csrfToken: string }>().csrfToken;
    const mutationHeaders = {
      ...host,
      cookie,
      origin: 'http://127.0.0.1:3000',
      'x-csrf-token': csrf,
    };
    const configured = await server.inject({
      method: 'POST',
      url: '/api/accounts/tiktok/credentials',
      headers: { ...mutationHeaders, 'content-type': 'application/json' },
      payload: { clientKey: 'client-key', clientSecret: 'never-return-this-secret' },
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.body).not.toContain('never-return-this-secret');

    const started = await server.inject({
      method: 'POST',
      url: '/api/accounts/tiktok/oauth/start',
      headers: mutationHeaders,
    });
    const authorizationUrl = new URL(started.json<{ authorizationUrl: string }>().authorizationUrl);
    const callback = await server.inject({
      method: 'GET',
      url: `/api/accounts/tiktok/oauth/callback?state=${encodeURIComponent(authorizationUrl.searchParams.get('state')!)}&code=mock-code`,
      headers: { ...host, cookie },
    });
    expect(callback.headers.location).toBe('http://127.0.0.1:3000/accounts?tiktok=connected');

    const listed = await server.inject({ method: 'GET', url: '/api/accounts', headers: host });
    const accountId = listed.json<{ accounts: Array<{ id: string }> }>().accounts[0]!.id;
    const preflight = await server.inject({
      method: 'GET',
      url: `/api/accounts/tiktok/${accountId}/capabilities`,
      headers: host,
    });
    expect(preflight.statusCode).toBe(200);
    expect(preflight.json()).toMatchObject({
      capabilities: {
        directPostAvailable: true,
        publicPostingAvailability: 'requires_audit_confirmation',
      },
    });
    for (const secret of [
      'never-return-this-secret',
      'initial-access-token',
      'initial-refresh-token',
    ]) {
      expect(listed.body).not.toContain(secret);
      expect(preflight.body).not.toContain(secret);
    }
  });
});
