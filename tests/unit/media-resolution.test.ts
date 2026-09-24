import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ExternalDownloaderError,
  ExternalDownloaderMediaResolver,
  ExternalDownloaderRegistry,
  MediaImportService,
  MediaResolutionError,
  MediaResolutionService,
  RegisteredLocalOriginalMatcher,
  SourceMediaCleanupService,
  retentionCleanupAt,
  type MediaProbe,
  type MediaResolver,
  type RemoteSourceItem,
} from '@openrepurpose/core';
import { SqliteMediaRepository, SqliteSourceMediaResolutionRepository } from '@openrepurpose/db';
import { LocalManagedTemporaryStorage, LocalMediaFileInspector } from '@openrepurpose/media';
import { createTemporaryDatabase, type TemporaryDatabase } from '@openrepurpose/testkit';

const now = new Date('2026-09-18T10:00:00.000Z');

function seedSourceAndExecution(temporary: TemporaryDatabase): RemoteSourceItem {
  const client = temporary.database.client;
  client
    .prepare(
      `INSERT INTO source_connections (
        id, adapter_id, external_source_id, display_name, configuration_json, status,
        consecutive_poll_failures, created_at, updated_at
      ) VALUES ('source-1', 'mock', 'channel-1', 'Channel', '{}', 'active', 0, ?, ?)`,
    )
    .run(now.getTime(), now.getTime());
  const media = {
    availability: 'available',
    resolutionStrategies: ['local_original', 'official_download'],
    rightsRequirement: 'connection_authorization',
  } as const;
  client
    .prepare(
      `INSERT INTO source_items (
        id, source_connection_id, external_id, dedupe_key, first_observed_at, last_observed_at,
        metadata_json, media_descriptor_json, lifecycle_status, resolution_status, updated_at
      ) VALUES ('item-1', 'source-1', 'remote-1', 'remote-1', ?, ?, '{}', ?, 'queued',
        'unresolved', ?)`,
    )
    .run(now.getTime(), now.getTime(), JSON.stringify(media), now.getTime());
  client
    .prepare(
      `INSERT INTO source_workflow_executions (
        id, source_item_id, workflow_key, workflow_version, status, snapshot_json,
        retention_policy, cleanup_status, created_at, updated_at
      ) VALUES ('execution-1', 'item-1', 'workflow-1', 'version-1', 'pending', '{}',
        'delete_after_success', 'not_eligible', ?, ?)`,
    )
    .run(now.getTime(), now.getTime());
  return {
    id: 'item-1',
    sourceConnectionId: 'source-1',
    externalId: 'remote-1',
    dedupeKey: 'remote-1',
    metadata: {},
    media,
    firstObservedAt: now,
    lastObservedAt: now,
    updatedAt: now,
  };
}

function services(
  temporary: TemporaryDatabase,
  resolvers: readonly MediaResolver[],
  probe: MediaProbe = { probe: async () => ({ hasAudio: true, durationSeconds: 2 }) },
): {
  readonly media: SqliteMediaRepository;
  readonly resolution: MediaResolutionService;
  readonly resolutions: SqliteSourceMediaResolutionRepository;
  readonly storage: LocalManagedTemporaryStorage;
} {
  const media = new SqliteMediaRepository(temporary.database);
  const resolutions = new SqliteSourceMediaResolutionRepository(temporary.database);
  const storage = new LocalManagedTemporaryStorage(temporary.directory);
  const importer = new MediaImportService(new LocalMediaFileInspector(), probe, media);
  return {
    media,
    resolutions,
    storage,
    resolution: new MediaResolutionService(
      resolutions,
      new RegisteredLocalOriginalMatcher(media),
      resolvers,
      storage,
      importer,
      media,
      () => now,
    ),
  };
}

function resolveInput(sourceItem: RemoteSourceItem, signal = new AbortController().signal) {
  return {
    sourceItem,
    executionId: 'execution-1',
    jobScopeId: 'execution-1',
    outputExtension: '.mp4',
    signal,
  } as const;
}

describe('media resolution and managed temporary storage', () => {
  let temporary: TemporaryDatabase | undefined;
  afterEach(() => {
    temporary?.dispose();
    temporary = undefined;
  });

  it('resolves into managed storage, registers media, and persists a ready checkpoint', async () => {
    temporary = createTemporaryDatabase();
    const sourceItem = seedSourceAndExecution(temporary);
    const resolver: MediaResolver = {
      id: 'official-test',
      canResolve: ({ strategy }) => strategy === 'official_download',
      resolve: async (_request, context) => writeFileSync(context.destinationPath, 'video-bytes'),
    };
    const app = services(temporary, [resolver]);

    const result = await app.resolution.resolve(resolveInput(sourceItem));

    expect(result.reusedLocalOriginal).toBe(false);
    expect(result.media.path).toBe(
      realpathSync.native(
        join(temporary.directory, 'storage', 'temp', 'execution-1', 'source.mp4'),
      ),
    );
    expect(readFileSync(result.media.path, 'utf8')).toBe('video-bytes');
    expect(app.resolutions.find('item-1', 'execution-1')).toMatchObject({
      status: 'ready',
      resolverId: 'official-test',
      mediaId: result.media.id,
    });
    expect(result.artifact).toMatchObject({
      ownership: 'openrepurpose_temporary',
      cleanupState: 'not_eligible',
    });
  });

  it('persists resolver failure and removes a partial file', async () => {
    temporary = createTemporaryDatabase();
    const sourceItem = seedSourceAndExecution(temporary);
    const resolver: MediaResolver = {
      id: 'failing-test',
      canResolve: () => true,
      resolve: async (_request, context) => {
        writeFileSync(context.destinationPath, 'partial');
        throw new Error('private detail');
      },
    };
    const app = services(temporary, [resolver]);

    await expect(app.resolution.resolve(resolveInput(sourceItem))).rejects.toMatchObject({
      code: 'MEDIA_RESOLUTION_FAILED',
    });
    expect(app.resolutions.find('item-1', 'execution-1')).toMatchObject({
      status: 'failed',
      errorCode: 'MEDIA_RESOLUTION_FAILED',
    });
    expect(
      existsSync(join(temporary.directory, 'storage', 'temp', 'execution-1', 'source.mp4.partial')),
    ).toBe(false);
  });

  it('persists an unavailable result when source media cannot be resolved', async () => {
    temporary = createTemporaryDatabase();
    const sourceItem = seedSourceAndExecution(temporary);
    const app = services(temporary, []);

    await expect(
      app.resolution.resolve(
        resolveInput({
          ...sourceItem,
          media: {
            availability: 'unavailable',
            resolutionStrategies: [],
            rightsRequirement: 'connection_authorization',
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'MEDIA_RESOLVER_UNAVAILABLE',
      retryable: false,
    });
    expect(app.media.list()).toEqual([]);
    expect(app.resolutions.find('item-1', 'execution-1')).toMatchObject({
      status: 'failed',
      errorCode: 'MEDIA_RESOLVER_UNAVAILABLE',
    });
  });

  it('operates without any external downloader configured', async () => {
    temporary = createTemporaryDatabase();
    const sourceItem = seedSourceAndExecution(temporary);
    const resolver = new ExternalDownloaderMediaResolver(new ExternalDownloaderRegistry());
    const app = services(temporary, [resolver]);

    await expect(
      app.resolution.resolve({
        ...resolveInput({
          ...sourceItem,
          media: {
            availability: 'available',
            externalDownload: { locator: 'https://media.example.test/items/remote-1' },
            resolutionStrategies: ['external_downloader'],
            rightsRequirement: 'explicit_confirmation',
          },
        }),
        rightsConfirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'MEDIA_RESOLVER_UNAVAILABLE', retryable: false });
  });

  it('injects an external downloader through the generic registry', async () => {
    temporary = createTemporaryDatabase();
    const sourceItem = seedSourceAndExecution(temporary);
    const download = vi.fn(async (_request, context: { readonly destinationPath: string }) => {
      writeFileSync(context.destinationPath, 'downloaded-media');
      return { destinationPath: context.destinationPath, version: 'test-version' };
    });
    const registry = new ExternalDownloaderRegistry([
      {
        id: 'fake-downloader',
        capabilities: async () => ({
          availability: 'available',
          operations: ['download'],
          version: 'test-version',
        }),
        supports: ({ locator }) => locator.startsWith('https://media.example.test/'),
        download,
      },
    ]);
    const app = services(temporary, [new ExternalDownloaderMediaResolver(registry)]);

    const result = await app.resolution.resolve({
      ...resolveInput({
        ...sourceItem,
        media: {
          availability: 'available',
          externalDownload: { locator: 'https://media.example.test/items/remote-1' },
          resolutionStrategies: ['external_downloader'],
          rightsRequirement: 'explicit_confirmation',
        },
      }),
      rightsConfirmed: true,
    });

    expect(download).toHaveBeenCalledOnce();
    expect(readFileSync(result.media.path, 'utf8')).toBe('downloaded-media');
    expect(app.resolutions.find('item-1', 'execution-1')).toMatchObject({
      resolverId: 'external-downloader',
      status: 'ready',
    });
  });

  it('contains structured external-downloader failures and preserves the rights gate', async () => {
    temporary = createTemporaryDatabase();
    const sourceItem = seedSourceAndExecution(temporary);
    const download = vi.fn(async () => {
      throw new ExternalDownloaderError('rate_limited', true, 'private implementation detail');
    });
    const app = services(temporary, [
      new ExternalDownloaderMediaResolver(
        new ExternalDownloaderRegistry([
          {
            id: 'failing-downloader',
            capabilities: async () => ({
              availability: 'available',
              operations: ['download'],
            }),
            supports: () => true,
            download,
          },
        ]),
      ),
    ]);
    const externalItem: RemoteSourceItem = {
      ...sourceItem,
      media: {
        availability: 'available',
        externalDownload: { locator: 'https://media.example.test/items/remote-1' },
        resolutionStrategies: ['external_downloader'],
        rightsRequirement: 'explicit_confirmation',
      },
    };

    await expect(app.resolution.resolve(resolveInput(externalItem))).rejects.toMatchObject({
      code: 'MEDIA_RIGHTS_CONFIRMATION_REQUIRED',
      retryable: false,
    });
    expect(download).not.toHaveBeenCalled();

    await expect(
      app.resolution.resolve({ ...resolveInput(externalItem), rightsConfirmed: true }),
    ).rejects.toMatchObject({
      code: 'MEDIA_EXTERNAL_DOWNLOADER_RATE_LIMITED',
      message: 'The external downloader is temporarily rate-limited.',
      retryable: true,
    });
    expect(app.resolutions.find('item-1', 'execution-1')).toMatchObject({
      errorCode: 'MEDIA_EXTERNAL_DOWNLOADER_RATE_LIMITED',
      errorMessage: 'The external downloader is temporarily rate-limited.',
      status: 'failed',
    });
  });

  it('persists cancellation and removes partial output', async () => {
    temporary = createTemporaryDatabase();
    const sourceItem = seedSourceAndExecution(temporary);
    const controller = new AbortController();
    const resolver: MediaResolver = {
      id: 'cancel-test',
      canResolve: () => true,
      resolve: async (_request, context) => {
        writeFileSync(context.destinationPath, 'partial');
        controller.abort();
      },
    };
    const app = services(temporary, [resolver]);

    await expect(
      app.resolution.resolve(resolveInput(sourceItem, controller.signal)),
    ).rejects.toMatchObject({ code: 'MEDIA_RESOLUTION_CANCELLED' });
    expect(app.resolutions.find('item-1', 'execution-1')).toMatchObject({
      status: 'cancelled',
      errorCode: 'MEDIA_RESOLUTION_CANCELLED',
    });
  });

  it('rejects an empty partial output and never registers it as media', async () => {
    temporary = createTemporaryDatabase();
    const sourceItem = seedSourceAndExecution(temporary);
    const resolver: MediaResolver = {
      id: 'partial-test',
      canResolve: () => true,
      resolve: async (_request, context) => writeFileSync(context.destinationPath, ''),
    };
    const app = services(temporary, [resolver]);

    await expect(app.resolution.resolve(resolveInput(sourceItem))).rejects.toBeInstanceOf(
      MediaResolutionError,
    );
    expect(app.media.list()).toEqual([]);
    expect(app.resolutions.find('item-1', 'execution-1')?.status).toBe('failed');
  });

  it('rejects corrupt resolver output and removes both partial and finalized bytes', async () => {
    temporary = createTemporaryDatabase();
    const sourceItem = seedSourceAndExecution(temporary);
    const app = services(
      temporary,
      [
        {
          id: 'corrupt-test',
          canResolve: () => true,
          resolve: async (_request, context) =>
            writeFileSync(context.destinationPath, 'not-valid-media'),
        },
      ],
      { probe: async () => Promise.reject(new Error('corrupt media')) },
    );

    await expect(app.resolution.resolve(resolveInput(sourceItem))).rejects.toMatchObject({
      code: 'MEDIA_RESOLUTION_FAILED',
    });

    const scope = join(temporary.directory, 'storage', 'temp', 'execution-1');
    expect(existsSync(join(scope, 'source.mp4'))).toBe(false);
    expect(existsSync(join(scope, 'source.mp4.partial'))).toBe(false);
    expect(app.media.list()).toEqual([]);
    expect(app.resolutions.find('item-1', 'execution-1')).toMatchObject({
      status: 'failed',
      errorCode: 'MEDIA_RESOLUTION_FAILED',
    });
  });

  it('recovers a completed download after restart without invoking the resolver again', async () => {
    temporary = createTemporaryDatabase();
    const sourceItem = seedSourceAndExecution(temporary);
    const app = services(temporary, []);
    const paths = await app.storage.prepare('execution-1', '.mp4');
    writeFileSync(paths.partialPath, 'already-downloaded');
    await app.storage.finalize(paths);
    app.resolutions.begin({
      sourceItemId: 'item-1',
      executionId: 'execution-1',
      jobScopeId: 'execution-1',
      resolverId: 'official-test',
      managedPath: paths.finalPath,
      now,
    });
    const resolve = vi.fn<MediaResolver['resolve']>();
    const restarted = services(temporary, [
      { id: 'official-test', canResolve: () => true, resolve },
    ]);

    const result = await restarted.resolution.resolve(resolveInput(sourceItem));

    expect(resolve).not.toHaveBeenCalled();
    expect(result.media.path).toBe(realpathSync.native(paths.finalPath));
    expect(restarted.resolutions.find('item-1', 'execution-1')?.status).toBe('ready');
  });

  it('reuses a registered local original without copying or allowing cleanup to delete it', async () => {
    temporary = createTemporaryDatabase();
    const sourceItem = seedSourceAndExecution(temporary);
    const originalPath = join(temporary.directory, 'originals', 'owned.mp4');
    mkdirSync(join(temporary.directory, 'originals'), { recursive: true });
    writeFileSync(originalPath, 'user-owned');
    const app = services(temporary, []);
    const imported = await new MediaImportService(
      new LocalMediaFileInspector(),
      { probe: async () => ({ hasAudio: false }) },
      app.media,
    ).import(originalPath);

    const result = await app.resolution.resolve({
      ...resolveInput(sourceItem),
      localOriginal: { mediaId: imported.asset.id },
    });

    expect(result.reusedLocalOriginal).toBe(true);
    expect(result.media.path).toBe(realpathSync.native(originalPath));
    expect(result.artifact.ownership).toBe('user_owned_original');
    const cleanup = new SourceMediaCleanupService(app.resolutions, app.storage, () => now);
    await expect(cleanup.cleanupArtifact(result.artifact.id)).resolves.toBe('protected');
    expect(readFileSync(originalPath, 'utf8')).toBe('user-owned');
    expect(existsSync(join(temporary.directory, 'storage', 'temp', 'execution-1'))).toBe(false);
  });

  it('cleans eligible managed files idempotently and rejects paths outside the managed root', async () => {
    temporary = createTemporaryDatabase();
    const sourceItem = seedSourceAndExecution(temporary);
    const app = services(temporary, [
      {
        id: 'official-test',
        canResolve: () => true,
        resolve: async (_request, context) => writeFileSync(context.destinationPath, 'managed'),
      },
    ]);
    const result = await app.resolution.resolve(resolveInput(sourceItem));
    temporary.database.client
      .prepare(
        `UPDATE source_workflow_executions SET cleanup_status = 'eligible', cleanup_eligible_at = ?
         WHERE id = 'execution-1'`,
      )
      .run(now.getTime());
    temporary.database.client
      .prepare("UPDATE source_media_artifacts SET cleanup_state = 'eligible' WHERE id = ?")
      .run(result.artifact.id);
    const cleanup = new SourceMediaCleanupService(app.resolutions, app.storage, () => now);

    await expect(cleanup.cleanupArtifact(result.artifact.id)).resolves.toBe('deleted');
    await expect(cleanup.cleanupArtifact(result.artifact.id)).resolves.toBe('missing');
    expect(existsSync(result.media.path)).toBe(false);

    const outside = resolve(temporary.directory, 'outside.txt');
    writeFileSync(outside, 'keep');
    await expect(app.storage.cleanup(outside)).rejects.toThrow('outside managed temporary storage');
    await expect(app.storage.prepare('../escape', '.mp4')).rejects.toThrow('safe identifier');
    expect(readFileSync(outside, 'utf8')).toBe('keep');
  });

  it('models all retention policies with validated delayed cleanup', () => {
    expect(retentionCleanupAt({ kind: 'delete_after_success' }, now)).toEqual(now);
    expect(retentionCleanupAt({ kind: 'keep_forever' }, now)).toBeUndefined();
    expect(retentionCleanupAt({ kind: 'keep_for_duration', durationSeconds: 3_600 }, now)).toEqual(
      new Date(now.getTime() + 3_600_000),
    );
    expect(() =>
      retentionCleanupAt({ kind: 'keep_for_duration', durationSeconds: 0 }, now),
    ).toThrow('positive whole number');
  });

  it('reconciles stale managed scopes safely and idempotently', async () => {
    temporary = createTemporaryDatabase();
    const storage = new LocalManagedTemporaryStorage(temporary.directory);
    const stale = await storage.prepare('stale-execution', '.mp4');
    const active = await storage.prepare('active-execution', '.mp4');
    writeFileSync(stale.partialPath, 'abandoned partial');
    writeFileSync(active.finalPath, 'active retry media');
    const outside = join(temporary.directory, 'outside-original.mp4');
    writeFileSync(outside, 'never delete');
    const staleBefore = new Date(Date.now() + 60_000);

    await expect(
      storage.reconcileStale({ activeScopeIds: ['active-execution'], staleBefore }),
    ).resolves.toEqual({
      deletedScopeIds: ['stale-execution'],
      skippedScopeIds: ['active-execution'],
    });
    expect(existsSync(join(storage.root, 'stale-execution'))).toBe(false);
    expect(readFileSync(active.finalPath, 'utf8')).toBe('active retry media');
    expect(readFileSync(outside, 'utf8')).toBe('never delete');

    await expect(
      storage.reconcileStale({ activeScopeIds: ['active-execution'], staleBefore }),
    ).resolves.toEqual({
      deletedScopeIds: [],
      skippedScopeIds: ['active-execution'],
    });
    await expect(
      storage.reconcileStale({ activeScopeIds: ['../escape'], staleBefore }),
    ).rejects.toThrow('safe identifier');
  });
});
