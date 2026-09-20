import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  JobService,
  MediaImportService,
  TransformService,
  WorkflowTransformService,
  WorkflowService,
  renderTemplate,
  sourceItemMatchesWorkflowFilters,
  validateTemplate,
} from '@openrepurpose/core';
import {
  SqliteAccountRepository,
  SqliteJobRepository,
  SqliteMediaRepository,
  SqliteSourceCursorRepository,
  SqliteWorkflowRepository,
  SqliteTransformDerivativeRepository,
} from '@openrepurpose/db';
import { LocalMediaFileInspector, WatchedFolderRunner } from '@openrepurpose/media';
import { createTemporaryDatabase } from '@openrepurpose/testkit';
import type { TemporaryDatabase } from '@openrepurpose/testkit';

describe('watched-folder workflows', () => {
  let temporary: TemporaryDatabase | undefined;
  afterEach(() => temporary?.dispose());
  it('validates and renders only the documented template variables', () => {
    expect(() => validateTemplate('{{unknown.value}}')).toThrow('Unknown template variable');
    expect(
      renderTemplate('{{file.stem}} — {{workflow.name}} — {{source.title}}', {
        file: { name: 'clip.mp4', stem: 'clip' },
        media: { duration: '4.2' },
        source: {
          title: 'Remote title',
          description: 'Remote description',
          publishedAt: '2026-09-18T00:00:00.000Z',
          externalId: 'video-1',
        },
        workflow: { name: 'Daily' },
      }),
    ).toBe('clip — Daily — Remote title');
    expect(
      sourceItemMatchesWorkflowFilters(
        {
          id: 'item-1',
          sourceConnectionId: 'source-1',
          externalId: 'video-1',
          dedupeKey: 'video-1',
          metadata: { title: 'Weekly Short', durationSeconds: 42, privacyStatus: 'public' },
          publishedAt: new Date('2026-09-18T00:00:00.000Z'),
          firstObservedAt: new Date(0),
          lastObservedAt: new Date(0),
          updatedAt: new Date(0),
        },
        {
          titleContains: 'weekly',
          titleRegex: 'Short$',
          durationSecondsMax: 60,
          privacyStatuses: ['public'],
          publishedAfter: '2026-09-17T00:00:00.000Z',
        },
      ),
    ).toBe(true);
  });
  it('settles a growing file, imports once, and snapshots workflow metadata into the existing upload job', async () => {
    temporary = createTemporaryDatabase();
    const database = temporary.database;
    new SqliteAccountRepository(database).upsert({
      id: 'account-1',
      provider: 'youtube',
      externalId: 'channel',
      displayName: 'Channel',
      status: 'connected',
      capabilities: ['youtube.video.upload'],
      connectedAt: new Date(0),
      updatedAt: new Date(0),
    });
    let now = 1_000;
    const jobs = new JobService(new SqliteJobRepository(database), () => new Date(now));
    const workflows = new WorkflowService(
      new SqliteWorkflowRepository(database),
      jobs,
      () => new Date(now),
    );
    const directory = join(temporary.directory, 'OBS renders');
    mkdirSync(directory);
    const file = join(directory, 'episode one.mp4');
    writeFileSync(file, 'first');
    const workflow = workflows.create({
      name: 'Daily upload',
      sourceDirectory: directory,
      accountId: 'account-1',
      titleTemplate: '{{file.stem}} / {{workflow.name}}',
      descriptionTemplate: '{{media.duration}} seconds',
      privacy: 'unlisted',
    });
    const importer = new MediaImportService(
      new LocalMediaFileInspector(),
      { probe: async () => ({ hasAudio: true, durationSeconds: 7 }) },
      new SqliteMediaRepository(database),
    );
    const runner = new WatchedFolderRunner(
      workflows,
      new SqliteSourceCursorRepository(database),
      importer,
      { now: () => new Date(now), settleMs: 100, pollIntervalMs: 100 },
    );
    await runner.scan();
    expect(jobs.list()).toHaveLength(0);
    writeFileSync(file, 'still growing');
    now += 50;
    await runner.scan();
    now += 101;
    await runner.scan();
    const [job] = jobs.list();
    expect(job?.type).toBe('youtube.upload');
    expect(job?.input).toMatchObject({
      accountId: 'account-1',
      metadata: {
        title: 'episode one / Daily upload',
        description: '7 seconds',
        privacy: 'unlisted',
      },
      workflow: { id: workflow.id, name: 'Daily upload' },
    });
    await runner.scan();
    expect(jobs.list()).toHaveLength(1);
    workflows.update(workflow.id, {
      name: 'Changed',
      sourceDirectory: directory,
      accountId: 'account-1',
      titleTemplate: 'changed',
      descriptionTemplate: '',
      privacy: 'private',
    });
    expect(job?.input).toMatchObject({
      metadata: { title: 'episode one / Daily upload', privacy: 'unlisted' },
    });
  });

  it('persists destination configuration and creates one idempotent job per destination', () => {
    temporary = createTemporaryDatabase();
    const database = temporary.database;
    const accounts = new SqliteAccountRepository(database);
    accounts.upsert({
      id: 'youtube-account',
      provider: 'youtube',
      externalId: 'youtube-channel',
      displayName: 'YouTube Creator',
      status: 'connected',
      capabilities: ['youtube.video.upload'],
      connectedAt: new Date(0),
      updatedAt: new Date(0),
    });
    accounts.upsert({
      id: 'tiktok-account',
      provider: 'tiktok',
      externalId: 'tiktok-creator',
      displayName: 'TikTok Creator',
      status: 'connected',
      capabilities: ['tiktok.video.publish'],
      connectedAt: new Date(0),
      updatedAt: new Date(0),
    });
    const jobs = new JobService(new SqliteJobRepository(database), () => new Date(1_000));
    const repository = new SqliteWorkflowRepository(database);
    const workflows = new WorkflowService(repository, jobs, () => new Date(1_000));
    const workflow = workflows.create({
      name: 'Both destinations',
      sourceDirectory: 'C:\\Media',
      titleTemplate: '{{file.stem}}',
      descriptionTemplate: 'Published by {{workflow.name}}',
      destinations: [
        {
          destinationId: 'youtube',
          accountId: 'youtube-account',
          privacy: 'unlisted',
          category: '22',
        },
        {
          destinationId: 'tiktok',
          accountId: 'tiktok-account',
          privacyLevel: 'SELF_ONLY',
          captionTemplate: '{{file.stem}} on TikTok',
          disableDuet: true,
        },
      ],
    });
    const media = {
      id: 'media-1',
      path: 'C:\\Media\\clip.mp4',
      fingerprint: 'sha256:clip',
      sizeBytes: 10,
      modifiedAt: new Date(0),
      createdAt: new Date(0),
      state: 'available' as const,
      metadata: { hasAudio: true },
    };

    expect(repository.findById(workflow.id)).toMatchObject({
      failurePolicy: 'best_effort',
      destinations: workflow.destinations,
    });
    const first = workflows.executeWatchedMedia(workflow.id, media);
    const repeated = workflows.executeWatchedMedia(workflow.id, media);

    expect(first).toMatchObject({
      failurePolicy: 'best_effort',
      destinations: [
        { destinationId: 'youtube', created: true },
        { destinationId: 'tiktok', created: true },
      ],
    });
    expect(
      repeated?.destinations.map(({ destinationId, created }) => ({ destinationId, created })),
    ).toEqual([
      { destinationId: 'youtube', created: false },
      { destinationId: 'tiktok', created: false },
    ]);
    expect(jobs.list()).toHaveLength(2);
    expect(jobs.list().find((job) => job.type === 'youtube.upload')?.input).toMatchObject({
      accountId: 'youtube-account',
      metadata: { category: '22', privacy: 'unlisted', title: 'clip' },
    });
    expect(jobs.list().find((job) => job.type === 'tiktok.direct-post')?.input).toMatchObject({
      accountId: 'tiktok-account',
      metadata: { caption: 'clip on TikTok', disableDuet: true, privacyLevel: 'SELF_ONLY' },
    });
  });

  it('stores exact Meta target IDs and fans out to the corresponding Reel job types', () => {
    temporary = createTemporaryDatabase();
    const database = temporary.database;
    const jobs = new JobService(new SqliteJobRepository(database), () => new Date(1_000));
    const workflows = new WorkflowService(
      new SqliteWorkflowRepository(database),
      jobs,
      () => new Date(1_000),
    );
    const workflow = workflows.create({
      name: 'Meta targets',
      sourceDirectory: 'C:\\Media',
      titleTemplate: '{{file.stem}}',
      destinations: [
        { destinationId: 'instagram', accountId: 'instagram-target-1', shareToFeed: true },
        { destinationId: 'facebook', accountId: 'facebook-page-2' },
      ],
    });
    const media = {
      id: 'media-meta',
      path: 'C:\\Media\\clip.mp4',
      fingerprint: 'sha256:meta',
      sizeBytes: 10,
      modifiedAt: new Date(0),
      createdAt: new Date(0),
      state: 'available' as const,
      metadata: { hasAudio: true },
    };

    expect(workflows.executeWatchedMedia(workflow.id, media)?.destinations).toEqual([
      expect.objectContaining({ destinationId: 'instagram', created: true }),
      expect.objectContaining({ destinationId: 'facebook', created: true }),
    ]);
    expect(jobs.list().map((job) => [job.type, job.input])).toEqual(
      expect.arrayContaining([
        ['instagram.reels.publish', expect.objectContaining({ targetId: 'instagram-target-1' })],
        ['facebook.reels.publish', expect.objectContaining({ targetId: 'facebook-page-2' })],
      ]),
    );
    expect(new SqliteWorkflowRepository(database).findById(workflow.id)?.destinations).toEqual(
      workflow.destinations,
    );
  });

  it('rejects rollback semantics because remote publishes cannot be made atomic', () => {
    temporary = createTemporaryDatabase();
    const workflows = new WorkflowService(
      new SqliteWorkflowRepository(temporary.database),
      new JobService(new SqliteJobRepository(temporary.database)),
    );
    expect(() =>
      workflows.create({
        name: 'Unsupported policy',
        sourceDirectory: 'C:\\Media',
        titleTemplate: '{{file.stem}}',
        accountId: 'youtube-account',
        failurePolicy: 'all_or_nothing' as never,
      }),
    ).toThrow('Only best-effort destination execution is supported.');
  });

  it('fans compatible destinations out from one transform prerequisite and derivative', () => {
    temporary = createTemporaryDatabase();
    const database = temporary.database;
    const jobs = new JobService(new SqliteJobRepository(database), () => new Date(1_000));
    const workflows = new WorkflowService(
      new SqliteWorkflowRepository(database),
      jobs,
      () => new Date(1_000),
      new WorkflowTransformService(
        new SqliteTransformDerivativeRepository(database),
        jobs,
        { encoder: 'libx264', ffmpegVersion: 'test-ffmpeg' },
        () => new Date(1_000),
      ),
    );
    const workflow = workflows.create({
      name: 'Vertical everywhere',
      sourceDirectory: 'C:\\Media',
      titleTemplate: '{{file.stem}}',
      destinations: [
        { destinationId: 'youtube', accountId: 'youtube-1', privacy: 'private' },
        { destinationId: 'tiktok', accountId: 'tiktok-1', privacyLevel: 'SELF_ONLY' },
      ],
      definition: {
        schemaVersion: 1,
        steps: [
          { id: 'source', kind: 'source', sourceType: 'watched_folder' },
          {
            id: 'vertical',
            kind: 'transform',
            plan: { user: { steps: [{ type: 'fit', mode: 'crop', width: 1080, height: 1920 }] } },
          },
          {
            id: 'youtube',
            kind: 'destination',
            destination: { destinationId: 'youtube', accountId: 'youtube-1', privacy: 'private' },
          },
          {
            id: 'tiktok',
            kind: 'destination',
            destination: {
              destinationId: 'tiktok',
              accountId: 'tiktok-1',
              privacyLevel: 'SELF_ONLY',
            },
          },
        ],
        edges: [
          { from: 'source', to: 'vertical' },
          { from: 'vertical', to: 'youtube' },
          { from: 'vertical', to: 'tiktok' },
        ],
      },
    });
    const media = {
      id: 'media-1',
      path: 'C:\\Media\\clip.mp4',
      fingerprint: 'sha256:clip',
      sizeBytes: 10,
      modifiedAt: new Date(0),
      createdAt: new Date(0),
      state: 'available',
      metadata: { hasAudio: true },
    } as const;
    new SqliteMediaRepository(database).create(media);
    workflows.executeWatchedMedia(workflow.id, media);
    const queued = jobs.list();
    const transform = queued.find((job) => job.type === 'media.transform');
    const publishes = queued.filter((job) => job.type !== 'media.transform');
    expect(transform).toBeDefined();
    expect(publishes).toHaveLength(2);
    expect(publishes.map((job) => job.dependsOnJobId)).toEqual([transform?.id, transform?.id]);
    expect(new Set(publishes.map((job) => (job.input as { mediaId: string }).mediaId)).size).toBe(
      1,
    );
  });

  it('uses the shared transform service for direct runs, inspection, and pending cancellation', () => {
    temporary = createTemporaryDatabase();
    const database = temporary.database;
    const media = new SqliteMediaRepository(database);
    media.create({
      id: 'media-direct',
      path: 'C:\\Media\\direct.mp4',
      fingerprint: 'sha256:direct',
      sizeBytes: 20,
      modifiedAt: new Date(0),
      createdAt: new Date(0),
      state: 'available',
      metadata: { hasAudio: true },
    });
    const derivatives = new SqliteTransformDerivativeRepository(database);
    const jobs = new JobService(new SqliteJobRepository(database), () => new Date(2_000));
    const transforms = new TransformService(
      media,
      derivatives,
      jobs,
      { encoder: 'libx264', ffmpegVersion: 'test-ffmpeg' },
      () => new Date(2_000),
    );

    const run = transforms.run('media-direct', {
      user: { steps: [{ type: 'fit', mode: 'crop', width: 1080, height: 1920 }] },
    });

    expect(run).toMatchObject({
      cached: false,
      derivative: { status: 'pending' },
      job: { status: 'pending', type: 'media.transform' },
    });
    expect(transforms.inspect(run.derivative.id)?.provenance.normalizedPlan.user.steps).toEqual([
      { type: 'fit', mode: 'crop', width: 1080, height: 1920, anchor: 'center' },
    ]);
    expect(transforms.forJob(run.job!)?.id).toBe(run.derivative.id);

    expect(transforms.cancelJob(run.job!.id)?.status).toBe('cancelled');
    expect(transforms.inspect(run.derivative.id)?.status).toBe('cancelled');
  });
});
