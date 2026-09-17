import type { StructuredLogger } from './logger.js';
import type { SecretStore } from './secrets.js';
import type {
  DestinationCapabilities,
  PublishRequest,
  PublishResult,
  RemoteStatus,
  ValidationResult,
} from './types.js';

export interface AdapterContext {
  readonly idempotencyKey: string;
  readonly logger: StructuredLogger;
  readonly secretStore: SecretStore;
  readonly signal: AbortSignal;
}

export interface DestinationAdapter {
  readonly displayName: string;
  readonly id: string;
  capabilities(): Promise<DestinationCapabilities>;
  getStatus?(remoteId: string, context: AdapterContext): Promise<RemoteStatus>;
  publish(input: PublishRequest, context: AdapterContext): Promise<PublishResult>;
  validate(input: PublishRequest): Promise<ValidationResult>;
}

/** Composition-time registry; integrations self-register without provider-specific switches. */
export class DestinationRegistry {
  private readonly adapters = new Map<string, DestinationAdapter>();

  public constructor(adapters: readonly DestinationAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  public get(id: string): DestinationAdapter | undefined {
    return this.adapters.get(id);
  }

  public list(): readonly DestinationAdapter[] {
    return [...this.adapters.values()];
  }

  public register(adapter: DestinationAdapter): () => void {
    if (adapter.id.trim().length === 0) throw new Error('A destination adapter ID is required.');
    if (this.adapters.has(adapter.id))
      throw new Error(`Duplicate destination adapter: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
    return () => {
      if (this.adapters.get(adapter.id) === adapter) this.adapters.delete(adapter.id);
    };
  }

  public require(id: string): DestinationAdapter {
    const adapter = this.get(id);
    if (adapter === undefined) throw new Error(`Unknown destination adapter: ${id}`);
    return adapter;
  }
}
