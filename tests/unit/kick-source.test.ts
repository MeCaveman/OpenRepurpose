import { describe, expect, it } from 'vitest';
import {
  KickOAuthService,
  KickSourceAdapter,
  type KickAccessTokenProvider,
} from '@openrepurpose/kick';
import {
  SqliteAccountRepository,
  SqliteOAuthAuthorizationRequestRepository,
} from '@openrepurpose/db';
import { createRedactingLogger } from '@openrepurpose/platform-sdk';
import { createTemporaryDatabase, InMemorySecretStore } from '@openrepurpose/testkit';

const now = new Date('2026-09-23T12:00:00.000Z');
const tokens: KickAccessTokenProvider = { getAccessToken: async () => ({ accessToken: 'access' }) };
const context = {
  logger: createRedactingLogger({ subsystem: 'kick-test', write: () => undefined }),
  secretStore: new InMemorySecretStore(),
  signal: new AbortController().signal,
};

describe('Kick source adapter', () => {
  it('observes only active livestream metadata and does not present official media download', async () => {
    const calls: URL[] = [];
    const adapter = new KickSourceAdapter(tokens, {
      apiBaseUrl: 'https://kick.test',
      http: async (input) => {
        calls.push(new URL(input.toString()));
        return json({
          data: [
            {
              livestream_id: 'stream-1',
              slug: 'streamer',
              started_at: '2026-09-23T11:00:00Z',
              session_title: 'Live now',
              viewer_count: 42,
            },
          ],
        });
      },
    });

    const result = await adapter.poll(
      {
        connectionExternalId: 'broadcaster-1',
        cursor: null,
        configuration: { accountId: 'account-1', broadcasterId: 'broadcaster-1' },
      },
      context,
    );

    expect(calls[0]?.pathname).toBe('/public/v1/users/livestreams');
    expect(calls[0]?.searchParams.get('broadcaster_user_id')).toBe('broadcaster-1');
    expect(result).toMatchObject({
      hasMore: false,
      items: [
        {
          externalId: 'stream-1',
          metadata: { kickKind: 'active_livestream', channelSlug: 'streamer' },
          media: {
            availability: 'unavailable',
            resolutionStrategies: ['local_original', 'external_downloader'],
            rightsRequirement: 'explicit_confirmation',
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('official_download');
    expect(JSON.stringify(result)).not.toContain('stream_url');
  });

  it('uses browser-bound PKCE OAuth and keeps tokens out of the account record', async () => {
    const temporary = createTemporaryDatabase();
    try {
      const service = new KickOAuthService(
        new SqliteAccountRepository(temporary.database),
        new SqliteOAuthAuthorizationRequestRepository(temporary.database),
        new InMemorySecretStore(),
        new URL('http://localhost:43123'),
        {
          now: () => now,
          endpoints: {
            authorization: 'https://id.kick.test/oauth/authorize',
            token: 'https://id.kick.test/oauth/token',
            user: 'https://api.kick.test/public/v1/users',
          },
          http: async (input, init) => {
            const url = new URL(input.toString());
            if (url.pathname.endsWith('/token')) {
              expect(init?.body).toBeInstanceOf(URLSearchParams);
              return json({ access_token: 'access-token', refresh_token: 'refresh-token' });
            }
            expect(init?.headers).toEqual({ Authorization: 'Bearer access-token' });
            return json({ data: [{ user_id: 7, username: 'streamer' }] });
          },
        },
      );
      await service.configureCredentials({ clientId: 'client-id', clientSecret: 'client-secret' });
      const start = await service.beginAuthorization('browser-binding');
      const authorization = new URL(start.authorizationUrl);
      expect(authorization.searchParams.get('scope')).toBe('user:read channel:read');
      expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
      const account = await service.completeAuthorization({
        browserBinding: 'browser-binding',
        code: 'code',
        state: authorization.searchParams.get('state')!,
      });
      expect(account).toMatchObject({
        provider: 'kick',
        externalId: '7',
        capabilities: ['kick.identity.read', 'kick.channel.read'],
      });
      expect(JSON.stringify(account)).not.toContain('access-token');
      await expect(service.getAccessToken(account.id)).resolves.toEqual({
        accessToken: 'access-token',
      });
    } finally {
      temporary.dispose();
    }
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}
