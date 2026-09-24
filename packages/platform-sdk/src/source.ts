import type { StructuredLogger } from './logger.js';
import type { SecretStore } from './secrets.js';
import type { PluginJsonValue } from './types.js';

export type SourceJsonValue = PluginJsonValue;

export interface SourceCapabilities {
  readonly eventIds: boolean;
  readonly mediaResolution: readonly (
    'external_downloader' | 'local_original' | 'official_download'
  )[];
  readonly polling: boolean;
}

export type SourceMediaResolutionStrategy =
  'external_downloader' | 'local_original' | 'official_download';

export interface SourceMediaDescriptor {
  readonly availability: 'available' | 'unavailable' | 'unknown';
  /** Generic handoff data only; source accounts and downloader configuration remain separate. */
  readonly externalDownload?: { readonly locator: string };
  readonly resolutionStrategies: readonly SourceMediaResolutionStrategy[];
  /** External downloaders always require an explicit acknowledgement for authorized content. */
  readonly rightsRequirement: 'connection_authorization' | 'explicit_confirmation';
}

/**
 * Browser-safe observation returned by a source adapter. `externalId` is the stable item identity
 * within one source connection; event IDs are audit hints and never replace it for deduplication.
 */
export interface SourceItemObservation {
  readonly eventId?: string;
  readonly externalId: string;
  readonly media?: SourceMediaDescriptor;
  readonly metadata: Readonly<Record<string, SourceJsonValue>>;
  readonly publishedAt?: string;
}

export interface SourcePollRequest {
  /** Adapter-specific, browser-safe source configuration persisted with the connection. */
  readonly configuration: Readonly<Record<string, SourceJsonValue>>;
  readonly connectionExternalId: string;
  /** Adapter-owned opaque value. The application persists it only after the poll page is durable. */
  readonly cursor: string | null;
}

export interface SourcePollResult {
  /** True means another page can be requested immediately with this result's cursor. */
  readonly hasMore: boolean;
  readonly items: readonly SourceItemObservation[];
  /** Null is a valid adapter-defined initial/final cursor; non-null cursors must not be blank. */
  readonly cursor: string | null;
}

export interface SourceAdapterContext {
  readonly logger: StructuredLogger;
  readonly secretStore: SecretStore;
  readonly signal: AbortSignal;
}

/** Detection-only boundary. Media resolution is deliberately a separate later-packet contract. */
export interface SourceAdapter {
  readonly displayName: string;
  readonly id: string;
  capabilities(): Promise<SourceCapabilities>;
  poll(request: SourcePollRequest, context: SourceAdapterContext): Promise<SourcePollResult>;
}

/** Reject malformed pages before any cursor advancement or source-item persistence is attempted. */
export function validateSourcePollResult(result: SourcePollResult): void {
  if (typeof result.cursor === 'string' && result.cursor.trim().length === 0)
    throw new Error('A source cursor must be null or a non-empty opaque value.');
  if (result.hasMore && result.cursor === null)
    throw new Error('A paginated source result requires a continuation cursor.');

  const externalIds = new Set<string>();
  for (const item of result.items) {
    if (item.externalId.trim().length === 0)
      throw new Error('Every source item requires a stable external ID.');
    if (externalIds.has(item.externalId))
      throw new Error(`A source poll page contains duplicate external ID: ${item.externalId}`);
    externalIds.add(item.externalId);
    if (item.eventId !== undefined && item.eventId.trim().length === 0)
      throw new Error('A source event ID must be omitted or non-empty.');
    if (item.publishedAt !== undefined && !Number.isFinite(Date.parse(item.publishedAt)))
      throw new Error(`Invalid source publishedAt timestamp for ${item.externalId}.`);
    const externalDownload = item.media?.externalDownload;
    if (externalDownload !== undefined && externalDownload.locator.trim().length === 0)
      throw new Error(`External download locator must be non-empty for ${item.externalId}.`);
    if (
      item.media?.resolutionStrategies.includes('external_downloader') === true &&
      externalDownload === undefined
    )
      throw new Error(
        `External downloader resolution requires a generic locator for ${item.externalId}.`,
      );
  }
}

/** Composition-time registry; source integrations register without provider-specific switches. */
export class SourceRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  public constructor(adapters: readonly SourceAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  public get(id: string): SourceAdapter | undefined {
    return this.adapters.get(id);
  }

  public list(): readonly SourceAdapter[] {
    return [...this.adapters.values()];
  }

  public register(adapter: SourceAdapter): () => void {
    if (adapter.id.trim().length === 0) throw new Error('A source adapter ID is required.');
    if (this.adapters.has(adapter.id)) throw new Error(`Duplicate source adapter: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
    return () => {
      if (this.adapters.get(adapter.id) === adapter) this.adapters.delete(adapter.id);
    };
  }

  public require(id: string): SourceAdapter {
    const adapter = this.get(id);
    if (adapter === undefined) throw new Error(`Unknown source adapter: ${id}`);
    return adapter;
  }
}
