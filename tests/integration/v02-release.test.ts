import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobRunner, JobService, WorkflowService } from '@openrepurpose/core';
import {
  SqliteAccountRepository,
  SqliteDestinationJobRepository,
  SqliteJobRepository,
  SqliteMediaRepository,
  SqliteWorkflowRepository,
} from '@openrepurpose/db';
import { InMemorySecretStore, createTemporaryDatabase } from '@openrepurpose/testkit';
import type { TemporaryDatabase } from '@openrepurpose/testkit';
import {
  TikTokDirectPostJobHandler,
  TikTokOAuthService,
  tiktokTokenBundleReference,
} from '@openrepurpose/tiktok';
import type { TikTokHttpClient } from '@openrepurpose/tiktok';
import {
  YouTubeOAuthService,
  YouTubeUploadJobHandler,
  youtubeRefreshTokenReference,
} from '@openrepurpose/youtube';
import type { OAuthHttpClient } from '@openrepurpose/youtube';

const tiktokInit = 'https://tiktok.test/init';
const tiktokCreator = 'https://tiktok.test/creator';
const tiktokStatus = 'https://tiktok.test/status';
const tiktokToken = 'https://tiktok.test/token';
const tiktokUpload = 'https://upload.tiktok.test/signed';
const youtubeUpload = 'https://youtube.test/upload';
const youtubeVideos = 'https://youtube.test/videos';
const youtubeToken = 'https://youtube.test/token';
const chunkSize = 5 * 1024 * 1024;

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
    status,
  });
}

function addAccount(
  database: TemporaryDatabase['database'],
  provider: 'tiktok' | 'youtube',
  id: string,
): void {
  new SqliteAccountRepository(database).upsert({
    capabilities:
      provider === 'tiktok'
        ? ['tiktok.identity.read', 'tiktok.video.publish']
        : ['youtube.identity.read', 'youtube.video.upload'],
    connectedAt: new Date(0),
    displayName: id,
    externalId: id,
    id,
    provider,
    status: 'connected',
    updatedAt: new Date(0),
  });
}

async function addTikTokCredentials(
  secrets: InMemorySecretStore,
  accountId: string,
): Promise<void> {
  await secrets.set(
    tiktokTokenBundleReference(accountId),
    JSON.stringify({
      accessExpiresAt: Date.now() + 86_400_000,
      accessToken: 'tiktok-access-token',
      openId: accountId,
      refreshExpiresAt: Date.now() + 86_400_000,
      refreshToken: 'tiktok-refresh-token',
      scopes: ['user.info.basic', 'video.publish'],
    }),
  );
}

function tiktokHttp(options: {
  readonly privacyOptions?: readonly string[];
  readonly init?: (calls: number) => Response;
  readonly status?: (calls: number) => Response;
  readonly upload?: (range: string, attempt: number) => Response;
}): TikTokHttpClient {
  let initCalls = 0;
  let statusCalls = 0;
  let uploadCalls = 0;
  return async (input, request) => {
    const url = input.toString();
    if (url === tiktokToken)
      return json({
        access_token: 'tiktok-access-token',
        expires_in: 86_400,
        open_id: 'tiktok-account',
        refresh_expires_in: 86_400,
        refresh_token: 'tiktok-refresh-token',
        scope: 'user.info.basic,video.publish',
      });
    if (url === tiktokCreator)
      return json({
        data: {
          comment_disabled: false,
          creator_nickname: 'Test Creator',
          creator_username: 'test_creator',
          duet_disabled: false,
          max_video_post_duration_sec: 600,
          privacy_level_options: options.privacyOptions ?? ['SELF_ONLY'],
          stitch_disabled: false,
        },
        error: { code: 'ok' },
      });
    if (url === tiktokInit) {
      initCalls += 1;
      return (
        options.init?.(initCalls) ??
        json({
          data: { publish_id: 'tiktok-publish', upload_url: tiktokUpload },
          error: { code: 'ok' },
        })
      );
    }
    if (url === tiktokUpload) {
      const body = request?.body;
      if (body !== undefined && body !== null && Symbol.asyncIterator in body)
        for await (const _chunk of body as AsyncIterable<unknown>) void _chunk;
      uploadCalls += 1;
      const range = new Headers(request?.headers).get('content-range') ?? '';
      return options.upload?.(range, uploadCalls) ?? new Response(null, { status: 201 });
    }
    if (url === tiktokStatus) {
      statusCalls += 1;
      return (
        options.status?.(statusCalls) ??
        json({ data: { status: 'PUBLISH_COMPLETE' }, error: { code: 'ok' } })
      );
    }
    throw new Error(`Unexpected TikTok request: ${url}`);
  };
}

function youtubeHttp(status: 'succeeded' | 'failed'): OAuthHttpClient {
  let processingCalls = 0;
  return async (input, request) => {
    const url = input.toString();
    if (url === youtubeToken)
      return json({ access_token: 'youtube-access-token', expires_in: 3600 });
    if (url === `${youtubeUpload}/session`) {
      if (
        request?.body !== undefined &&
        request.body !== null &&
        Symbol.asyncIterator in request.body
      )
        for await (const _chunk of request.body as AsyncIterable<unknown>) void _chunk;
      return json({ id: 'youtube-video' });
    }
    if (url.startsWith(youtubeUpload))
      return new Response(null, {
        headers: { location: `${youtubeUpload}/session` },
        status: 200,
      });
    if (url.startsWith(youtubeVideos)) {
      processingCalls += 1;
      return json({
        items: [
          {
            processingDetails: { processingStatus: processingCalls === 1 ? 'processing' : status },
          },
        ],
      });
    }
    throw new Error(`Unexpected YouTube request: ${url}`);
  };
}

async function createTikTokFixture(
  temporary: TemporaryDatabase,
  path: string,
  sizeBytes: number,
  options: Parameters<typeof tiktokHttp>[0] = {},
) {
  await writeFile(path, Buffer.alloc(sizeBytes, 7));
  const media = new SqliteMediaRepository(temporary.database);
  media.create({
    createdAt: new Date(),
    fingerprint: `sha256:${path}`,
    id: 'media-1',
    metadata: { durationSeconds: 10, hasAudio: true },
    modifiedAt: new Date(),
    path,
    sizeBytes,
    state: 'available',
  });
  addAccount(temporary.database, 'tiktok', 'tiktok-account');
  const secrets = new InMemorySecretStore();
  await addTikTokCredentials(secrets, 'tiktok-account');
  const http = tiktokHttp(options);
  const oauth = new TikTokOAuthService(
    new SqliteAccountRepository(temporary.database),
    { consumeByStateHash: () => undefined, create: () => undefined, deleteExpired: () => [] },
    secrets,
    new URL('http://127.0.0.1:3000'),
    { endpoints: { creatorInfo: tiktokCreator, token: tiktokToken }, http },
  );
  await oauth.configureCredentials({ clientKey: 'test-key', clientSecret: 'test-secret' });
  const checkpoints = new SqliteDestinationJobRepository(temporary.database);
  const jobs = new JobService(new SqliteJobRepository(temporary.database));
  return { checkpoints, http, jobs, media, oauth, secrets };
}

describe('v0.2 release journeys', () => {
  let temporary: TemporaryDatabase | undefined;

  afterEach(() => temporary?.dispose());

  it('keeps unaudited/private-only TikTok accounts from silently accepting public posts', async () => {
    temporary = createTemporaryDatabase();
    const fixture = await createTikTokFixture(
      temporary,
      join(temporary.directory, 'private.mp4'),
      1,
      { privacyOptions: ['SELF_ONLY'] },
    );
    const capabilities = await fixture.oauth.getAccountCapabilities('tiktok-account');
    expect(capabilities.publicPostingAvailability).toBe('unavailable_for_creator');
    expect(capabilities.privacyLevelOptions).toEqual(['SELF_ONLY']);

    const job = fixture.jobs.create({
      maxAttempts: 1,
      type: 'tiktok.direct-post',
      input: {
        accountId: 'tiktok-account',
        mediaId: 'media-1',
        metadata: { privacyLevel: 'PUBLIC_TO_EVERYONE' },
      },
    }).job;
    await new JobRunner(
      new SqliteJobRepository(temporary.database),
      [
        new TikTokDirectPostJobHandler(
          fixture.media,
          fixture.checkpoints,
          fixture.oauth,
          fixture.secrets,
          {
            endpoints: { init: tiktokInit, status: tiktokStatus },
            http: fixture.http,
          },
        ),
      ],
      { concurrency: 1 },
    ).runOnce();

    expect(fixture.jobs.show(job.id)?.job).toMatchObject({
      lastErrorCode: 'TIKTOK_PRIVACY_LEVEL_UNAVAILABLE',
      status: 'failed',
    });
  });

  it('rejects unsupported media format before creating a TikTok post', async () => {
    temporary = createTemporaryDatabase();
    const fixture = await createTikTokFixture(temporary, join(temporary.directory, 'clip.avi'), 1, {
      init: () => {
        throw new Error('init must not be called');
      },
    });
    const job = fixture.jobs.create({
      maxAttempts: 1,
      type: 'tiktok.direct-post',
      input: {
        accountId: 'tiktok-account',
        mediaId: 'media-1',
        metadata: { privacyLevel: 'SELF_ONLY' },
      },
    }).job;
    await new JobRunner(
      new SqliteJobRepository(temporary.database),
      [
        new TikTokDirectPostJobHandler(
          fixture.media,
          fixture.checkpoints,
          fixture.oauth,
          fixture.secrets,
          {
            endpoints: { init: tiktokInit, status: tiktokStatus },
            http: fixture.http,
          },
        ),
      ],
      { concurrency: 1 },
    ).runOnce();
    expect(fixture.jobs.show(job.id)?.job).toMatchObject({
      lastErrorCode: 'TIKTOK_UPLOAD_MEDIA_INVALID',
      status: 'failed',
    });
  });

  it('retries a failed upload chunk without reinitializing the TikTok post', async () => {
    temporary = createTemporaryDatabase();
    let initCalls = 0;
    let secondChunkAttempts = 0;
    const fixture = await createTikTokFixture(
      temporary,
      join(temporary.directory, 'retry.mp4'),
      chunkSize + 1,
      {
        init: () => {
          initCalls += 1;
          return json({
            data: { publish_id: 'retry-publish', upload_url: tiktokUpload },
            error: { code: 'ok' },
          });
        },
        upload: (range) => {
          if (range.startsWith(`bytes ${chunkSize}-`) && secondChunkAttempts++ === 0)
            return new Response(null, { status: 503 });
          return new Response(null, { status: range.startsWith('bytes 0-') ? 206 : 201 });
        },
      },
    );
    const job = fixture.jobs.create({
      maxAttempts: 3,
      type: 'tiktok.direct-post',
      input: {
        accountId: 'tiktok-account',
        mediaId: 'media-1',
        metadata: { privacyLevel: 'SELF_ONLY' },
      },
    }).job;
    const runner = new JobRunner(
      new SqliteJobRepository(temporary.database),
      [
        new TikTokDirectPostJobHandler(
          fixture.media,
          fixture.checkpoints,
          fixture.oauth,
          fixture.secrets,
          {
            chunkSizeBytes: chunkSize,
            endpoints: { init: tiktokInit, status: tiktokStatus },
            http: fixture.http,
          },
        ),
      ],
      { baseRetryDelayMs: 0, concurrency: 1, maxRetryDelayMs: 0 },
    );
    await runner.runOnce();
    expect(fixture.jobs.show(job.id)?.job.status).toBe('retrying');
    expect(fixture.checkpoints.find(job.id)).toMatchObject({
      remoteId: 'retry-publish',
      remoteStatus: 'uploading',
      uploadedBytes: chunkSize,
    });
    await runner.runOnce();
    expect(fixture.jobs.show(job.id)?.job.status).toBe('succeeded');
    expect(initCalls).toBe(1);
  });

  it('persists remote processing failure separately from local upload success', async () => {
    temporary = createTemporaryDatabase();
    const fixture = await createTikTokFixture(
      temporary,
      join(temporary.directory, 'failed-processing.mp4'),
      1,
      {
        status: () =>
          json({
            data: { fail_reason: 'video_format_not_supported', status: 'FAILED' },
            error: { code: 'ok' },
          }),
      },
    );
    const job = fixture.jobs.create({
      maxAttempts: 1,
      type: 'tiktok.direct-post',
      input: {
        accountId: 'tiktok-account',
        mediaId: 'media-1',
        metadata: { privacyLevel: 'SELF_ONLY' },
      },
    }).job;
    await new JobRunner(
      new SqliteJobRepository(temporary.database),
      [
        new TikTokDirectPostJobHandler(
          fixture.media,
          fixture.checkpoints,
          fixture.oauth,
          fixture.secrets,
          {
            endpoints: { init: tiktokInit, status: tiktokStatus },
            http: fixture.http,
          },
        ),
      ],
      { concurrency: 1 },
    ).runOnce();
    expect(fixture.jobs.show(job.id)?.job).toMatchObject({
      lastErrorCode: 'TIKTOK_PUBLISH_FAILED_VIDEO_FORMAT_NOT_SUPPORTED',
      status: 'failed',
    });
    expect(fixture.checkpoints.find(job.id)).toMatchObject({
      remoteId: 'tiktok-publish',
      remoteStatus: 'failed',
      uploadedBytes: 1,
    });
  });

  it('completes YouTube while isolating a TikTok failure in one workflow execution', async () => {
    temporary = createTemporaryDatabase();
    const path = join(temporary.directory, 'fan-out.mp4');
    await writeFile(path, Buffer.alloc(1, 3));
    const media = new SqliteMediaRepository(temporary.database);
    media.create({
      createdAt: new Date(),
      fingerprint: 'sha256:fan-out',
      id: 'media-1',
      metadata: { durationSeconds: 10, hasAudio: true },
      modifiedAt: new Date(),
      path,
      sizeBytes: 1,
      state: 'available',
    });
    addAccount(temporary.database, 'youtube', 'youtube-account');
    addAccount(temporary.database, 'tiktok', 'tiktok-account');
    const secrets = new InMemorySecretStore();
    await addTikTokCredentials(secrets, 'tiktok-account');
    await secrets.set(youtubeRefreshTokenReference('youtube-account'), 'youtube-refresh-token');
    const tiktok = new TikTokOAuthService(
      new SqliteAccountRepository(temporary.database),
      { consumeByStateHash: () => undefined, create: () => undefined, deleteExpired: () => [] },
      secrets,
      new URL('http://127.0.0.1:3000'),
      {
        endpoints: { creatorInfo: tiktokCreator, token: tiktokToken },
        http: tiktokHttp({ privacyOptions: ['SELF_ONLY'] }),
      },
    );
    await tiktok.configureCredentials({ clientKey: 'test-key', clientSecret: 'test-secret' });
    const youtube = new YouTubeOAuthService(
      new SqliteAccountRepository(temporary.database),
      { consumeByStateHash: () => undefined, create: () => undefined, deleteExpired: () => [] },
      secrets,
      new URL('http://127.0.0.1:3000'),
      { endpoints: { token: youtubeToken }, http: youtubeHttp('succeeded') },
    );
    await youtube.configureCredentials({ clientId: 'test-client' });
    const jobs = new JobService(new SqliteJobRepository(temporary.database));
    const workflow = new WorkflowService(
      new SqliteWorkflowRepository(temporary.database),
      jobs,
    ).create({
      destinations: [
        { accountId: 'youtube-account', destinationId: 'youtube', privacy: 'private' },
        {
          accountId: 'tiktok-account',
          destinationId: 'tiktok',
          privacyLevel: 'PUBLIC_TO_EVERYONE',
        },
      ],
      name: 'Release fan-out',
      sourceDirectory: temporary.directory,
      titleTemplate: '{{file.stem}}',
    });
    const execution = new WorkflowService(
      new SqliteWorkflowRepository(temporary.database),
      jobs,
    ).executeWatchedMedia(
      workflow.id,
      media.list().find((asset) => asset.id === 'media-1')!,
    )!;
    expect(execution.destinations.every((destination) => destination.created)).toBe(true);
    const checkpoints = new SqliteDestinationJobRepository(temporary.database);
    const runner = new JobRunner(
      new SqliteJobRepository(temporary.database),
      [
        new YouTubeUploadJobHandler(media, checkpoints, youtube, {
          endpoints: { upload: youtubeUpload, videos: youtubeVideos },
          http: youtubeHttp('succeeded'),
          chunkSizeBytes: 256 * 1024,
        }),
        new TikTokDirectPostJobHandler(media, checkpoints, tiktok, secrets, {
          endpoints: { init: tiktokInit, status: tiktokStatus },
          http: tiktokHttp({ privacyOptions: ['SELF_ONLY'] }),
        }),
      ],
      { baseRetryDelayMs: 0, concurrency: 2, maxRetryDelayMs: 0 },
    );
    await runner.runOnce();
    await runner.runOnce();
    const finalJobs = jobs.list();
    expect(finalJobs.find((job) => job.type === 'youtube.upload')?.status).toBe('succeeded');
    expect(finalJobs.find((job) => job.type === 'tiktok.direct-post')).toMatchObject({
      lastErrorCode: 'TIKTOK_PRIVACY_LEVEL_UNAVAILABLE',
      status: 'failed',
    });
    expect(
      checkpoints.find(finalJobs.find((job) => job.type === 'youtube.upload')!.id),
    ).toMatchObject({
      remoteId: 'youtube-video',
      remoteStatus: 'succeeded',
    });
  });
});
