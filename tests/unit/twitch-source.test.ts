import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaResolverRequest } from '@openrepurpose/core';
import {
  SqliteAccountRepository,
  SqliteOAuthAuthorizationRequestRepository,
} from '@openrepurpose/db';
import { createRedactingLogger } from '@openrepurpose/platform-sdk';
import { createTemporaryDatabase, InMemorySecretStore } from '@openrepurpose/testkit';
import {
  TwitchClipMediaResolver,
  TwitchOAuthService,
  TwitchSourceAdapter,
} from '@openrepurpose/twitch';

const now = new Date('2026-09-21T12:00:00.000Z');
const credentials = { getAccessToken: async () => ({ accessToken: 'access', clientId: 'client' }) };
const context = {
  logger: createRedactingLogger({ subsystem: 'twitch-test', write: () => undefined }),
  secretStore: new InMemorySecretStore(),
  signal: new AbortController().signal,
};

describe('Twitch source adapter', () => {
  let directory: string | undefined;
  let database: ReturnType<typeof createTemporaryDatabase> | undefined;
  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { force: true, recursive: true });
    database?.dispose();
    database = undefined;
  });

  it('polls clips in an overlapping time window and never persists a temporary URL', async () => {
    const calls: URL[] = [];
    const adapter = new TwitchSourceAdapter(credentials, {
      apiBaseUrl: 'https://twitch.test/helix',
      now: () => now,
      http: async (input) => {
        calls.push(new URL(input.toString()));
        return json({
          data: [
            {
              id: 'clip-1',
              created_at: '2026-09-21T11:00:00Z',
              title: 'Clip',
              url: 'https://www.twitch.tv/example/clip/clip-1',
              video_id: 'vod-1',
              duration: 24,
            },
          ],
        });
      },
    });
    const result = await adapter.poll(
      {
        connectionExternalId: 'broadcaster-1',
        cursor: null,
        configuration: {
          accountId: 'account-1',
          broadcasterId: 'broadcaster-1',
          editorId: 'editor-1',
          kind: 'clips',
        },
      },
      context,
    );
    expect(calls[0]?.pathname).toBe('/helix/clips');
    expect(calls[0]?.searchParams.get('started_at')).toBe('2026-09-21T06:00:00.000Z');
    expect(result.items[0]).toMatchObject({
      externalId: 'clip-1',
      media: {
        availability: 'available',
        resolutionStrategies: ['local_original', 'official_download'],
      },
      metadata: { twitchKind: 'clip', videoId: 'vod-1' },
    });
    expect(JSON.stringify(result)).not.toContain('download_url');
  });

  it('keeps VOD discovery metadata-only', async () => {
    const adapter = new TwitchSourceAdapter(credentials, {
      apiBaseUrl: 'https://twitch.test/helix',
      http: async () =>
        json({
          data: [
            {
              id: 'vod-1',
              published_at: '2026-09-21T10:00:00Z',
              title: 'VOD',
              url: 'https://www.twitch.tv/videos/vod-1',
              duration: '01h02m',
              type: 'archive',
            },
          ],
        }),
    });
    const result = await adapter.poll(
      {
        connectionExternalId: 'broadcaster-1',
        cursor: null,
        configuration: { accountId: 'account-1', broadcasterId: 'broadcaster-1', kind: 'vods' },
      },
      context,
    );
    expect(result.items[0]?.media).toEqual({
      availability: 'unavailable',
      resolutionStrategies: ['local_original'],
      rightsRequirement: 'connection_authorization',
    });
  });

  it('requests a fresh official URL and streams its selected rendition into managed storage', async () => {
    directory = await mkdtemp(join(tmpdir(), 'openrepurpose-twitch-'));
    const destinationPath = join(directory, 'clip.partial');
    const calls: URL[] = [];
    const resolver = new TwitchClipMediaResolver(credentials, {
      apiBaseUrl: 'https://twitch.test/helix',
      http: async (input) => {
        const url = new URL(input.toString());
        calls.push(url);
        return url.hostname === 'cdn.test'
          ? new Response('video-bytes')
          : json({ data: [{ landscape_download_url: 'https://cdn.test/fresh.mp4' }] });
      },
    });
    const request: MediaResolverRequest = {
      strategy: 'official_download',
      sourceItem: {
        id: 'item',
        sourceConnectionId: 'source',
        externalId: 'clip-1',
        dedupeKey: 'clip-1',
        metadata: {
          twitchKind: 'clip',
          accountId: 'account-1',
          broadcasterId: 'broadcaster-1',
          editorId: 'editor-1',
        },
        firstObservedAt: now,
        lastObservedAt: now,
        updatedAt: now,
        media: {
          availability: 'available',
          resolutionStrategies: ['local_original', 'official_download'],
          rightsRequirement: 'connection_authorization',
        },
      },
    };
    await resolver.resolve(request, { destinationPath, signal: new AbortController().signal });
    expect(calls[0]?.pathname).toBe('/helix/clips/downloads');
    expect(calls[0]?.searchParams.get('clip_id')).toBe('clip-1');
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('video-bytes');
  });

  it('keeps OAuth secrets out of the account record and refreshes a token for the adapter', async () => {
    database = createTemporaryDatabase();
    const secrets = new InMemorySecretStore();
    const service = new TwitchOAuthService(
      new SqliteAccountRepository(database.database),
      new SqliteOAuthAuthorizationRequestRepository(database.database),
      secrets,
      new URL('http://127.0.0.1:43123'),
      {
        now: () => now,
        endpoints: {
          authorization: 'https://id.twitch.test/authorize',
          token: 'https://id.twitch.test/token',
          validate: 'https://id.twitch.test/validate',
        },
        http: async (input, init) => {
          const url = new URL(input.toString());
          if (url.pathname === '/token')
            return json({ access_token: 'access-token', refresh_token: 'rotated-refresh' });
          expect(init?.headers).toEqual({ Authorization: 'OAuth access-token' });
          return json({
            client_id: 'client-id',
            login: 'streamer',
            user_id: 'broadcaster-1',
            scopes: ['channel:manage:clips'],
          });
        },
      },
    );
    await service.configureCredentials({ clientId: 'client-id', clientSecret: 'client-secret' });
    const start = await service.beginAuthorization('browser-binding', {
      officialClipDownload: true,
    });
    const authorization = new URL(start.authorizationUrl);
    expect(authorization.searchParams.get('scope')).toBe(
      'channel:manage:clips editor:manage:clips',
    );
    const account = await service.completeAuthorization({
      browserBinding: 'browser-binding',
      code: 'code',
      state: authorization.searchParams.get('state')!,
    });
    expect(account).toMatchObject({
      provider: 'twitch',
      externalId: 'broadcaster-1',
      capabilities: ['twitch.identity.read', 'twitch.clip.download'],
    });
    expect(JSON.stringify(account)).not.toContain('access-token');
    await expect(service.getAccessToken(account.id)).resolves.toEqual({
      accessToken: 'access-token',
      clientId: 'client-id',
    });
  });
});
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}
