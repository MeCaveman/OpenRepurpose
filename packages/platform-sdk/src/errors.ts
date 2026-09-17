export type PlatformErrorCategory =
  | 'authentication'
  | 'authorization'
  | 'configuration'
  | 'media'
  | 'network'
  | 'quota'
  | 'rate_limit'
  | 'remote'
  | 'validation';

export interface PlatformErrorOptions {
  readonly category: PlatformErrorCategory;
  readonly code: string;
  readonly cause?: unknown;
  readonly publicMessage: string;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
}

/** Stable platform failure classification with a deliberately safe user-facing message. */
export class PlatformError extends Error {
  public readonly category: PlatformErrorCategory;
  public readonly code: string;
  public readonly publicMessage: string;
  public readonly retryAfterMs?: number;
  public readonly retryable: boolean;

  public constructor(options: PlatformErrorOptions) {
    super(
      options.publicMessage,
      ...(options.cause === undefined ? [] : [{ cause: options.cause }]),
    );
    this.name = 'PlatformError';
    this.category = options.category;
    this.code = options.code;
    this.publicMessage = options.publicMessage;
    this.retryable = options.retryable;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export function isPlatformError(error: unknown): error is PlatformError {
  return error instanceof PlatformError;
}
