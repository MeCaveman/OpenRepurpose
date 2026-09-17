import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobRunner, JobService } from '@openrepurpose/core';
import {
  SqliteAccountRepository,
  SqliteDestinationJobRepository,
  SqliteJobRepository,
  SqliteMediaRepository,
} from '@openrepurpose/db';
import { InMemorySecretStore, createTemporaryDatabase } from '@openrepurpose/testkit';
import type { TemporaryDatabase } from '@openrepurpose/testkit';
import {
  YouTubeOAuthService,
  YouTubeUploadJobHandler,
  youtubeRefreshTokenReference,
} from '@openrepurpose/youtube';
import type { OAuthHttpClient } from '@openrepurpose/youtube';

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
    status,
  });
}

describe('YouTube resumable upload job', () => {
  let temporary: TemporaryDatabase | undefined;

  afterEach(() => temporary?.dispose());

  it('persists a resumable session, resumes after restart, and polls the owner processing status without a duplicate insert', async () => {
    temporary = createTemporaryDatabase();
    const mediaPath = join(temporary.directory, 'clip.mp4');
    const size = 256 * 1024 + 1;
    await writeFile(mediaPath, Buffer.alloc(size, 7));
    const media = new SqliteMediaRepository(temporary.database);
    media.create({
      id: 'media-1',
      path: mediaPath,
      fingerprint: 'sha256:test',
      sizeBytes: size,
      modifiedAt: new Date('2026-09-17T10:00:00.000Z'),
      createdAt: new Date('2026-09-17T10:00:00.000Z'),
      state: 'available',
      metadata: { hasAudio: true },
    });
    const accounts = new SqliteAccountRepository(temporary.database);
    accounts.upsert({
      id: 'account-1',
      provider: 'youtube',
      externalId: 'UC-owner',
      displayName: 'Owner',
      status: 'connected',
      capabilities: ['youtube.identity.read', 'youtube.video.upload'],
      connectedAt: new Date(),
      updatedAt: new Date(),
    });
    const secrets = new InMemorySecretStore();
    const sessionUrl = 'https://upload.test/session-1';
    let inserts = 0;
    let uploadPuts = 0;
    let statusQueries = 0;
    const http: OAuthHttpClient = async (input, init) => {
      const url = input.toString();
      if (url === 'https://oauth.test/token')
        return response({ access_token: 'access-token', expires_in: 3600 });
      if (url.startsWith('https://upload.test/videos')) {
        inserts += 1;
        return new Response(null, { headers: { location: sessionUrl }, status: 200 });
      }
      if (url === sessionUrl) {
        const range = new Headers(init?.headers).get('content-range');
        if (range === `bytes */${size}`)
          return new Response(null, { headers: { range: 'bytes=0-262143' }, status: 308 });
        if (init?.body !== null && init?.body !== undefined && Symbol.asyncIterator in init.body) {
          for await (const _chunk of init.body as AsyncIterable<unknown>) {
            // Consume the streamed request body just as fetch would in production.
            void _chunk;
          }
        }
        uploadPuts += 1;
        if (uploadPuts === 1)
          return new Response(null, { headers: { range: 'bytes=0-262143' }, status: 308 });
        if (uploadPuts === 2) throw new TypeError('simulated interrupted connection');
        return response({ id: 'yt-video-1' });
      }
      if (url.startsWith('https://youtube.test/videos')) {
        statusQueries += 1;
        return response({
          items: [
            {
              processingDetails: {
                processingStatus: statusQueries === 1 ? 'processing' : 'succeeded',
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const oauth = new YouTubeOAuthService(
      accounts,
      { consumeByStateHash: () => undefined, create: () => undefined, deleteExpired: () => [] },
      secrets,
      new URL('http://127.0.0.1:3000'),
      {
        endpoints: { token: 'https://oauth.test/token' },
        http,
      },
    );
    await oauth.configureCredentials({ clientId: 'client-id' });
    await secrets.set(youtubeRefreshTokenReference('account-1'), 'refresh-token');
    const checkpoints = new SqliteDestinationJobRepository(temporary.database);
    const jobs = new JobService(new SqliteJobRepository(temporary.database));
    const created = jobs.create({
      type: 'youtube.upload',
      maxAttempts: 5,
      input: {
        accountId: 'account-1',
        mediaId: 'media-1',
        metadata: { title: 'A safe test upload', privacy: 'private' },
      },
    }).job;
    const makeRunner = () =>
      new JobRunner(
        new SqliteJobRepository(temporary!.database),
        [
          new YouTubeUploadJobHandler(media, checkpoints, oauth, {
            endpoints: {
              upload: 'https://upload.test/videos',
              videos: 'https://youtube.test/videos',
            },
            http,
            chunkSizeBytes: 256 * 1024,
          }),
        ],
        { baseRetryDelayMs: 0, maxRetryDelayMs: 0, random: () => 1, concurrency: 1 },
      );

    await makeRunner().runOnce();
    expect(checkpoints.find(created.id)).toMatchObject({
      resumableSessionUrl: sessionUrl,
      uploadedBytes: 262144,
    });
    expect(inserts).toBe(1);

    await makeRunner().runOnce();
    expect(checkpoints.find(created.id)).toMatchObject({
      remoteId: 'yt-video-1',
      remoteStatus: 'processing',
      uploadedBytes: size,
    });
    expect(inserts).toBe(1);

    await makeRunner().runOnce();
    expect(jobs.show(created.id)?.job.status).toBe('succeeded');
    expect(checkpoints.find(created.id)).toMatchObject({
      remoteId: 'yt-video-1',
      remoteStatus: 'succeeded',
    });
    expect(inserts).toBe(1);
  });
});
