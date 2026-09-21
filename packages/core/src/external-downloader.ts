export type ExternalDownloaderOperation = 'download';

export interface ExternalDownloaderCapabilities {
  readonly availability: 'available' | 'unavailable';
  readonly operations: readonly ExternalDownloaderOperation[];
  /** Implementation/tool version when detection succeeds. */
  readonly version?: string;
}

export interface ExternalDownloadRequest {
  /** Opaque remote locator discovered by a source adapter. */
  readonly locator: string;
}

export interface ExternalDownloadContext {
  /** The implementation must write the completed media bytes to this exact staging path. */
  readonly destinationPath: string;
  readonly signal: AbortSignal;
}

export interface ExternalDownloadResult {
  readonly destinationPath: string;
  /** Actual implementation/tool version used for this operation, when known. */
  readonly version?: string;
}

export type ExternalDownloaderFailureCode =
  | 'authentication_required'
  | 'cancelled'
  | 'download_failed'
  | 'rate_limited'
  | 'unavailable'
  | 'unsupported_locator';

/**
 * Stable, implementation-neutral failure returned across the external-downloader boundary.
 * Concrete adapters must not expose raw process output, command arguments, or secrets here.
 */
export class ExternalDownloaderError extends Error {
  public constructor(
    public readonly code: ExternalDownloaderFailureCode,
    public readonly retryable: boolean,
    publicMessage: string,
  ) {
    super(publicMessage);
    this.name = 'ExternalDownloaderError';
  }
}

/**
 * Port for an optional infrastructure adapter that obtains authorized remote media. Implementations
 * own executable discovery, arguments, version parsing, process output, and implementation config.
 */
export interface ExternalDownloader {
  readonly id: string;
  capabilities(): Promise<ExternalDownloaderCapabilities>;
  supports(request: ExternalDownloadRequest): boolean;
  download(
    request: ExternalDownloadRequest,
    context: ExternalDownloadContext,
  ): Promise<ExternalDownloadResult>;
}

/** Composition-time registry; disabled or unconfigured implementations are simply not registered. */
export class ExternalDownloaderRegistry {
  private readonly downloaders = new Map<string, ExternalDownloader>();

  public constructor(downloaders: readonly ExternalDownloader[] = []) {
    for (const downloader of downloaders) this.register(downloader);
  }

  public get(id: string): ExternalDownloader | undefined {
    return this.downloaders.get(id);
  }

  public list(): readonly ExternalDownloader[] {
    return [...this.downloaders.values()];
  }

  public register(downloader: ExternalDownloader): () => void {
    if (downloader.id.trim().length === 0)
      throw new Error('An external downloader ID is required.');
    if (this.downloaders.has(downloader.id))
      throw new Error(`Duplicate external downloader: ${downloader.id}`);
    this.downloaders.set(downloader.id, downloader);
    return () => {
      if (this.downloaders.get(downloader.id) === downloader)
        this.downloaders.delete(downloader.id);
    };
  }

  public require(id: string): ExternalDownloader {
    const downloader = this.get(id);
    if (downloader === undefined) throw new Error(`Unknown external downloader: ${id}`);
    return downloader;
  }
}
