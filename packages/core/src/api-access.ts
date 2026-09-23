import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export type ApiPermission = 'control' | 'read';

export interface ApiTokenRecord {
  readonly createdAt: Date;
  readonly id: string;
  readonly lastUsedAt?: Date;
  readonly name: string;
  readonly permissions: readonly ApiPermission[];
  readonly revokedAt?: Date;
  readonly verifier: string;
}

export type ApiTokenMetadata = Omit<ApiTokenRecord, 'verifier'>;

export interface ApiTokenRepository {
  create(record: ApiTokenRecord): ApiTokenRecord;
  find(id: string): ApiTokenRecord | undefined;
  list(): readonly ApiTokenRecord[];
  markUsed(id: string, usedAt: Date): void;
  revoke(id: string, revokedAt: Date): ApiTokenRecord | undefined;
}

export interface CreatedApiToken {
  readonly token: string;
  readonly metadata: ApiTokenMetadata;
}

export interface AuthenticatedApiToken {
  readonly id: string;
  readonly name: string;
  readonly permissions: readonly ApiPermission[];
}

function tokenVerifier(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function safeMetadata(record: ApiTokenRecord): ApiTokenMetadata {
  return {
    createdAt: record.createdAt,
    id: record.id,
    ...(record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt }),
    name: record.name,
    permissions: record.permissions,
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
  };
}

/** Issues high-entropy bearer credentials while persisting only a non-recoverable verifier. */
export class ApiTokenService {
  public constructor(
    private readonly repository: ApiTokenRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public create(name: string, permissions: readonly ApiPermission[]): CreatedApiToken {
    const normalizedName = name.trim();
    if (normalizedName.length === 0 || normalizedName.length > 120)
      throw new Error('API token name must contain between 1 and 120 characters.');
    const normalizedPermissions = [...new Set(permissions)].sort();
    if (
      normalizedPermissions.length === 0 ||
      normalizedPermissions.some((permission) => permission !== 'read' && permission !== 'control')
    )
      throw new Error('At least one supported API permission is required.');
    if (normalizedPermissions.includes('control') && !normalizedPermissions.includes('read'))
      normalizedPermissions.push('read');
    normalizedPermissions.sort();
    const id = randomUUID();
    const token = `orp_v1_${id}_${randomBytes(32).toString('base64url')}`;
    const record = this.repository.create({
      createdAt: this.now(),
      id,
      name: normalizedName,
      permissions: normalizedPermissions,
      verifier: tokenVerifier(token),
    });
    return { metadata: safeMetadata(record), token };
  }

  public authenticate(token: string): AuthenticatedApiToken | undefined {
    if (token.length > 256) return undefined;
    const match = /^orp_v1_([0-9a-f-]{36})_([A-Za-z0-9_-]{43})$/u.exec(token);
    if (match === null || match[1] === undefined) return undefined;
    const record = this.repository.find(match[1]);
    if (record === undefined || record.revokedAt !== undefined) return undefined;
    const expected = Buffer.from(record.verifier, 'hex');
    const actual = Buffer.from(tokenVerifier(token), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
    this.repository.markUsed(record.id, this.now());
    return { id: record.id, name: record.name, permissions: record.permissions };
  }

  public list(): readonly ApiTokenMetadata[] {
    return this.repository.list().map(safeMetadata);
  }

  public revoke(id: string): ApiTokenMetadata | undefined {
    const record = this.repository.revoke(id, this.now());
    return record === undefined ? undefined : safeMetadata(record);
  }
}

export interface ApiIdempotencyRecord {
  readonly createdAt: Date;
  readonly key: string;
  readonly operation: string;
  readonly requestHash: string;
  readonly response?: unknown;
  readonly status: 'completed' | 'pending';
  readonly statusCode?: number;
  readonly subject: string;
  readonly updatedAt: Date;
}

export interface ApiIdempotencyRepository {
  begin(
    record: ApiIdempotencyRecord,
  ):
    | { readonly kind: 'acquired' }
    | { readonly kind: 'existing'; readonly record: ApiIdempotencyRecord };
  complete(input: {
    readonly key: string;
    readonly operation: string;
    readonly response: unknown;
    readonly statusCode: number;
    readonly subject: string;
    readonly updatedAt: Date;
  }): void;
  release(subject: string, operation: string, key: string): void;
}

export class ApiIdempotencyConflictError extends Error {
  public constructor(public readonly code: 'IDEMPOTENCY_IN_PROGRESS' | 'IDEMPOTENCY_KEY_REUSED') {
    super(
      code === 'IDEMPOTENCY_IN_PROGRESS'
        ? 'A request with this idempotency key is still in progress.'
        : 'This idempotency key was already used with a different request.',
    );
    this.name = 'ApiIdempotencyConflictError';
  }
}

export interface IdempotentResult<T> {
  readonly replayed: boolean;
  readonly statusCode: number;
  readonly value: T;
}

/** Coordinates replay-safe side effects independently of the HTTP transport. */
export class ApiIdempotencyService {
  public constructor(
    private readonly repository: ApiIdempotencyRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async execute<T>(input: {
    readonly key: string;
    readonly operation: string;
    readonly request: unknown;
    readonly run: () => Promise<{ readonly statusCode: number; readonly value: T }>;
    readonly subject: string;
  }): Promise<IdempotentResult<T>> {
    const requestHash = createHash('sha256').update(JSON.stringify(input.request)).digest('hex');
    const now = this.now();
    const reservation = this.repository.begin({
      createdAt: now,
      key: input.key,
      operation: input.operation,
      requestHash,
      status: 'pending',
      subject: input.subject,
      updatedAt: now,
    });
    if (reservation.kind === 'existing') {
      if (reservation.record.requestHash !== requestHash)
        throw new ApiIdempotencyConflictError('IDEMPOTENCY_KEY_REUSED');
      if (reservation.record.status !== 'completed' || reservation.record.statusCode === undefined)
        throw new ApiIdempotencyConflictError('IDEMPOTENCY_IN_PROGRESS');
      return {
        replayed: true,
        statusCode: reservation.record.statusCode,
        value: reservation.record.response as T,
      };
    }
    try {
      const result = await input.run();
      const response = JSON.parse(JSON.stringify(result.value)) as T;
      this.repository.complete({
        key: input.key,
        operation: input.operation,
        response,
        statusCode: result.statusCode,
        subject: input.subject,
        updatedAt: this.now(),
      });
      return { replayed: false, statusCode: result.statusCode, value: response };
    } catch (error) {
      this.repository.release(input.subject, input.operation, input.key);
      throw error;
    }
  }
}
