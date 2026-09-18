import { afterEach, describe, expect, it } from 'vitest';
import { JobService, SourcePollingRunner } from '@openrepurpose/core';
import { SqliteJobRepository, SqliteSourcePollingRepository } from '@openrepurpose/db';
import { createRedactingLogger, SourceRegistry } from '@openrepurpose/platform-sdk';
import { InMemorySecretStore, createTemporaryDatabase } from '@openrepurpose/testkit';
import type { TemporaryDatabase } from '@openrepurpose/testkit';
import { YouTubeSourceAdapter } from '@openrepurpose/youtube';

const publishedAt = '2026-09-18T10:00:00.000Z';

describe('YouTube upload source detection', () => {
  let temporary: TemporaryDatabase | undefined;
  afterEach(() => temporary?.dispose());

  it('detects a new upload using the channel uploads playlist, not broad search', async () => {
    temporary = createTemporaryDatabase();
    insertConnection(temporary, null);
    const calls: URL[] = [];
    const runner = createRunner(temporary, async (url) => {
      calls.push(url);
      if (url.pathname.endsWith('/channels')) return response(channel());
      if (url.pathname.endsWith('/playlistItems'))
        return response(playlist([upload('video-1', publishedAt)]));
      throw new Error(`Unexpected endpoint: ${url.pathname}`);
    });

    await runner.runOnce();

    expect(items(temporary)).toEqual([
      { external_id: 'video-1', metadata_json: JSON.stringify(metadata('video-1')) },
    ]);
    expect(jobCount(temporary)).toBe(1);
    expect(calls.map((url) => url.pathname)).toEqual(['/v3/channels', '/v3/playlistItems']);
    expect(calls[1]?.searchParams.get('playlistId')).toBe('uploads-1');
  });

  it('observes the same upload repeatedly without another source item or handoff job', async () => {
    temporary = createTemporaryDatabase();
    insertConnection(temporary, null);
    const fetch = async (url: URL) =>
      url.pathname.endsWith('/channels')
        ? response(channel())
        : response(playlist([upload('video-1', publishedAt)]));
    await createRunner(temporary, fetch).runOnce();
    temporary.database.client.prepare('UPDATE source_connections SET next_poll_at = NULL').run();
    await createRunner(temporary, fetch).runOnce();

    expect(items(temporary)).toHaveLength(1);
    expect(jobCount(temporary)).toBe(1);
  });

  it('persists multiple newly uploaded videos even when the uploads playlist is reordered', async () => {
    temporary = createTemporaryDatabase();
    insertConnection(temporary, null);
    await createRunner(temporary, async (url) =>
      url.pathname.endsWith('/channels')
        ? response(channel())
        : response(
            playlist([
              upload('video-older', '2026-09-18T09:00:00.000Z'),
              upload('video-newer', '2026-09-18T11:00:00.000Z'),
              upload('video-middle', '2026-09-18T10:00:00.000Z'),
            ]),
          ),
    ).runOnce();

    expect(
      items(temporary)
        .map((item) => item.external_id)
        .sort(),
    ).toEqual(['video-middle', 'video-newer', 'video-older']);
    expect(jobCount(temporary)).toBe(3);
    const cursor = JSON.parse(cursorValue(temporary)) as { watermark: { externalId: string } };
    expect(cursor.watermark.externalId).toBe('video-newer');
  });

  it('uses an existing cursor after restart and only emits uploads newer than its watermark', async () => {
    temporary = createTemporaryDatabase();
    insertConnection(
      temporary,
      JSON.stringify({ version: 1, watermark: { externalId: 'video-1', publishedAt } }),
    );
    await createRunner(temporary, async (url) =>
      url.pathname.endsWith('/channels')
        ? response(channel())
        : response(
            playlist([
              upload('video-1', publishedAt),
              upload('video-2', '2026-09-18T11:00:00.000Z'),
            ]),
          ),
    ).runOnce();

    expect(items(temporary).map((item) => item.external_id)).toEqual(['video-2']);
    expect(jobCount(temporary)).toBe(1);
  });

  it('filters metadata before creating a handoff that could later resolve media', async () => {
    temporary = createTemporaryDatabase();
    insertConnection(temporary, null, {
      filters: { titleSubstring: '[approved]' },
      accountId: 'youtube-account',
    });
    const calls: URL[] = [];
    await createRunner(temporary, async (url) => {
      calls.push(url);
      return url.pathname.endsWith('/channels')
        ? response(channel())
        : response(playlist([upload('video-1', publishedAt, 'not for this workflow')]));
    }).runOnce();

    expect(items(temporary)).toEqual([]);
    expect(jobCount(temporary)).toBe(0);
    expect(calls.map((url) => url.pathname)).toEqual(['/v3/channels', '/v3/playlistItems']);
  });

  it('fetches video duration metadata only for a Shorts-like duration filter', async () => {
    temporary = createTemporaryDatabase();
    insertConnection(temporary, null, {
      filters: { includeShorts: false },
      accountId: 'youtube-account',
    });
    const calls: URL[] = [];
    await createRunner(temporary, async (url) => {
      calls.push(url);
      if (url.pathname.endsWith('/channels')) return response(channel());
      if (url.pathname.endsWith('/playlistItems'))
        return response(playlist([upload('short-video', publishedAt)]));
      return response({ items: [{ contentDetails: { duration: 'PT30S' }, id: 'short-video' }] });
    }).runOnce();

    expect(items(temporary)).toEqual([]);
    expect(jobCount(temporary)).toBe(0);
    expect(calls.map((url) => url.pathname)).toEqual([
      '/v3/channels',
      '/v3/playlistItems',
      '/v3/videos',
    ]);
  });
});

function createRunner(
  temporary: TemporaryDatabase,
  handler: (url: URL) => Promise<Response>,
): SourcePollingRunner {
  const adapter = new YouTubeSourceAdapter(
    { refreshAccessToken: async () => 'access-token' },
    { apiBaseUrl: 'https://youtube.test/v3', http: (input) => handler(new URL(input.toString())) },
  );
  return new SourcePollingRunner(
    new SqliteSourcePollingRepository(temporary.database),
    new SourceRegistry([adapter]),
    new JobService(new SqliteJobRepository(temporary.database), () => new Date(publishedAt)),
    {
      intervalMs: 60_000,
      now: () => new Date(publishedAt),
      pollIntervalMs: 25,
      random: () => 0,
      sourceContext: {
        logger: createRedactingLogger({ subsystem: 'youtube-source-test', write: () => undefined }),
        secretStore: new InMemorySecretStore(),
      },
    },
  );
}

function insertConnection(
  temporary: TemporaryDatabase,
  cursor: string | null,
  configuration: object = { accountId: 'youtube-account' },
): void {
  temporary.database.client
    .prepare(
      `INSERT INTO source_connections (id, adapter_id, external_source_id, display_name, configuration_json, status, cursor_json, consecutive_poll_failures, created_at, updated_at) VALUES (?, 'youtube', 'channel-1', 'Channel', ?, 'active', ?, 0, 0, 0)`,
    )
    .run('source-1', JSON.stringify(configuration), cursor);
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}
function channel(): object {
  return { items: [{ contentDetails: { relatedPlaylists: { uploads: 'uploads-1' } } }] };
}
function playlist(items: readonly object[]): object {
  return { items };
}
function upload(id: string, time: string, title = 'A new upload'): object {
  return {
    contentDetails: { videoId: id, videoPublishedAt: time },
    snippet: { description: `Description for ${id}`, resourceId: { videoId: id }, title },
    status: { privacyStatus: 'public' },
  };
}
function metadata(id: string): object {
  return {
    description: `Description for ${id}`,
    privacyStatus: 'public',
    title: 'A new upload',
    videoId: id,
  };
}
function items(
  temporary: TemporaryDatabase,
): Array<{ external_id: string; metadata_json: string }> {
  return temporary.database.client
    .prepare('SELECT external_id, metadata_json FROM source_items ORDER BY external_id')
    .all() as Array<{ external_id: string; metadata_json: string }>;
}
function jobCount(temporary: TemporaryDatabase): number {
  return (
    temporary.database.client.prepare('SELECT COUNT(*) AS count FROM jobs').get() as {
      count: number;
    }
  ).count;
}
function cursorValue(temporary: TemporaryDatabase): string {
  return (
    temporary.database.client.prepare('SELECT cursor_json FROM source_connections').get() as {
      cursor_json: string;
    }
  ).cursor_json;
}
