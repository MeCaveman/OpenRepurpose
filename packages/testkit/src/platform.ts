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
