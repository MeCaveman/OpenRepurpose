import {
  secretReferenceKey,
  type AdapterContext,
  type DestinationAdapter,
  type DestinationCapabilities,
  type DestinationJobAdapter,
  isPluginApiCompatible,
  parsePluginManifest,
  type PublishRequest,
  type PublishResult,
  type PluginManifest,
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

function contractFailure(message: string): never {
  throw new Error(`Plugin contract violation: ${message}`);
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) contractFailure(`${label} must be non-empty.`);
}

function assertDestinationCapabilities(capabilities: DestinationCapabilities, id: string): void {
  if (capabilities.media.kinds.length === 0)
    contractFailure(`destination ${id} must support at least one media kind.`);
  if (new Set(capabilities.media.kinds).size !== capabilities.media.kinds.length)
    contractFailure(`destination ${id} contains duplicate media kinds.`);
  if (capabilities.privacy.supported !== capabilities.privacy.values.length > 0)
    contractFailure(`destination ${id} has inconsistent privacy capabilities.`);
  for (const [name, field] of Object.entries(capabilities.metadata)) {
    if ('required' in field && field.required && !field.supported)
      contractFailure(`destination ${id} marks unsupported metadata ${name} as required.`);
  }
}

export async function runDestinationAdapterContract(adapter: DestinationAdapter): Promise<void> {
  assertNonEmpty(adapter.id, 'destination ID');
  assertNonEmpty(adapter.displayName, `destination ${adapter.id} display name`);
  assertDestinationCapabilities(await adapter.capabilities(), adapter.id);
  if (typeof adapter.validate !== 'function' || typeof adapter.publish !== 'function')
    contractFailure(`destination ${adapter.id} is missing required methods.`);
}

export async function runDestinationJobAdapterContract(
  adapter: DestinationJobAdapter,
): Promise<void> {
  assertNonEmpty(adapter.id, 'destination ID');
  assertNonEmpty(adapter.displayName, `destination ${adapter.id} display name`);
  assertNonEmpty(adapter.type, `destination ${adapter.id} job type`);
  assertDestinationCapabilities(await adapter.capabilities(), adapter.id);
  if (typeof adapter.execute !== 'function')
    contractFailure(`destination ${adapter.id} is missing execute().`);
}

export async function runSourceAdapterContract(adapter: SourceAdapter): Promise<void> {
  assertNonEmpty(adapter.id, 'source ID');
  assertNonEmpty(adapter.displayName, `source ${adapter.id} display name`);
  const capabilities = await adapter.capabilities();
  if (!capabilities.polling) contractFailure(`source ${adapter.id} must support polling in v1.`);
  if (new Set(capabilities.mediaResolution).size !== capabilities.mediaResolution.length)
    contractFailure(`source ${adapter.id} contains duplicate media-resolution strategies.`);
  if (typeof adapter.poll !== 'function')
    contractFailure(`source ${adapter.id} is missing poll().`);
}

export interface PluginContractSubject {
  readonly destinations?: readonly DestinationJobAdapter[];
  readonly manifest: PluginManifest;
  readonly sources?: readonly SourceAdapter[];
}

/** Verifies a manifest and requires its declared source/destination contributions to match runtime adapters. */
export async function runPluginContract(subject: PluginContractSubject): Promise<void> {
  const manifest = parsePluginManifest(subject.manifest);
  if (!isPluginApiCompatible(manifest.requiredApiVersion))
    contractFailure(`${manifest.id} is incompatible with the current plugin API.`);

  const sources = subject.sources ?? [];
  const destinations = subject.destinations ?? [];
  await Promise.all(sources.map(runSourceAdapterContract));
  await Promise.all(destinations.map(runDestinationJobAdapterContract));

  const declaredSources = manifest.capabilities
    .filter((capability) => capability.kind === 'source')
    .map((capability) => capability.id)
    .sort();
  const runtimeSources = sources.map((adapter) => adapter.id).sort();
  if (JSON.stringify(declaredSources) !== JSON.stringify(runtimeSources))
    contractFailure(`${manifest.id} source declarations do not match runtime adapters.`);

  const declaredDestinations = manifest.capabilities
    .filter((capability) => capability.kind === 'destination')
    .map((capability) => `${capability.id}:${capability.jobType}`)
    .sort();
  const runtimeDestinations = destinations.map((adapter) => `${adapter.id}:${adapter.type}`).sort();
  if (JSON.stringify(declaredDestinations) !== JSON.stringify(runtimeDestinations))
    contractFailure(`${manifest.id} destination declarations do not match runtime adapters.`);
}

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
