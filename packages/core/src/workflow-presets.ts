import type {
  AccountRepository,
  MetaCredentialRepository,
  SourcePollingRepository,
  WorkflowDestination,
  WorkflowInput,
  WorkflowStep,
} from './index.js';

export type StreamerWorkflowPresetId = 'obs-clip-short-form' | 'stream-clip-short-form';

export interface WorkflowPresetIssue {
  readonly code: 'DESTINATION_UNAVAILABLE' | 'SOURCE_UNAVAILABLE' | 'TRANSFORM_UNAVAILABLE';
  readonly message: string;
  readonly severity: 'blocking' | 'warning';
}

export interface WorkflowPresetSummary {
  readonly description: string;
  readonly destinationIds: readonly ('instagram' | 'tiktok' | 'youtube')[];
  readonly id: StreamerWorkflowPresetId;
  readonly issues: readonly WorkflowPresetIssue[];
  readonly label: string;
  readonly sourceConnectionId?: string;
  readonly status: 'blocked' | 'partial' | 'ready';
}

export interface WorkflowPresetDraft {
  readonly preset: WorkflowPresetSummary;
  readonly workflow: WorkflowInput;
}

export interface WorkflowPresetServiceOptions {
  readonly transformAvailable: boolean;
}

const verticalTransform: WorkflowStep = {
  id: 'transform',
  kind: 'transform',
  plan: {
    schemaVersion: 1,
    user: {
      schemaVersion: 1,
      steps: [{ type: 'fit', mode: 'crop', width: 1080, height: 1920, anchor: 'center' }],
      output: {},
    },
  },
};

/**
 * Generates ordinary WorkflowInput drafts from persisted capability data. Presets never bypass
 * workflow validation, compilation, persistence, or execution.
 */
export class WorkflowPresetService {
  public constructor(
    private readonly accounts: Pick<AccountRepository, 'list'>,
    private readonly meta: Pick<MetaCredentialRepository, 'findCredential' | 'listTargets'>,
    private readonly sources: Pick<SourcePollingRepository, 'listConnections'>,
    private readonly options: WorkflowPresetServiceOptions,
  ) {}

  public list(): readonly WorkflowPresetSummary[] {
    const destinations = this.destinations();
    const sourceConnectionId = this.streamClipSourceId();
    return [
      this.summary(
        'obs-clip-short-form',
        'OBS clip → short-form',
        'Watch an OBS Replay Buffer folder, crop to 9:16, then publish to connected short-form destinations.',
        destinations,
      ),
      this.summary(
        'stream-clip-short-form',
        'Stream clip → short-form',
        'Use an authorized Twitch clip source, crop to 9:16, then publish through the same editable route.',
        destinations,
        sourceConnectionId,
      ),
    ];
  }

  public draft(id: StreamerWorkflowPresetId): WorkflowPresetDraft {
    const preset = this.list().find((candidate) => candidate.id === id);
    if (preset === undefined) throw new Error('Unknown workflow preset.');
    const blocking = preset.issues.find((issue) => issue.severity === 'blocking');
    if (blocking !== undefined) throw new Error(blocking.message);

    const destinations = this.destinations();
    const sourceStep: WorkflowStep = {
      id: 'source',
      kind: 'source',
      sourceType: id === 'obs-clip-short-form' ? 'watched_folder' : 'remote',
      ...(id === 'obs-clip-short-form'
        ? {
            watchedFolder: {
              filenameMetadata: 'obs' as const,
              preset: 'obs_replay_buffer' as const,
              settleMs: 5_000,
              sidecarMetadata: true,
            },
          }
        : {}),
    };
    const destinationSteps: WorkflowStep[] = destinations.map((destination, index) => ({
      id: `destination-${index + 1}`,
      kind: 'destination',
      destination,
    }));
    const steps: WorkflowStep[] = [sourceStep, verticalTransform, ...destinationSteps];
    const edges = [
      { from: 'source', to: 'transform' },
      ...destinationSteps.map((step) => ({ from: 'transform', to: step.id })),
    ];
    const remoteSource =
      id === 'stream-clip-short-form'
        ? {
            connectionId: preset.sourceConnectionId!,
            retentionPolicy: { kind: 'delete_after_success' as const },
            rightsConfirmed: false,
          }
        : undefined;

    return {
      preset,
      workflow: {
        name: preset.label,
        ...(id === 'obs-clip-short-form'
          ? { sourceDirectory: '' }
          : { remoteSource: remoteSource! }),
        titleTemplate: '{{source.title}}',
        descriptionTemplate: '',
        destinations,
        definition: { schemaVersion: 1, steps, edges },
        enabled: true,
      },
    };
  }

  private destinations(): readonly WorkflowDestination[] {
    const accounts = this.accounts.list();
    const youtube = accounts.find(
      (account) =>
        account.provider === 'youtube' &&
        account.status === 'connected' &&
        account.capabilities.includes('youtube.video.upload'),
    );
    const tiktok = accounts.find(
      (account) =>
        account.provider === 'tiktok' &&
        account.status === 'connected' &&
        account.capabilities.includes('tiktok.video.publish'),
    );
    const instagram = this.meta
      .listTargets()
      .find(
        (target) =>
          target.kind === 'instagram_professional' &&
          target.enabled &&
          target.availability === 'available' &&
          this.meta.findCredential(target.credentialId)?.status === 'connected',
      );
    return [
      ...(youtube === undefined
        ? []
        : [
            {
              destinationId: 'youtube' as const,
              accountId: youtube.id,
              privacy: 'private' as const,
            },
          ]),
      ...(tiktok === undefined
        ? []
        : [
            {
              destinationId: 'tiktok' as const,
              accountId: tiktok.id,
              privacyLevel: 'SELF_ONLY' as const,
            },
          ]),
      ...(instagram === undefined
        ? []
        : [{ destinationId: 'instagram' as const, accountId: instagram.id, shareToFeed: true }]),
    ];
  }

  private streamClipSourceId(): string | undefined {
    const accounts = new Map(this.accounts.list().map((account) => [account.id, account]));
    return this.sources.listConnections().find((source) => {
      if (source.adapterId !== 'twitch' || source.status !== 'active') return false;
      const accountId = source.configuration.accountId;
      const kind = source.configuration.kind;
      if (typeof accountId !== 'string' || kind !== 'clips') return false;
      const account = accounts.get(accountId);
      return (
        account?.status === 'connected' && account.capabilities.includes('twitch.clip.download')
      );
    })?.id;
  }

  private summary(
    id: StreamerWorkflowPresetId,
    label: string,
    description: string,
    destinations: readonly WorkflowDestination[],
    sourceConnectionId?: string,
  ): WorkflowPresetSummary {
    const destinationIds = destinations.map(
      (destination) => destination.destinationId,
    ) as WorkflowPresetSummary['destinationIds'];
    const issues: WorkflowPresetIssue[] = [];
    if (!this.options.transformAvailable)
      issues.push({
        code: 'TRANSFORM_UNAVAILABLE',
        message: 'Install FFmpeg before using a vertical short-form preset.',
        severity: 'blocking',
      });
    if (id === 'stream-clip-short-form' && sourceConnectionId === undefined)
      issues.push({
        code: 'SOURCE_UNAVAILABLE',
        message:
          'Add an active Twitch clips source with authorized clip download access. Twitch VOD and Kick metadata sources do not expose official media bytes.',
        severity: 'blocking',
      });
    if (destinationIds.length === 0)
      issues.push({
        code: 'DESTINATION_UNAVAILABLE',
        message: 'Connect at least one supported short-form publishing destination.',
        severity: 'blocking',
      });
    const missing = (['youtube', 'tiktok', 'instagram'] as const).filter(
      (destinationId) => !destinationIds.includes(destinationId),
    );
    if (destinationIds.length > 0 && missing.length > 0)
      issues.push({
        code: 'DESTINATION_UNAVAILABLE',
        message: `Unavailable destinations will be omitted: ${missing.join(', ')}.`,
        severity: 'warning',
      });
    return {
      id,
      label,
      description,
      destinationIds,
      issues,
      status: issues.some((issue) => issue.severity === 'blocking')
        ? 'blocked'
        : issues.length > 0
          ? 'partial'
          : 'ready',
      ...(sourceConnectionId === undefined ? {} : { sourceConnectionId }),
    };
  }
}
