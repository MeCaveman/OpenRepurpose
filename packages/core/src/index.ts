import { randomUUID } from 'node:crypto';

export type MediaAssetState = 'available' | 'missing';

export interface MediaProbeMetadata {
  readonly audioCodec?: string;
  readonly durationSeconds?: number;
  readonly frameRate?: number;
  readonly hasAudio: boolean;
  readonly height?: number;
  readonly videoCodec?: string;
  readonly width?: number;
}

export interface MediaAsset {
  readonly createdAt: Date;
  readonly fingerprint: string;
  readonly id: string;
  readonly metadata: MediaProbeMetadata;
  readonly modifiedAt: Date;
  readonly path: string;
  readonly sizeBytes: number;
  readonly state: MediaAssetState;
}

export interface InspectedLocalFile {
  readonly fingerprint: string;
  readonly modifiedAt: Date;
  readonly path: string;
  readonly sizeBytes: number;
}

export interface LocalFileInspector {
  inspect(path: string): Promise<InspectedLocalFile>;
}

export interface MediaProbe {
  probe(path: string): Promise<MediaProbeMetadata>;
}

export interface MediaRepository {
  create(asset: MediaAsset): MediaAsset;
  findByFingerprint(fingerprint: string): MediaAsset | undefined;
  list(): readonly MediaAsset[];
}

export type AccountProvider = 'youtube';
export type AccountStatus = 'connected' | 'reauthorization_required';
export type AccountCapability = 'youtube.identity.read' | 'youtube.video.upload';

/** Browser-safe account metadata. OAuth credentials and tokens live only in SecretStore. */
export interface ConnectedAccount {
  readonly capabilities: readonly AccountCapability[];
  readonly connectedAt: Date;
  readonly displayName: string;
  readonly externalId: string;
  readonly id: string;
  readonly provider: AccountProvider;
  readonly status: AccountStatus;
  readonly updatedAt: Date;
}

export interface UpsertConnectedAccountInput {
  readonly capabilities: readonly AccountCapability[];
  readonly connectedAt: Date;
  readonly displayName: string;
  readonly externalId: string;
  readonly id: string;
  readonly provider: AccountProvider;
  readonly status: AccountStatus;
  readonly updatedAt: Date;
}

export interface AccountRepository {
  findById(id: string): ConnectedAccount | undefined;
  list(): readonly ConnectedAccount[];
  remove(id: string): ConnectedAccount | undefined;
  setStatus(id: string, status: AccountStatus, updatedAt: Date): boolean;
  setProviderStatus(provider: AccountProvider, status: AccountStatus, updatedAt: Date): number;
  upsert(input: UpsertConnectedAccountInput): ConnectedAccount;
}

export interface OAuthAuthorizationRequest {
  readonly bindingHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly id: string;
  readonly provider: AccountProvider;
  readonly redirectUri: string;
  readonly stateHash: string;
}

/** Persistent, one-time OAuth state boundary so callbacks do not rely on process memory. */
export interface OAuthAuthorizationRequestRepository {
  consumeByStateHash(stateHash: string, bindingHash: string): OAuthAuthorizationRequest | undefined;
  create(request: OAuthAuthorizationRequest): void;
  deleteExpired(now: Date): readonly OAuthAuthorizationRequest[];
}

export interface ImportMediaResult {
  readonly asset: MediaAsset;
  readonly duplicate: boolean;
}

/** Application service shared by HTTP, CLI, and later workflow entry points. */
export class MediaImportService {
  public constructor(
    private readonly files: LocalFileInspector,
    private readonly probe: MediaProbe,
    private readonly repository: MediaRepository,
  ) {}

  public async import(path: string): Promise<ImportMediaResult> {
    const file = await this.files.inspect(path);
    const existing = this.repository.findByFingerprint(file.fingerprint);
    if (existing !== undefined) return { asset: existing, duplicate: true };

    const metadata = await this.probe.probe(file.path);
    const asset: MediaAsset = {
      createdAt: new Date(),
      fingerprint: file.fingerprint,
      id: randomUUID(),
      metadata,
      modifiedAt: file.modifiedAt,
      path: file.path,
      sizeBytes: file.sizeBytes,
      state: 'available',
    };
    return { asset: this.repository.create(asset), duplicate: false };
  }
}

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];

export type JobStatus = 'pending' | 'running' | 'retrying' | 'succeeded' | 'failed' | 'cancelled';

export type JobAttemptStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Job {
  readonly attemptCount: number;
  readonly availableAt: Date;
  readonly cancellationRequestedAt?: Date;
  readonly completedAt?: Date;
  readonly createdAt: Date;
  readonly id: string;
  readonly idempotencyKey?: string;
  readonly input: JsonValue;
  readonly lastErrorCode?: string;
  readonly lastErrorMessage?: string;
  readonly leaseExpiresAt?: Date;
  readonly leaseOwner?: string;
  readonly maxAttempts: number;
  readonly status: JobStatus;
  readonly type: string;
  readonly updatedAt: Date;
}

export interface JobAttempt {
  readonly attemptNumber: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly finishedAt?: Date;
  readonly id: string;
  readonly jobId: string;
  readonly leaseOwner: string;
  readonly retryable?: boolean;
  readonly startedAt: Date;
  readonly status: JobAttemptStatus;
}

export interface EnqueueJobInput {
  readonly availableAt?: Date;
  readonly id: string;
  readonly idempotencyKey?: string;
  readonly input: JsonValue;
  readonly maxAttempts: number;
  readonly now: Date;
  readonly type: string;
}

export interface EnqueueJobResult {
  readonly created: boolean;
  readonly job: Job;
}

export interface JobFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface JobRepository {
  cancelRunning(jobId: string, workerId: string, now: Date): boolean;
  claimNext(
    supportedTypes: readonly string[],
    workerId: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Job | undefined;
  complete(jobId: string, workerId: string, now: Date): boolean;
  enqueue(input: EnqueueJobInput): EnqueueJobResult;
  fail(jobId: string, workerId: string, failure: JobFailure, now: Date, retryAt?: Date): boolean;
  findById(id: string): Job | undefined;
  heartbeat(jobId: string, workerId: string, now: Date, leaseExpiresAt: Date): boolean;
  isCancellationRequested(jobId: string): boolean;
  list(status?: JobStatus): readonly Job[];
  listAttempts(jobId: string): readonly JobAttempt[];
  recoverExpiredLeases(now: Date): number;
  requestCancellation(id: string, now: Date): Job | undefined;
}

export interface CreateJobInput {
  readonly availableAt?: Date;
  readonly idempotencyKey?: string;
  readonly input: JsonValue;
  readonly maxAttempts?: number;
  readonly type: string;
}

export interface JobDetails {
  readonly attempts: readonly JobAttempt[];
  readonly job: Job;
}

function immutableJsonSnapshot(value: JsonValue): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Job input must be JSON serializable.');
  const parsed = JSON.parse(serialized) as JsonValue;
  const freeze = (candidate: JsonValue): JsonValue => {
    if (candidate !== null && typeof candidate === 'object') {
      for (const nested of Object.values(candidate)) freeze(nested);
      Object.freeze(candidate);
    }
    return candidate;
  };
  return freeze(parsed);
}

/** Shared application service used by HTTP, CLI, schedulers, and future workflow entry points. */
export class JobService {
  public constructor(
    private readonly repository: JobRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public create(input: CreateJobInput): EnqueueJobResult {
    if (input.type.trim().length === 0) throw new Error('A job type is required.');
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1)
      throw new Error('maxAttempts must be a positive integer.');
    const now = this.now();
    return this.repository.enqueue({
      id: randomUUID(),
      type: input.type,
      input: immutableJsonSnapshot(input.input),
      maxAttempts,
      now,
      ...(input.availableAt === undefined ? {} : { availableAt: input.availableAt }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    });
  }

  public list(status?: JobStatus): readonly Job[] {
    return this.repository.list(status);
  }

  public show(id: string): JobDetails | undefined {
    const job = this.repository.findById(id);
    return job === undefined ? undefined : { job, attempts: this.repository.listAttempts(id) };
  }

  public cancel(id: string): Job | undefined {
    return this.repository.requestCancellation(id, this.now());
  }
}

export interface JobHandlerContext {
  readonly attemptNumber: number;
  readonly idempotencyKey?: string;
  readonly jobId: string;
  readonly signal: AbortSignal;
}

export interface JobHandler {
  readonly type: string;
  execute(input: JsonValue, context: JobHandlerContext): Promise<void>;
}

/** A handler may throw this safe, classified error to opt into retry behavior. */
export class JobExecutionError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = 'JobExecutionError';
  }
}

export interface JobRunnerOptions {
  readonly baseRetryDelayMs?: number;
  readonly concurrency?: number;
  readonly leaseDurationMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly now?: () => Date;
  readonly pollIntervalMs?: number;
  readonly random?: () => number;
  readonly workerId?: string;
}

/** SQLite-independent persistent runner with bounded concurrency and cooperative cancellation. */
export class JobRunner {
  private readonly active = new Set<Promise<void>>();
  private readonly baseRetryDelayMs: number;
  private readonly concurrency: number;
  private filling = false;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly leaseDurationMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly now: () => Date;
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly pollIntervalMs: number;
  private readonly random: () => number;
  private started = false;
  private stopping = false;
  private readonly workerId: string;

  public constructor(
    private readonly repository: JobRepository,
    handlers: readonly JobHandler[],
    options: JobRunnerOptions = {},
  ) {
    this.concurrency = options.concurrency ?? 2;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.workerId = options.workerId ?? randomUUID();
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1)
      throw new Error('Job concurrency must be a positive integer.');
    if (this.leaseDurationMs < 20) throw new Error('Job leases must be at least 20ms.');
    if (this.pollIntervalMs < 10) throw new Error('Job polling must be at least 10ms.');
    if (this.baseRetryDelayMs < 0 || this.maxRetryDelayMs < this.baseRetryDelayMs)
      throw new Error('Job retry delays are invalid.');
    for (const handler of handlers) {
      if (this.handlers.has(handler.type))
        throw new Error(`Duplicate job handler: ${handler.type}`);
      this.handlers.set(handler.type, handler);
    }
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.repository.recoverExpiredLeases(this.now());
    void this.runOnce();
    this.pollTimer = setInterval(() => void this.runOnce(), this.pollIntervalMs);
  }

  /** Stops claiming work and waits for in-flight handlers to finish or observe cancellation. */
  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    await Promise.allSettled([...this.active]);
    this.started = false;
  }

  /** Claims up to the configured capacity and waits for just those claims; useful for deterministic tests. */
  public async runOnce(): Promise<void> {
    if (this.stopping || this.filling || this.handlers.size === 0) return;
    this.repository.recoverExpiredLeases(this.now());
    this.filling = true;
    const launched: Promise<void>[] = [];
    try {
      while (this.active.size < this.concurrency && !this.stopping) {
        const now = this.now();
        const job = this.repository.claimNext(
          [...this.handlers.keys()],
          this.workerId,
          now,
          new Date(now.getTime() + this.leaseDurationMs),
        );
        if (job === undefined) break;
        const execution = this.execute(job);
        this.active.add(execution);
        launched.push(execution);
        void execution.then(
          () => this.active.delete(execution),
          () => this.active.delete(execution),
        );
      }
    } finally {
      this.filling = false;
    }
    await Promise.allSettled(launched);
  }

  private retryAt(job: Job): Date {
    const exponential = Math.min(
      this.maxRetryDelayMs,
      this.baseRetryDelayMs * 2 ** Math.max(0, job.attemptCount - 1),
    );
    const random = Math.min(1, Math.max(0, this.random()));
    const jittered = Math.ceil(exponential * (0.5 + random * 0.5));
    return new Date(this.now().getTime() + jittered);
  }

  private async execute(job: Job): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (handler === undefined) return;
    const controller = new AbortController();
    const heartbeatInterval = Math.max(10, Math.min(1_000, Math.floor(this.leaseDurationMs / 3)));
    const heartbeat = setInterval(() => {
      const now = this.now();
      const cancellationRequested = this.repository.isCancellationRequested(job.id);
      const renewed = this.repository.heartbeat(
        job.id,
        this.workerId,
        now,
        new Date(now.getTime() + this.leaseDurationMs),
      );
      if (cancellationRequested || !renewed) controller.abort();
    }, heartbeatInterval);
    try {
      await handler.execute(job.input, {
        attemptNumber: job.attemptCount,
        jobId: job.id,
        signal: controller.signal,
        ...(job.idempotencyKey === undefined ? {} : { idempotencyKey: job.idempotencyKey }),
      });
      if (controller.signal.aborted || this.repository.isCancellationRequested(job.id)) {
        this.repository.cancelRunning(job.id, this.workerId, this.now());
      } else if (!this.repository.complete(job.id, this.workerId, this.now())) {
        this.repository.cancelRunning(job.id, this.workerId, this.now());
      }
    } catch (error) {
      if (controller.signal.aborted || this.repository.isCancellationRequested(job.id)) {
        this.repository.cancelRunning(job.id, this.workerId, this.now());
      } else {
        const failure: JobFailure =
          error instanceof JobExecutionError
            ? { code: error.code, message: error.publicMessage, retryable: error.retryable }
            : { code: 'UNEXPECTED_JOB_ERROR', message: 'Job execution failed.', retryable: false };
        const canRetry = failure.retryable && job.attemptCount < job.maxAttempts;
        this.repository.fail(
          job.id,
          this.workerId,
          failure,
          this.now(),
          ...(canRetry ? [this.retryAt(job)] : []),
        );
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
}
