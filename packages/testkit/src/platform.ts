import {
  secretReferenceKey,
  type AdapterContext,
  type DestinationAdapter,
  type DestinationCapabilities,
  type PublishRequest,
  type PublishResult,
  type RemoteStatus,
  type SecretReference,
  type SecretStore,
  type SourceAdapter,
  type SourceAdapterContext,
  type SourceCapabilities,
  type SourcePollRequest,
  type SourcePollResult,
  type ValidationResult,
} from '@openrepurpose/platform-sdk';

export const mockDestinationCapabilities: DestinationCapabilities = {
  media: { kinds: ['video'], maxFileSizeBytes: 1_000_000_000 },
  metadata: {
    category: { required: false, supported: true },
    description: { maxLength: 5_000, required: false, supported: true },
    tags: { maxItems: 20, supported: true },
    title: { maxLength: 100, required: true, supported: true },
  },
  privacy: { supported: true, values: ['private', 'unlisted', 'public'] },
  resumableUpload: true,
  statusPolling: true,
};

export interface MockDestinationAdapterOptions {
  readonly capabilities?: DestinationCapabilities;
  readonly displayName?: string;
  readonly id?: string;
  readonly publishResult?: PublishResult;
  readonly remoteStatus?: RemoteStatus;
  readonly validationResult?: ValidationResult;
}

/** Reusable deterministic destination fake; it performs no network or filesystem operations. */
export class MockDestinationAdapter implements DestinationAdapter {
  public readonly displayName: string;
  public readonly id: string;
  public readonly publishCalls: Array<{
    readonly context: AdapterContext;
    readonly input: PublishRequest;
  }> = [];
  public readonly statusCalls: Array<{
    readonly context: AdapterContext;
    readonly remoteId: string;
  }> = [];
  public readonly validationCalls: PublishRequest[] = [];

  private readonly configuredCapabilities: DestinationCapabilities;
  private readonly configuredPublishResult: PublishResult;
  private readonly configuredRemoteStatus: RemoteStatus;
  private readonly configuredValidationResult: ValidationResult;

  public constructor(options: MockDestinationAdapterOptions = {}) {
    this.id = options.id ?? 'mock';
    this.displayName = options.displayName ?? 'Mock destination';
    this.configuredCapabilities = options.capabilities ?? mockDestinationCapabilities;
    this.configuredPublishResult =
      options.publishResult ??
      ({ remoteId: 'mock-remote-id', state: 'processing' } satisfies PublishResult);
    this.configuredRemoteStatus = options.remoteStatus ?? { state: 'published' };
    this.configuredValidationResult = options.validationResult ?? { valid: true };
  }

  public async capabilities(): Promise<DestinationCapabilities> {
    return this.configuredCapabilities;
  }

  public async getStatus(remoteId: string, context: AdapterContext): Promise<RemoteStatus> {
    this.statusCalls.push({ context, remoteId });
    return this.configuredRemoteStatus;
  }

  public async publish(input: PublishRequest, context: AdapterContext): Promise<PublishResult> {
    this.publishCalls.push({ context, input });
    return this.configuredPublishResult;
  }

  public async validate(input: PublishRequest): Promise<ValidationResult> {
    this.validationCalls.push(input);
    return this.configuredValidationResult;
  }
}

export const mockSourceCapabilities: SourceCapabilities = {
  eventIds: true,
  mediaResolution: ['local_original', 'official_download'],
  polling: true,
};

export interface MockSourceAdapterOptions {
  readonly capabilities?: SourceCapabilities;
  readonly displayName?: string;
  readonly id?: string;
  readonly pollResults?: readonly SourcePollResult[];
}

/** Reusable deterministic source fake; repeated calls use the last configured page. */
export class MockSourceAdapter implements SourceAdapter {
  public readonly displayName: string;
  public readonly id: string;
  public readonly pollCalls: Array<{
    readonly context: SourceAdapterContext;
    readonly request: SourcePollRequest;
  }> = [];

  private readonly configuredCapabilities: SourceCapabilities;
  private readonly pollResults: readonly SourcePollResult[];

  public constructor(options: MockSourceAdapterOptions = {}) {
    this.id = options.id ?? 'mock-source';
    this.displayName = options.displayName ?? 'Mock source';
    this.configuredCapabilities = options.capabilities ?? mockSourceCapabilities;
    this.pollResults = options.pollResults ?? [
      {
        cursor: 'cursor-1',
        hasMore: false,
        items: [
          {
            eventId: 'event-1',
            externalId: 'item-1',
            media: {
              availability: 'available',
              resolutionStrategies: ['local_original', 'official_download'],
              rightsRequirement: 'connection_authorization',
            },
            metadata: { title: 'First item' },
            publishedAt: '2026-09-18T00:00:00.000Z',
          },
        ],
      },
    ];
  }

  public async capabilities(): Promise<SourceCapabilities> {
    return this.configuredCapabilities;
  }

  public async poll(
    request: SourcePollRequest,
    context: SourceAdapterContext,
  ): Promise<SourcePollResult> {
    this.pollCalls.push({ context, request });
    const index = Math.min(this.pollCalls.length - 1, this.pollResults.length - 1);
    const result = this.pollResults[index];
    if (result === undefined)
      throw new Error('MockSourceAdapter requires at least one poll result.');
    return result;
  }
}

/** Test-only SecretStore implementation. Production packets must provide protected persistence. */
export class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  public async delete(reference: SecretReference): Promise<boolean> {
    return this.values.delete(secretReferenceKey(reference));
  }

  public async get(reference: SecretReference): Promise<string | undefined> {
    return this.values.get(secretReferenceKey(reference));
  }

  public async set(reference: SecretReference, value: string): Promise<void> {
    this.values.set(secretReferenceKey(reference), value);
  }
}
