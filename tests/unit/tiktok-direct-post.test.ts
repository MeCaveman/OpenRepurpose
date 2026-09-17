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
  TikTokDirectPostJobHandler,
  TikTokOAuthService,
  tiktokTokenBundleReference,
  tiktokUploadUrlReference,
} from '@openrepurpose/tiktok';
import type { TikTokHttpClient } from '@openrepurpose/tiktok';

const chunkSize = 5 * 1024 * 1024;
const initEndpoint = 'https://tiktok.test/init';
const creatorEndpoint = 'https://tiktok.test/creator';
const statusEndpoint = 'https://tiktok.test/status';
const tokenEndpoint = 'https://tiktok.test/token';
const uploadUrl = 'https://upload.tiktok.test/signed?opaque=secret';

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
    status,
  });
}

describe('TikTok Direct Post transport', () => {
  let temporary: TemporaryDatabase | undefined;

  afterEach(() => temporary?.dispose());

  it('streams sequential chunks, retries only the unacknowledged chunk, and polls the publish ID', async () => {
    temporary = createTemporaryDatabase();
    const mediaPath = join(temporary.directory, 'clip.mp4');
    const size = chunkSize + 123;
    await writeFile(mediaPath, Buffer.alloc(size, 3));
    const media = new SqliteMediaRepository(temporary.database);
    media.create({
      createdAt: new Date(),
      fingerprint: 'sha256:clip',
      id: 'media-1',
      metadata: { durationSeconds: 10, hasAudio: true },
      modifiedAt: new Date(),
      path: mediaPath,
      sizeBytes: size,
      state: 'available',
    });
    const accounts = new SqliteAccountRepository(temporary.database);
    accounts.upsert({
      capabilities: ['tiktok.identity.read', 'tiktok.video.publish'],
      connectedAt: new Date(),
      displayName: 'Creator',
      externalId: 'creator-open-id',
      id: 'account-1',
      provider: 'tiktok',
      status: 'connected',
      updatedAt: new Date(),
    });
    const secrets = new InMemorySecretStore();
    await secrets.set(
      tiktokTokenBundleReference('account-1'),
      JSON.stringify({
        accessExpiresAt: Date.now() + 86_400_000,
        accessToken: 'access-token',
        openId: 'creator-open-id',
        refreshExpiresAt: Date.now() + 86_400_000,
        refreshToken: 'refresh-token',
        scopes: ['user.info.basic', 'video.publish'],
      }),
    );
    const uploadRanges: string[] = [];
    const bodyWasStream: boolean[] = [];
    let initCalls = 0;
    let statusCalls = 0;
    let secondChunkAttempts = 0;
    const http: TikTokHttpClient = async (input, init) => {
      const url = input.toString();
      if (url === tokenEndpoint)
        return json({
          access_token: 'fresh-token',
          expires_in: 86_400,
          open_id: 'creator-open-id',
          refresh_expires_in: 86_400,
          refresh_token: 'rotated-token',
          scope: 'user.info.basic,video.publish',
        });
      if (url === creatorEndpoint)
        return json({
          data: {
            comment_disabled: false,
            creator_nickname: 'Creator',
            creator_username: 'creator',
            duet_disabled: false,
            max_video_post_duration_sec: 600,
            privacy_level_options: ['SELF_ONLY'],
            stitch_disabled: false,
          },
          error: { code: 'ok' },
        });
      if (url === initEndpoint) {
        initCalls += 1;
        expect(init?.body).toBeTypeOf('string');
        expect(JSON.parse(init?.body as string)).toMatchObject({
          post_info: { privacy_level: 'SELF_ONLY', title: 'A streamed clip' },
          source_info: {
            chunk_size: chunkSize,
            source: 'FILE_UPLOAD',
            total_chunk_count: 2,
            video_size: size,
          },
        });
        return json({
          data: { publish_id: 'publish-1', upload_url: uploadUrl },
          error: { code: 'ok' },
        });
      }
      if (url === uploadUrl) {
        const body = init?.body;
        bodyWasStream.push(body !== null && body !== undefined && Symbol.asyncIterator in body);
        if (body !== null && body !== undefined && Symbol.asyncIterator in body) {
          for await (const _part of body as AsyncIterable<unknown>) void _part;
        }
        const range = new Headers(init?.headers).get('content-range')!;
        uploadRanges.push(range);
        if (range === `bytes ${chunkSize}-${size - 1}/${size}` && secondChunkAttempts++ === 0)
          return new Response(null, { status: 503 });
        return new Response(null, { status: range.startsWith('bytes 0-') ? 206 : 201 });
      }
      if (url === statusEndpoint) {
        statusCalls += 1;
        return json({
          data: { status: statusCalls === 1 ? 'PROCESSING_UPLOAD' : 'PUBLISH_COMPLETE' },
          error: { code: 'ok' },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const oauth = new TikTokOAuthService(
      accounts,
      { consumeByStateHash: () => undefined, create: () => undefined, deleteExpired: () => [] },
      secrets,
      new URL('http://127.0.0.1:3000'),
      { endpoints: { creatorInfo: creatorEndpoint, token: tokenEndpoint }, http },
    );
    await oauth.configureCredentials({ clientKey: 'key', clientSecret: 'secret' });
    const checkpoints = new SqliteDestinationJobRepository(temporary.database);
    const jobs = new JobService(new SqliteJobRepository(temporary.database));
    const created = jobs.create({
      maxAttempts: 5,
      type: 'tiktok.direct-post',
      input: {
        accountId: 'account-1',
        mediaId: 'media-1',
        metadata: { caption: 'A streamed clip', disableComment: false, privacyLevel: 'SELF_ONLY' },
      },
    }).job;
    const runner = new JobRunner(
      new SqliteJobRepository(temporary.database),
      [
        new TikTokDirectPostJobHandler(media, checkpoints, oauth, secrets, {
          chunkSizeBytes: chunkSize,
          endpoints: { init: initEndpoint, status: statusEndpoint },
          http,
        }),
      ],
      { baseRetryDelayMs: 0, concurrency: 1, maxRetryDelayMs: 0, random: () => 1 },
    );

    await runner.runOnce();
    expect(checkpoints.find(created.id)).toMatchObject({
      remoteId: 'publish-1',
      remoteStatus: 'uploading',
      uploadedBytes: chunkSize,
    });
    expect(await secrets.get(tiktokUploadUrlReference(created.id))).toContain(uploadUrl);
    expect(JSON.stringify(checkpoints.find(created.id))).not.toContain(uploadUrl);
    expect(initCalls).toBe(1);

    await runner.runOnce();
    expect(checkpoints.find(created.id)).toMatchObject({
      remoteStatus: 'processing',
      uploadedBytes: size,
    });
    expect(await secrets.get(tiktokUploadUrlReference(created.id))).toBeUndefined();

    await runner.runOnce();
    expect(jobs.show(created.id)?.job.status).toBe('succeeded');
    expect(checkpoints.find(created.id)).toMatchObject({
      remoteId: 'publish-1',
      remoteStatus: 'published',
    });
    expect(uploadRanges).toEqual([
      `bytes 0-${chunkSize - 1}/${size}`,
      `bytes ${chunkSize}-${size - 1}/${size}`,
      `bytes ${chunkSize}-${size - 1}/${size}`,
    ]);
    expect(bodyWasStream).toEqual([true, true, true]);
    expect(initCalls).toBe(1);

    const recovered = jobs.create({
      maxAttempts: 1,
      type: 'tiktok.direct-post',
      input: {
        accountId: 'account-1',
        mediaId: 'media-1',
        metadata: { privacyLevel: 'SELF_ONLY' },
      },
    }).job;
    checkpoints.save({
      destinationId: 'tiktok',
      jobId: recovered.id,
      remoteId: 'publish-existing',
      remoteStatus: 'uploading',
      updatedAt: new Date(),
      uploadedBytes: 0,
    });
    await runner.runOnce();
    expect(jobs.show(recovered.id)?.job).toMatchObject({
      lastErrorCode: 'TIKTOK_UPLOAD_RECOVERY_AMBIGUOUS',
      status: 'failed',
    });
    expect(initCalls).toBe(1);
  });
});
