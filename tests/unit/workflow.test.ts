import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  JobService,
  MediaImportService,
  WorkflowService,
  renderTemplate,
  validateTemplate,
} from '@openrepurpose/core';
import {
  SqliteAccountRepository,
  SqliteJobRepository,
  SqliteMediaRepository,
  SqliteSourceCursorRepository,
  SqliteWorkflowRepository,
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
      renderTemplate('{{file.stem}} — {{workflow.name}}', {
        file: { name: 'clip.mp4', stem: 'clip' },
        media: { duration: '4.2' },
        workflow: { name: 'Daily' },
      }),
    ).toBe('clip — Daily');
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
});
