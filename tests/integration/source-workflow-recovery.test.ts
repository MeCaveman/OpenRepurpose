import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JobExecutionError,
  JobRunner,
  JobService,
  MediaImportService,
  MediaResolutionService,
  RegisteredLocalOriginalMatcher,
  SourceCleanupJobHandler,
  SourceExecutionJobHandler,
  SourceItemObservedJobHandler,
  SourceMediaCleanupService,
  SourceWorkflowCoordinator,
  WorkflowService,
  type JobHandler,
  type JsonValue,
} from '@openrepurpose/core';
import {
  openDatabase,
  runMigrations,
  SqliteDestinationJobRepository,
  SqliteJobRepository,
  SqliteMediaRepository,
  SqliteSourceMediaResolutionRepository,
  SqliteSourcePollingRepository,
  SqliteSourceWorkflowExecutionRepository,
  SqliteWorkflowRepository,
  type OpenRepurposeDatabase,
} from '@openrepurpose/db';
import { LocalManagedTemporaryStorage, LocalMediaFileInspector } from '@openrepurpose/media';

interface Clock {
  value: Date;
}

interface DestinationCalls {
  facebook: number;
  youtube: number;
}

function seedConnection(database: OpenRepurposeDatabase): void {
  database.client
    .prepare(
      `INSERT INTO source_connections (
        id, adapter_id, external_source_id, display_name, configuration_json, status,
        consecutive_poll_failures, created_at, updated_at
      ) VALUES ('source-1', 'mock', 'channel-1', 'Channel', '{}', 'active', 0, 1, 1)`,
    )
    .run();
}

function createSystem(
  database: OpenRepurposeDatabase,
  directory: string,
  clock: Clock,
  calls: DestinationCalls,
  failFacebook: { value: boolean },
  options: { readonly resolverCalls?: { value: number } } = {},
) {
  const media = new SqliteMediaRepository(database);
  const jobsRepository = new SqliteJobRepository(database);
  const jobs = new JobService(jobsRepository, () => clock.value);
  const workflowsRepository = new SqliteWorkflowRepository(database);
  const workflows = new WorkflowService(workflowsRepository, jobs, () => clock.value);
  const executions = new SqliteSourceWorkflowExecutionRepository(database);
  const resolutions = new SqliteSourceMediaResolutionRepository(database);
  const storage = new LocalManagedTemporaryStorage(directory);
  const resolution = new MediaResolutionService(
    resolutions,
    new RegisteredLocalOriginalMatcher(media),
    [
      {
        id: 'official-test-resolver',
        canResolve: () => true,
        resolve: async (request, context) => {
          if (options.resolverCalls !== undefined) options.resolverCalls.value += 1;
          writeFileSync(
            context.destinationPath,
            `resolved remote media ${request.sourceItem.externalId}`,
          );
        },
      },
    ],
    storage,
    new MediaImportService(
      new LocalMediaFileInspector(),
      { probe: async () => ({ durationSeconds: 42, hasAudio: true }) },
      media,
    ),
    media,
    () => clock.value,
  );
  const coordinator = new SourceWorkflowCoordinator(
    workflowsRepository,
    executions,
    resolution,
    workflows,
    jobs,
    new SourceMediaCleanupService(resolutions, storage, () => clock.value),
    () => clock.value,
  );
  const checkpoints = new SqliteDestinationJobRepository(database);
  const destinationHandler = (
    type: 'facebook.reels.publish' | 'youtube.upload',
    destinationId: 'facebook' | 'youtube',
  ): JobHandler => ({
    type,
    execute: async (_input: JsonValue, context) => {
      calls[destinationId] += 1;
      if (destinationId === 'facebook' && failFacebook.value) {
        failFacebook.value = false;
        throw new JobExecutionError('TEST_DESTINATION_FAILURE', false, 'Destination failed.');
      }
      checkpoints.save({
        destinationId,
        jobId: context.jobId,
        remoteId: `${destinationId}-remote-id`,
        remoteStatus: 'succeeded',
        uploadedBytes: 21,
        updatedAt: clock.value,
      });
    },
  });
  return {
    coordinator,
    executions,
    jobs,
    jobsRepository,
    resolution,
    resolutions,
    storage,
    workflows,
    handlers: {
      cleanup: new SourceCleanupJobHandler(coordinator),
      execution: new SourceExecutionJobHandler(coordinator),
      observed: new SourceItemObservedJobHandler(coordinator),
      facebook: destinationHandler('facebook.reels.publish', 'facebook'),
      youtube: destinationHandler('youtube.upload', 'youtube'),
    },
  };
}

describe('remote source workflow recovery', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it('filters before resolution and snapshots source variables and workflow version', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-source-filter-'));
    directories.push(directory);
    const database = openDatabase(join(directory, 'openrepurpose.sqlite'));
    runMigrations(database);
    seedConnection(database);
    const clock = { value: new Date('2026-09-18T10:00:00.000Z') };
    const calls = { facebook: 0, youtube: 0 };
    const system = createSystem(database, directory, clock, calls, { value: false });
    system.workflows.create({
      name: 'Filtered out',
      remoteSource: { connectionId: 'source-1', filters: { titleContains: 'missing' } },
      titleTemplate: '{{source.title}}',
      destinations: [{ destinationId: 'youtube', accountId: 'account-1', privacy: 'private' }],
    });
    const included = system.workflows.create({
      name: 'Included',
      remoteSource: { connectionId: 'source-1', filters: { titleContains: 'weekly' } },
      titleTemplate: '{{source.title}} / {{source.externalId}}',
      descriptionTemplate: '{{source.description}} / {{source.publishedAt}}',
      destinations: [{ destinationId: 'youtube', accountId: 'account-1', privacy: 'unlisted' }],
    });
    const observed = new SqliteSourcePollingRepository(database).upsertObservedItem({
      connectionId: 'source-1',
      now: clock.value,
      item: {
        externalId: 'video-1',
        publishedAt: '2026-09-18T09:00:00.000Z',
        metadata: { title: 'Weekly upload', description: 'Source description' },
        media: {
          availability: 'available',
          resolutionStrategies: ['official_download'],
          rightsRequirement: 'connection_authorization',
        },
      },
    }).item;

    const [execution] = system.coordinator.observe(observed.id);
    expect(execution).toBeDefined();
    expect(
      database.client.prepare('SELECT count(*) AS count FROM source_media_resolutions').get(),
    ).toEqual({ count: 0 });
    expect(
      database.client.prepare('SELECT count(*) AS count FROM source_workflow_executions').get(),
    ).toEqual({ count: 1 });
    system.workflows.update(included.id, {
      name: 'Changed later',
      remoteSource: { connectionId: 'source-1' },
      titleTemplate: 'changed',
      destinations: [{ destinationId: 'youtube', accountId: 'account-1', privacy: 'private' }],
    });
    await new JobRunner(system.jobsRepository, [system.handlers.execution], {
      concurrency: 1,
      now: () => clock.value,
    }).runOnce();
    const upload = system.jobs.list().find((job) => job.type === 'youtube.upload');
    expect(upload?.input).toMatchObject({
      metadata: {
        title: 'Weekly upload / video-1',
        description: 'Source description / 2026-09-18T09:00:00.000Z',
        privacy: 'unlisted',
      },
    });
    expect(system.executions.find(execution!.id)?.snapshot.workflow.name).toBe('Included');
    database.close();
  });

  it('honors a workflow disabled after detection and dedupes two workflows on one source', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-source-fanout-'));
    directories.push(directory);
    const database = openDatabase(join(directory, 'openrepurpose.sqlite'));
    runMigrations(database);
    seedConnection(database);
    const clock = { value: new Date('2026-09-18T10:00:00.000Z') };
    const system = createSystem(
      database,
      directory,
      clock,
      { facebook: 0, youtube: 0 },
      { value: false },
    );
    const disabled = system.workflows.create({
      name: 'Disable during poll',
      remoteSource: { connectionId: 'source-1' },
      titleTemplate: '{{source.title}}',
      destinations: [{ destinationId: 'youtube', accountId: 'disabled', privacy: 'private' }],
    });
    const polling = new SqliteSourcePollingRepository(database);
    const firstItem = polling.upsertObservedItem({
      connectionId: 'source-1',
      now: clock.value,
      item: {
        externalId: 'disabled-video',
        metadata: { title: 'Disable before handoff runs' },
        media: {
          availability: 'available',
          resolutionStrategies: ['official_download'],
          rightsRequirement: 'connection_authorization',
        },
      },
    }).item;
    system.jobs.create({
      type: 'source.item.observed',
      idempotencyKey: `source-item:${firstItem.id}:observed`,
      input: { sourceConnectionId: 'source-1', sourceItemId: firstItem.id },
    });
    system.workflows.update(disabled.id, {
      name: disabled.name,
      enabled: false,
      remoteSource: { connectionId: 'source-1' },
      titleTemplate: disabled.titleTemplate,
      destinations: disabled.destinations,
    });

    await new JobRunner(system.jobsRepository, [system.handlers.observed], {
      concurrency: 1,
      now: () => clock.value,
    }).runOnce();
    expect(
      database.client.prepare('SELECT count(*) AS count FROM source_workflow_executions').get(),
    ).toEqual({ count: 0 });

    for (const accountId of ['first-account', 'second-account'])
      system.workflows.create({
        name: `Workflow ${accountId}`,
        remoteSource: { connectionId: 'source-1' },
        titleTemplate: '{{source.title}}',
        destinations: [{ destinationId: 'youtube', accountId, privacy: 'private' }],
      });
    const secondItem = polling.upsertObservedItem({
      connectionId: 'source-1',
      now: clock.value,
      item: {
        externalId: 'shared-video',
        metadata: { title: 'One source, two workflows' },
        media: {
          availability: 'available',
          resolutionStrategies: ['official_download'],
          rightsRequirement: 'connection_authorization',
        },
      },
    }).item;

    const workflowExecutions = system.coordinator.observe(secondItem.id);
    expect(workflowExecutions).toHaveLength(2);
    expect(system.coordinator.observe(secondItem.id)).toHaveLength(2);
    expect(
      database.client
        .prepare(
          'SELECT count(*) AS count FROM source_workflow_executions WHERE source_item_id = ?',
        )
        .get(secondItem.id),
    ).toEqual({ count: 2 });
    expect(system.jobs.list().filter((job) => job.type === 'source.execution.run')).toHaveLength(2);
    await new JobRunner(system.jobsRepository, [system.handlers.execution], {
      concurrency: 2,
      now: () => clock.value,
    }).runOnce();
    const artifacts = workflowExecutions.flatMap((execution) =>
      system.executions.listArtifacts(execution.id),
    );
    expect(new Set(artifacts.map((artifact) => artifact.path)).size).toBe(2);
    expect(new Set(artifacts.map((artifact) => artifact.mediaId)).size).toBe(2);
    expect(artifacts.every((artifact) => existsSync(artifact.path))).toBe(true);
    expect(system.jobs.list().filter((job) => job.type === 'youtube.upload')).toHaveLength(2);
    database.close();
  });

  it('reuses a completed download after restart before publishing begins', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-downloaded-restart-'));
    directories.push(directory);
    const databasePath = join(directory, 'openrepurpose.sqlite');
    const clock = { value: new Date('2026-09-18T10:00:00.000Z') };
    const resolverCalls = { value: 0 };
    let database = openDatabase(databasePath);
    runMigrations(database);
    seedConnection(database);
    let system = createSystem(
      database,
      directory,
      clock,
      { facebook: 0, youtube: 0 },
      { value: false },
      { resolverCalls },
    );
    system.workflows.create({
      name: 'Download recovery',
      remoteSource: { connectionId: 'source-1' },
      titleTemplate: '{{source.title}}',
      destinations: [{ destinationId: 'youtube', accountId: 'account-1', privacy: 'private' }],
    });
    const item = new SqliteSourcePollingRepository(database).upsertObservedItem({
      connectionId: 'source-1',
      now: clock.value,
      item: {
        externalId: 'downloaded-before-crash',
        metadata: { title: 'Downloaded first', fileExtension: 'mp4' },
        media: {
          availability: 'available',
          resolutionStrategies: ['official_download'],
          rightsRequirement: 'connection_authorization',
        },
      },
    }).item;
    const execution = system.coordinator.observe(item.id)[0]!;
    const sourceItem = system.executions.findSourceItem(item.id)!;
    const resolved = await system.resolution.resolve({
      sourceItem,
      executionId: execution.id,
      jobScopeId: execution.id,
      outputExtension: 'mp4',
      signal: new AbortController().signal,
    });
    expect(resolverCalls.value).toBe(1);
    expect(existsSync(resolved.media.path)).toBe(true);
    database.close();

    clock.value = new Date(clock.value.getTime() + 100);
    database = openDatabase(databasePath);
    runMigrations(database);
    system = createSystem(
      database,
      directory,
      clock,
      { facebook: 0, youtube: 0 },
      { value: false },
      { resolverCalls },
    );
    await new JobRunner(system.jobsRepository, [system.handlers.execution], {
      concurrency: 1,
      now: () => clock.value,
    }).runOnce();

    expect(resolverCalls.value).toBe(1);
    expect(system.jobs.list().filter((job) => job.type === 'youtube.upload')).toHaveLength(1);
    database.close();
  });

  it('enforces default, delayed, and keep-forever retention while preserving history', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-source-retention-'));
    directories.push(directory);
    const database = openDatabase(join(directory, 'openrepurpose.sqlite'));
    runMigrations(database);
    seedConnection(database);
    const clock = { value: new Date('2026-09-18T10:00:00.000Z') };
    const calls = { facebook: 0, youtube: 0 };
    const system = createSystem(database, directory, clock, calls, { value: false });
    const policies = [
      {
        externalId: 'delete-immediately-video',
        name: 'Delete immediately',
        retentionPolicy: { kind: 'delete_after_success' } as const,
      },
      {
        externalId: 'delete-later-video',
        name: 'Delete later',
        retentionPolicy: { kind: 'keep_for_duration', durationSeconds: 3_600 } as const,
      },
      {
        externalId: 'keep-forever-video',
        name: 'Keep forever',
        retentionPolicy: { kind: 'keep_forever' } as const,
      },
    ];
    for (const policy of policies)
      system.workflows.create({
        name: policy.name,
        remoteSource: {
          connectionId: 'source-1',
          filters: { titleContains: policy.name },
          retentionPolicy: policy.retentionPolicy,
        },
        titleTemplate: '{{source.title}}',
        destinations: [{ destinationId: 'youtube', accountId: policy.name, privacy: 'private' }],
      });
    const polling = new SqliteSourcePollingRepository(database);
    const executions = policies.flatMap((policy) => {
      const item = polling.upsertObservedItem({
        connectionId: 'source-1',
        now: clock.value,
        item: {
          externalId: policy.externalId,
          metadata: { title: policy.name, fileExtension: 'mp4' },
          media: {
            availability: 'available',
            resolutionStrategies: ['official_download'],
            rightsRequirement: 'connection_authorization',
          },
        },
      }).item;
      return system.coordinator.observe(item.id);
    });
    await new JobRunner(system.jobsRepository, [system.handlers.execution], {
      concurrency: 3,
      now: () => clock.value,
    }).runOnce();
    expect(
      system.jobs
        .list()
        .filter((job) => job.type === 'source.execution.run')
        .map((job) => ({ status: job.status, error: job.lastErrorCode })),
    ).toEqual([
      { status: 'succeeded', error: undefined },
      { status: 'succeeded', error: undefined },
      { status: 'succeeded', error: undefined },
    ]);
    await new JobRunner(system.jobsRepository, [system.handlers.youtube], {
      concurrency: 3,
      now: () => clock.value,
    }).runOnce();
    expect(
      system.jobs
        .list()
        .filter((job) => job.type === 'youtube.upload')
        .map((job) => job.status),
    ).toEqual(['succeeded', 'succeeded', 'succeeded']);
    const byName = new Map(
      executions.map((execution) => [execution.snapshot.workflow.name, execution.id]),
    );
    const immediateId = byName.get('Delete immediately')!;
    const delayedId = byName.get('Delete later')!;
    const foreverId = byName.get('Keep forever')!;
    const immediateArtifact = system.executions.listArtifacts(immediateId)[0]!;
    const delayedArtifact = system.executions.listArtifacts(delayedId)[0]!;
    const foreverArtifact = system.executions.listArtifacts(foreverId)[0]!;

    expect(system.executions.find(immediateId)?.cleanupStatus).toBe('eligible');
    expect(system.executions.find(delayedId)?.cleanupEligibleAt).toEqual(
      new Date(clock.value.getTime() + 3_600_000),
    );
    expect(system.executions.find(foreverId)?.cleanupStatus).toBe('retained');
    system.coordinator.recover();
    await new JobRunner(system.jobsRepository, [system.handlers.cleanup], {
      concurrency: 3,
      now: () => clock.value,
    }).runOnce();

    expect(existsSync(immediateArtifact.path)).toBe(false);
    expect(existsSync(delayedArtifact.path)).toBe(true);
    expect(existsSync(foreverArtifact.path)).toBe(true);
    expect(system.executions.find(immediateId)?.cleanupStatus).toBe('completed');
    expect(system.executions.find(delayedId)?.cleanupStatus).toBe('eligible');
    expect(system.executions.find(foreverId)?.cleanupStatus).toBe('retained');
    expect(system.executions.listDestinations(immediateId)[0]).toMatchObject({
      status: 'succeeded',
      remoteId: 'youtube-remote-id',
    });
    expect(system.executions.findSourceItem(immediateArtifact.sourceItemId)?.metadata).toEqual({
      title: 'Delete immediately',
      fileExtension: 'mp4',
    });
    expect(system.resolutions.findArtifact(immediateArtifact.id)).toMatchObject({
      state: 'deleted',
      cleanupState: 'completed',
    });

    clock.value = new Date(clock.value.getTime() + 3_600_000);
    system.coordinator.recover();
    await new JobRunner(system.jobsRepository, [system.handlers.cleanup], {
      concurrency: 3,
      now: () => clock.value,
    }).runOnce();
    expect(existsSync(delayedArtifact.path)).toBe(false);
    expect(existsSync(foreverArtifact.path)).toBe(true);
    expect(system.executions.find(delayedId)?.cleanupStatus).toBe('completed');
    expect(system.executions.find(foreverId)?.cleanupStatus).toBe('retained');
    database.close();
  });

  it('recovers every Packet 5 crash boundary and retries only the failed destination', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-source-recovery-'));
    directories.push(directory);
    const databasePath = join(directory, 'openrepurpose.sqlite');
    const clock = { value: new Date('2026-09-18T10:00:00.000Z') };
    const calls = { facebook: 0, youtube: 0 };
    const failFacebook = { value: true };

    let database = openDatabase(databasePath);
    runMigrations(database);
    seedConnection(database);
    let system = createSystem(database, directory, clock, calls, failFacebook);
    system.workflows.create({
      name: 'Recovery workflow',
      remoteSource: { connectionId: 'source-1' },
      titleTemplate: '{{source.title}}',
      destinations: [
        { destinationId: 'youtube', accountId: 'youtube-account', privacy: 'private' },
        { destinationId: 'facebook', accountId: 'facebook-page' },
      ],
    });
    const item = new SqliteSourcePollingRepository(database).upsertObservedItem({
      connectionId: 'source-1',
      now: clock.value,
      item: {
        externalId: 'video-recovery',
        metadata: { title: 'Recovery video', fileExtension: 'mp4' },
        media: {
          availability: 'available',
          resolutionStrategies: ['official_download'],
          rightsRequirement: 'connection_authorization',
        },
      },
    }).item;
    const [created] = system.coordinator.observe(item.id);
    const executionId = created!.id;

    // Crash before the execution job is durably created.
    database.client.prepare("DELETE FROM jobs WHERE type = 'source.execution.run'").run();
    database.close();

    // Startup recovery recreates the missing idempotent job; crash again after job creation.
    clock.value = new Date(clock.value.getTime() + 100);
    database = openDatabase(databasePath);
    runMigrations(database);
    system = createSystem(database, directory, clock, calls, failFacebook);
    system.coordinator.recover();
    expect(system.jobs.list().filter((job) => job.type === 'source.execution.run')).toHaveLength(1);
    database.close();

    // The execution resumes, resolves media, and creates normal destination jobs.
    clock.value = new Date(clock.value.getTime() + 100);
    database = openDatabase(databasePath);
    runMigrations(database);
    system = createSystem(database, directory, clock, calls, failFacebook);
    await new JobRunner(system.jobsRepository, [system.handlers.execution], {
      concurrency: 1,
      now: () => clock.value,
    }).runOnce();
    expect(
      system.jobs
        .list()
        .filter((job) => job.type.endsWith('publish') || job.type === 'youtube.upload'),
    ).toHaveLength(2);

    // Destination A succeeds, then the process stops before B starts.
    await new JobRunner(system.jobsRepository, [system.handlers.youtube], {
      concurrency: 1,
      now: () => clock.value,
    }).runOnce();
    expect(calls.youtube).toBe(1);
    database.close();

    // Restart runs only B. Its terminal failure is explicitly retried without republishing A.
    clock.value = new Date(clock.value.getTime() + 100);
    database = openDatabase(databasePath);
    runMigrations(database);
    system = createSystem(database, directory, clock, calls, failFacebook);
    await new JobRunner(
      system.jobsRepository,
      [system.handlers.youtube, system.handlers.facebook],
      {
        concurrency: 1,
        now: () => clock.value,
      },
    ).runOnce();
    expect(calls).toEqual({ youtube: 1, facebook: 1 });
    const managedArtifact = system.executions.listArtifacts(executionId)[0]!;
    expect(existsSync(managedArtifact.path)).toBe(true);
    expect(system.executions.find(executionId)?.cleanupStatus).toBe('not_eligible');
    expect(system.coordinator.retryFailedDestinations(executionId)).toBe(1);
    await new JobRunner(
      system.jobsRepository,
      [system.handlers.youtube, system.handlers.facebook],
      {
        concurrency: 1,
        now: () => clock.value,
      },
    ).runOnce();
    expect(calls).toEqual({ youtube: 1, facebook: 2 });
    expect(system.executions.find(executionId)?.cleanupStatus).toBe('eligible');
    expect(system.executions.listDestinations(executionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ destinationId: 'youtube', status: 'succeeded' }),
        expect.objectContaining({ destinationId: 'facebook', status: 'succeeded' }),
      ]),
    );
    database.close();

    // All destinations succeeded before cleanup scheduling; restart discovers eligibility.
    clock.value = new Date(clock.value.getTime() + 100);
    database = openDatabase(databasePath);
    runMigrations(database);
    system = createSystem(database, directory, clock, calls, failFacebook);
    system.coordinator.recover();
    const cleanupJob = system.jobs.list().find((job) => job.type === 'source.execution.cleanup')!;
    expect(cleanupJob.status).toBe('pending');

    // Crash during cleanup after the managed file is deleted but before its checkpoint commits.
    const claimedAt = clock.value;
    system.jobsRepository.claimNext(
      ['source.execution.cleanup'],
      'crashed-cleaner',
      claimedAt,
      new Date(claimedAt.getTime() + 10),
    );
    system.executions.markCleanupRunning(executionId, claimedAt);
    system.resolutions.markCleanupRunning(managedArtifact.id, claimedAt);
    await system.storage.cleanup(managedArtifact.path);
    database.close();

    clock.value = new Date(claimedAt.getTime() + 20);
    database = openDatabase(databasePath);
    runMigrations(database);
    system = createSystem(database, directory, clock, calls, failFacebook);
    await new JobRunner(system.jobsRepository, [system.handlers.cleanup], {
      concurrency: 1,
      leaseDurationMs: 1_000,
      now: () => clock.value,
    }).runOnce();
    expect(system.executions.find(executionId)).toMatchObject({
      status: 'succeeded',
      cleanupStatus: 'completed',
    });
    expect(system.resolutions.findArtifact(managedArtifact.id)).toMatchObject({
      state: 'deleted',
      cleanupState: 'completed',
    });
    expect(existsSync(managedArtifact.path)).toBe(false);
    expect(system.executions.findSourceItem(item.id)?.metadata).toEqual({
      title: 'Recovery video',
      fileExtension: 'mp4',
    });
    expect(system.executions.listDestinations(executionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ destinationId: 'youtube', remoteId: 'youtube-remote-id' }),
        expect.objectContaining({ destinationId: 'facebook', remoteId: 'facebook-remote-id' }),
      ]),
    );
    expect(calls).toEqual({ youtube: 1, facebook: 2 });
    database.close();
  });
});
