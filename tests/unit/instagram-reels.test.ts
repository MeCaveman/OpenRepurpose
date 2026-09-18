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
import { InstagramReelsJobHandler, instagramUploadUriReference } from '@openrepurpose/meta';
import { InMemorySecretStore, createTemporaryDatabase } from '@openrepurpose/testkit';
import type { TemporaryDatabase } from '@openrepurpose/testkit';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

describe('Instagram Reels resumable publishing transport', () => {
  let temporary: TemporaryDatabase | undefined;
  afterEach(() => temporary?.dispose());

  it('streams a local file to Meta, checkpoints the container, polls it, and publishes once', async () => {
    temporary = createTemporaryDatabase();
    const mediaPath = join(temporary.directory, 'clip.mp4');
    await writeFile(mediaPath, Buffer.alloc(42, 5));
    const media = new SqliteMediaRepository(temporary.database);
    media.create({
      createdAt: new Date(),
      fingerprint: 'sha256:instagram-clip',
      id: 'media-1',
      metadata: { durationSeconds: 10, frameRate: 30, hasAudio: true, width: 1080 },
      modifiedAt: new Date(),
      path: mediaPath,
      sizeBytes: 42,
      state: 'available',
    });
    const targets = new SqliteMetaCredentialRepository(temporary.database);
    let clock = new Date('2026-09-18T10:00:00.000Z');
    const now = clock;
    targets.upsertCredential({
      connectedAt: now,
      displayName: 'Creator',
      externalId: 'person-1',
      id: 'credential-1',
      scopes: ['instagram_basic', 'instagram_content_publish'],
      status: 'connected',
      tokenExpiresAt: new Date(now.getTime() + 86_400_000),
      updatedAt: now,
    });
    targets.upsertTarget({
      availability: 'available',
      credentialId: 'credential-1',
      displayName: '@creator',
      enabled: true,
      externalId: 'ig-1',
      id: 'target-1',
      kind: 'instagram_professional',
      pageId: 'page-1',
      updatedAt: now,
    });
    const secrets = new InMemorySecretStore();
    await secrets.set(
      { name: 'meta-page-token', ownerId: 'target-1', scope: 'account' },
      'page-token',
    );
    const uploads: { bodyIsStream: boolean; fileSize: string | null; offset: string | null }[] = [];
    let statusCalls = 0;
    let publishCalls = 0;
    const http = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/v26.0/ig-1/media') {
        expect(init?.method).toBe('POST');
        expect(init?.body?.toString()).toContain('media_type=REELS');
        expect(init?.body?.toString()).toContain('upload_type=resumable');
        return json({
          id: 'container-1',
          uri: 'https://rupload.facebook.com/ig-api-upload/container-1',
        });
      }
      if (url.hostname === 'rupload.facebook.com') {
        const body = init?.body;
        const bodyIsStream = body !== null && body !== undefined && Symbol.asyncIterator in body;
        if (bodyIsStream) for await (const _part of body as AsyncIterable<unknown>) void _part;
        const headers = new Headers(init?.headers);
        uploads.push({
          bodyIsStream,
          fileSize: headers.get('file_size'),
          offset: headers.get('offset'),
        });
        expect(headers.get('authorization')).toBe('OAuth page-token');
        return json({ success: true });
      }
      if (url.pathname === '/v26.0/container-1') {
        statusCalls += 1;
        return json({ status_code: statusCalls === 1 ? 'IN_PROGRESS' : 'FINISHED' });
      }
      if (url.pathname === '/v26.0/ig-1/media_publish') {
        publishCalls += 1;
        expect(init?.body?.toString()).toContain('creation_id=container-1');
        return json({ id: 'published-1' });
      }
      if (url.pathname === '/v26.0/published-1')
        return json({ permalink: 'https://instagram.test/reel/1' });
      throw new Error(`Unexpected request: ${url}`);
    };
    const checkpoints = new SqliteDestinationJobRepository(temporary.database);
    const jobs = new JobService(new SqliteJobRepository(temporary.database), () => clock);
    const created = jobs.create({
      maxAttempts: 3,
      type: 'instagram.reels.publish',
      input: { mediaId: 'media-1', metadata: { caption: 'A local Reel' }, targetId: 'target-1' },
    }).job;
    const runner = new JobRunner(
      new SqliteJobRepository(temporary.database),
      [
        new InstagramReelsJobHandler(media, checkpoints, targets, secrets, {
          http,
          now: () => clock,
        }),
      ],
      {
        baseRetryDelayMs: 0,
        concurrency: 1,
        maxRetryDelayMs: 60_000,
        now: () => clock,
        random: () => 1,
      },
    );

    await runner.runOnce();
    expect(checkpoints.find(created.id)).toMatchObject({
      destinationId: 'instagram',
      remoteId: 'container-1',
      remoteStatus: 'remote_processing',
      uploadedBytes: 42,
    });
    expect(await secrets.get(instagramUploadUriReference(created.id))).toBeUndefined();
    expect(JSON.stringify(checkpoints.find(created.id))).not.toContain('page-token');

    clock = new Date(clock.getTime() + 60_000);
    await runner.runOnce();
    expect(jobs.show(created.id)?.job.status).toBe('succeeded');
    expect(checkpoints.find(created.id)).toMatchObject({
      remoteId: 'published-1',
      remoteStatus: 'published',
      remoteUrl: 'https://instagram.test/reel/1',
    });
    expect(uploads).toEqual([{ bodyIsStream: true, fileSize: '42', offset: '0' }]);
    expect(publishCalls).toBe(1);
  });

  it('reports a typed validation error before creating a remote container', async () => {
    temporary = createTemporaryDatabase();
    const media = new SqliteMediaRepository(temporary.database);
    media.create({
      createdAt: new Date(),
      fingerprint: 'sha256:too-short',
      id: 'media-short',
      metadata: { durationSeconds: 2, hasAudio: true },
      modifiedAt: new Date(),
      path: join(temporary.directory, 'short.mp4'),
      sizeBytes: 1,
      state: 'available',
    });
    const jobs = new JobService(new SqliteJobRepository(temporary.database));
    const created = jobs.create({
      type: 'instagram.reels.publish',
      input: { mediaId: 'media-short', targetId: 'missing-target' },
    }).job;
    const runner = new JobRunner(
      new SqliteJobRepository(temporary.database),
      [
        new InstagramReelsJobHandler(
          media,
          new SqliteDestinationJobRepository(temporary.database),
          new SqliteMetaCredentialRepository(temporary.database),
          new InMemorySecretStore(),
        ),
      ],
      { baseRetryDelayMs: 0, maxRetryDelayMs: 0 },
    );
    await runner.runOnce();
    expect(jobs.show(created.id)?.job).toMatchObject({
      lastErrorCode: 'INSTAGRAM_REELS_DURATION_INVALID',
      status: 'failed',
    });
  });
});
