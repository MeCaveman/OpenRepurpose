import { afterEach, describe, expect, it } from 'vitest';
import { JobService, WorkflowPresetService, WorkflowService } from '@openrepurpose/core';
import type {
  ConnectedAccount,
  MetaCredential,
  MetaPublishTarget,
  SourceConnection,
} from '@openrepurpose/core';
import { SqliteJobRepository, SqliteWorkflowRepository } from '@openrepurpose/db';
import { createTemporaryDatabase } from '@openrepurpose/testkit';
import type { TemporaryDatabase } from '@openrepurpose/testkit';

const now = new Date(0);

function account(
  id: string,
  provider: ConnectedAccount['provider'],
  capabilities: ConnectedAccount['capabilities'],
): ConnectedAccount {
  return {
    id,
    provider,
    capabilities,
    connectedAt: now,
    displayName: id,
    externalId: id,
    status: 'connected',
    updatedAt: now,
  };
}

function service(
  options: {
    accounts?: readonly ConnectedAccount[];
    credential?: MetaCredential;
    sources?: readonly SourceConnection[];
    targets?: readonly MetaPublishTarget[];
    transformAvailable?: boolean;
  } = {},
) {
  return new WorkflowPresetService(
    { list: () => options.accounts ?? [] },
    {
      findCredential: () => options.credential,
      listTargets: () => options.targets ?? [],
    },
    { listConnections: () => options.sources ?? [] },
    { transformAvailable: options.transformAvailable ?? true },
  );
}

describe('streamer workflow presets', () => {
  let temporary: TemporaryDatabase | undefined;
  afterEach(() => {
    temporary?.dispose();
    temporary = undefined;
  });

  it('generates an ordinary editable OBS workflow from available destination capabilities', () => {
    const presets = service({
      accounts: [
        account('youtube-1', 'youtube', ['youtube.video.upload']),
        account('tiktok-1', 'tiktok', ['tiktok.video.publish']),
      ],
    });
    const draft = presets.draft('obs-clip-short-form');

    expect(draft.preset).toMatchObject({
      destinationIds: ['youtube', 'tiktok'],
      status: 'partial',
    });
    expect(draft.workflow.definition).toMatchObject({
      steps: [
        {
          kind: 'source',
          sourceType: 'watched_folder',
          watchedFolder: { preset: 'obs_replay_buffer', settleMs: 5_000 },
        },
        { kind: 'transform', plan: { user: { steps: [{ width: 1080, height: 1920 }] } } },
        { kind: 'destination', destination: { destinationId: 'youtube' } },
        { kind: 'destination', destination: { destinationId: 'tiktok' } },
      ],
    });

    temporary = createTemporaryDatabase();
    const workflows = new WorkflowService(
      new SqliteWorkflowRepository(temporary.database),
      new JobService(new SqliteJobRepository(temporary.database)),
    );
    const created = workflows.create({
      ...draft.workflow,
      name: 'Edited streamer route',
      sourceDirectory: 'C:\\OBS\\Replay Buffer',
    });
    expect(created).toMatchObject({
      name: 'Edited streamer route',
      sourceDirectory: 'C:\\OBS\\Replay Buffer',
      destinations: [
        { destinationId: 'youtube', accountId: 'youtube-1' },
        { destinationId: 'tiktok', accountId: 'tiktok-1' },
      ],
    });
  });

  it('blocks stream presets unless an active authorized Twitch clips source can resolve media', () => {
    const twitch = account('twitch-1', 'twitch', ['twitch.identity.read']);
    const blocked = service({
      accounts: [twitch, account('youtube-1', 'youtube', ['youtube.video.upload'])],
      sources: [
        {
          adapterId: 'twitch',
          cadenceOwner: 'interval',
          configuration: { accountId: twitch.id, kind: 'vods' },
          consecutivePollFailures: 0,
          createdAt: now,
          cursor: null,
          displayName: 'Recent VODs',
          externalSourceId: 'broadcaster-1',
          id: 'source-vods',
          status: 'active',
          updatedAt: now,
        },
      ],
    });

    expect(blocked.list()[1]).toMatchObject({
      status: 'blocked',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'SOURCE_UNAVAILABLE', severity: 'blocking' }),
      ]),
    });
    expect(() => blocked.draft('stream-clip-short-form')).toThrow(
      'Add an active Twitch clips source',
    );
  });

  it('uses available Instagram targets and an authorized Twitch clips source without hidden logic', () => {
    const twitch = account('twitch-1', 'twitch', ['twitch.identity.read', 'twitch.clip.download']);
    const credential: MetaCredential = {
      connectedAt: now,
      displayName: 'Meta owner',
      externalId: 'owner-1',
      id: 'meta-1',
      scopes: ['instagram_content_publish'],
      status: 'connected',
      tokenExpiresAt: new Date(10_000),
      updatedAt: now,
    };
    const presets = service({
      accounts: [twitch],
      credential,
      targets: [
        {
          availability: 'available',
          credentialId: credential.id,
          displayName: '@streamer',
          enabled: true,
          externalId: 'ig-external',
          id: 'ig-target',
          kind: 'instagram_professional',
          pageId: 'page-1',
          updatedAt: now,
        },
      ],
      sources: [
        {
          adapterId: 'twitch',
          cadenceOwner: 'interval',
          configuration: { accountId: twitch.id, broadcasterId: 'broadcaster-1', kind: 'clips' },
          consecutivePollFailures: 0,
          createdAt: now,
          cursor: null,
          displayName: 'New Twitch clips',
          externalSourceId: 'broadcaster-1',
          id: 'source-clips',
          status: 'active',
          updatedAt: now,
        },
      ],
    });

    const draft = presets.draft('stream-clip-short-form');
    expect(draft.workflow).toMatchObject({
      remoteSource: { connectionId: 'source-clips' },
      destinations: [{ destinationId: 'instagram', accountId: 'ig-target' }],
    });
    expect(draft.workflow.definition?.steps.map((step) => step.kind)).toEqual([
      'source',
      'transform',
      'destination',
    ]);
  });
});
