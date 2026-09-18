import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobRunner, JobService } from '@openrepurpose/core';
import {
  SqliteDestinationJobRepository,
  SqliteJobRepository,
  SqliteMediaRepository,
  SqliteMetaCredentialRepository,
} from '@openrepurpose/db';
import { FacebookReelsJobHandler, facebookReelsUploadUriReference } from '@openrepurpose/meta';
import { InMemorySecretStore, createTemporaryDatabase } from '@openrepurpose/testkit';
import type { TemporaryDatabase } from '@openrepurpose/testkit';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

describe('Facebook Page Reels publishing transport', () => {
  let temporary: TemporaryDatabase | undefined;
  afterEach(() => temporary?.dispose());

  it('recovers the documented offset, streams only the remaining bytes, finalizes, and reconciles publication', async () => {
    temporary = createTemporaryDatabase();
    const mediaPath = join(temporary.directory, 'clip.mp4');
    await writeFile(mediaPath, Buffer.alloc(42, 5));
    const media = new SqliteMediaRepository(temporary.database);
    const now = new Date('2026-09-18T10:00:00.000Z');
    media.create({
      createdAt: now,
      fingerprint: 'sha256:facebook-clip',
      id: 'media-1',
      metadata: { durationSeconds: 10, frameRate: 30, hasAudio: true, height: 1920, width: 1080 },
      modifiedAt: now,
      path: mediaPath,
      sizeBytes: 42,
      state: 'available',
    });
    const targets = new SqliteMetaCredentialRepository(temporary.database);
    targets.upsertCredential({
      connectedAt: now,
      displayName: 'Creator',
      externalId: 'person-1',
      id: 'credential-1',
      scopes: ['pages_manage_posts'],
      status: 'connected',
      tokenExpiresAt: new Date(now.getTime() + 86_400_000),
      updatedAt: now,
    });
    targets.upsertTarget({
      availability: 'available',
      credentialId: 'credential-1',
      displayName: 'My Page',
      enabled: true,
      externalId: 'page-1',
      id: 'target-1',
      kind: 'facebook_page',
      pageId: 'page-1',
      updatedAt: now,
    });
    const secrets = new InMemorySecretStore();
    await secrets.set(
      { name: 'meta-page-token', ownerId: 'target-1', scope: 'account' },
      'page-token',
    );
    const uploads: { offset: string | null; received: number }[] = [];
    let uploadCalls = 0;
    let statusCalls = 0;
    let finishCalls = 0;
    const http = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/v26.0/page-1/video_reels') {
        const form = init?.body?.toString() ?? '';
        if (form.includes('upload_phase=start'))
          return json({
            upload_url: 'https://rupload.facebook.com/video-upload/session-1',
            video_id: 'video-1',
          });
        expect(form).toContain('upload_phase=finish');
        expect(form).toContain('video_id=video-1');
        expect(form).toContain('video_state=PUBLISHED');
        finishCalls += 1;
        return json({ success: true });
      }
      if (url.pathname === '/v26.0/video-1') {
        statusCalls += 1;
        if (statusCalls === 1)
          return json({ status: { bytes_transfered: 20, video_status: 'uploading' } });
        return json({
          permalink_url: 'https://facebook.test/reel/1',
          status: { video_status: 'published' },
        });
      }
      if (url.hostname === 'rupload.facebook.com') {
        uploadCalls += 1;
        if (uploadCalls === 1) throw new Error('connection reset');
        let received = 0;
        for await (const part of init?.body as AsyncIterable<Uint8Array>) received += part.length;
        uploads.push({ offset: new Headers(init?.headers).get('offset'), received });
        expect(new Headers(init?.headers).get('authorization')).toBe('OAuth page-token');
        return json({ success: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const checkpoints = new SqliteDestinationJobRepository(temporary.database);
    const jobs = new JobService(new SqliteJobRepository(temporary.database), () => now);
    const job = jobs.create({
      maxAttempts: 3,
      type: 'facebook.reels.publish',
      input: { mediaId: 'media-1', targetId: 'target-1' },
    }).job;
    const runner = new JobRunner(
      new SqliteJobRepository(temporary.database),
      [new FacebookReelsJobHandler(media, checkpoints, targets, secrets, { http, now: () => now })],
      {
        baseRetryDelayMs: 0,
        concurrency: 1,
        maxRetryDelayMs: 60_000,
        now: () => now,
        random: () => 1,
      },
    );

    await runner.runOnce();
    expect(jobs.show(job.id)?.job.status).toBe('retrying');
    await runner.runOnce();
    expect(jobs.show(job.id)?.job.status).toBe('succeeded');
    expect(uploads).toEqual([{ offset: '20', received: 22 }]);
    expect(finishCalls).toBe(1);
    expect(checkpoints.find(job.id)).toMatchObject({
      destinationId: 'facebook',
      remoteId: 'video-1',
      remoteStatus: 'published',
      remoteUrl: 'https://facebook.test/reel/1',
      uploadedBytes: 42,
    });
    expect(await secrets.get(facebookReelsUploadUriReference(job.id))).toBeUndefined();
  });

  it('rejects a video outside Facebook Reels duration limits before a remote session starts', async () => {
    temporary = createTemporaryDatabase();
    const media = new SqliteMediaRepository(temporary.database);
    media.create({
      createdAt: new Date(),
      fingerprint: 'sha256:long',
      id: 'media-long',
      metadata: { durationSeconds: 91, hasAudio: true },
      modifiedAt: new Date(),
      path: join(temporary.directory, 'long.mp4'),
      sizeBytes: 1,
      state: 'available',
    });
    const jobs = new JobService(new SqliteJobRepository(temporary.database));
    const job = jobs.create({
      type: 'facebook.reels.publish',
      input: { mediaId: 'media-long', targetId: 'missing' },
    }).job;
    const runner = new JobRunner(
      new SqliteJobRepository(temporary.database),
      [
        new FacebookReelsJobHandler(
          media,
          new SqliteDestinationJobRepository(temporary.database),
          new SqliteMetaCredentialRepository(temporary.database),
          new InMemorySecretStore(),
        ),
      ],
      { baseRetryDelayMs: 0, maxRetryDelayMs: 0 },
    );
    await runner.runOnce();
    expect(jobs.show(job.id)?.job).toMatchObject({
      lastErrorCode: 'FACEBOOK_REELS_DURATION_INVALID',
      status: 'failed',
    });
  });
});
