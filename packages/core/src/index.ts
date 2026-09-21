import { createHash, randomUUID } from 'node:crypto';
import {
  isPlatformError,
  validateSourcePollResult,
  type SourceAdapterContext,
  type SourceItemObservation,
  type SourceJsonValue,
  type SourceMediaDescriptor,
  type SourceMediaResolutionStrategy,
  type SourceRegistry,
} from '@openrepurpose/platform-sdk';
import {
  createTransformCacheIdentity,
  normalizeTransformPlan,
  type TransformDerivative,
  type TransformDerivativeRepository,
  type TransformDerivativeStatus,
  type TransformPlanInput,
  type TransformToolIdentity,
} from './transform.js';
import {
  ExternalDownloaderError,
  type ExternalDownloader,
  type ExternalDownloaderFailureCode,
  type ExternalDownloaderRegistry,
} from './external-downloader.js';
import {
  createCaptionRenderStep,
  type Transcript,
  type TranscriptionModel,
  type TranscriptionOptionValue,
  type WorkflowTranscriptionService,
} from './transcription.js';
import type { CaptionsTransform } from './transform.js';
export type {
  SourceItemObservation,
  SourceJsonValue,
  SourceMediaDescriptor,
  SourceMediaResolutionStrategy,
} from '@openrepurpose/platform-sdk';
export * from './schedule.js';
export * from './external-downloader.js';
export * from './transcription.js';
export * from './transform.js';

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
  readonly dependsOnJobId?: string;
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
  findById(id: string): MediaAsset | undefined;
  findByFingerprint(fingerprint: string): MediaAsset | undefined;
  list(): readonly MediaAsset[];
}

export type AccountProvider = 'meta' | 'tiktok' | 'youtube';
export type AccountStatus = 'connected' | 'reauthorization_required';
export type AccountCapability =
  | 'tiktok.identity.read'
  | 'tiktok.video.publish'
  | 'meta.identity.read'
  | 'meta.pages.read'
  | 'youtube.identity.read'
  | 'youtube.video.upload';

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

/** Meta keeps the authorizing person separate from the Page/Instagram targets they can publish to. */
export type MetaCredentialStatus = 'connected' | 'reauthorization_required';
export type MetaTargetKind = 'facebook_page' | 'instagram_professional';
export type MetaTargetAvailability = 'available' | 'blocked';

export interface MetaCredential {
  readonly connectedAt: Date;
  readonly displayName: string;
  readonly externalId: string;
  readonly id: string;
  readonly scopes: readonly string[];
  readonly status: MetaCredentialStatus;
  readonly tokenExpiresAt: Date;
  readonly updatedAt: Date;
}

export interface MetaPublishTarget {
  readonly availability: MetaTargetAvailability;
  readonly blocker?: string;
  readonly credentialId: string;
  readonly displayName: string;
  readonly externalId: string;
  readonly id: string;
  readonly kind: MetaTargetKind;
  readonly pageId: string;
  readonly username?: string;
  readonly enabled: boolean;
  readonly updatedAt: Date;
}

export type UpsertMetaCredentialInput = MetaCredential;
export type UpsertMetaPublishTargetInput = MetaPublishTarget;

export interface MetaCredentialRepository {
  findCredential(id: string): MetaCredential | undefined;
  listCredentials(): readonly MetaCredential[];
  listTargets(credentialId?: string): readonly MetaPublishTarget[];
  markTargetUnavailable(id: string, blocker: string, updatedAt: Date): boolean;
  removeCredential(id: string): MetaCredential | undefined;
  setCredentialStatus(id: string, status: MetaCredentialStatus, updatedAt: Date): boolean;
  setTargetEnabled(id: string, enabled: boolean, updatedAt: Date): boolean;
  upsertCredential(input: UpsertMetaCredentialInput): MetaCredential;
  upsertTarget(input: UpsertMetaPublishTargetInput): MetaPublishTarget;
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

  public async import(
    path: string,
    options: { readonly deduplicate?: boolean } = {},
  ): Promise<ImportMediaResult> {
    const file = await this.files.inspect(path);
    if (options.deduplicate !== false) {
      const existing = this.repository.findByFingerprint(file.fingerprint);
      if (existing !== undefined) return { asset: existing, duplicate: true };
    }

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
  readonly accountId?: string;
  readonly attemptCount: number;
  readonly availableAt: Date;
  readonly cancellationRequestedAt?: Date;
  readonly completedAt?: Date;
  readonly createdAt: Date;
  readonly dependsOnJobId?: string;
  readonly id: string;
  readonly idempotencyKey?: string;
  readonly input: JsonValue;
  readonly lastErrorCode?: string;
  readonly lastErrorMessage?: string;
  readonly leaseExpiresAt?: Date;
  readonly leaseOwner?: string;
  readonly maxAttempts: number;
  readonly platformId?: string;
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
  readonly accountId?: string;
  readonly availableAt?: Date;
  readonly id: string;
  readonly dependsOnJobId?: string;
  readonly idempotencyKey?: string;
  readonly input: JsonValue;
  readonly maxAttempts: number;
  readonly now: Date;
  readonly platformId?: string;
  readonly type: string;
}

export interface EnqueueJobResult {
  readonly created: boolean;
  readonly job: Job;
}

export interface JobFailure {
  readonly category?: JobFailureCategory;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

export type JobFailureCategory = 'authentication' | 'authorization' | 'rate_limit';
export type JobQueueMode = 'draining' | 'paused' | 'running';

export interface JobQueueState {
  readonly mode: JobQueueMode;
  readonly updatedAt: Date;
}

export interface JobAccountControl {
  readonly accountId: string;
  readonly authFailureCount: number;
  readonly cooldownUntil?: Date;
  readonly pauseReason?: string;
  readonly platformId: string;
  readonly status: 'active' | 'paused';
  readonly updatedAt: Date;
}

export interface JobClaimLimits {
  readonly accountConcurrency: number;
  readonly globalConcurrency: number;
  readonly platformConcurrency: number;
}

export interface JobRepository {
  cancelRunning(jobId: string, workerId: string, now: Date): boolean;
  claimNext(
    supportedTypes: readonly string[],
    workerId: string,
    now: Date,
    leaseExpiresAt: Date,
    limits?: JobClaimLimits,
  ): Job | undefined;
  complete(jobId: string, workerId: string, now: Date): boolean;
  countRunning(): number;
  enqueue(input: EnqueueJobInput): EnqueueJobResult;
  fail(
    jobId: string,
    workerId: string,
    failure: JobFailure,
    now: Date,
    retryAt?: Date,
    authFailureThreshold?: number,
  ): boolean;
  getAccountControl(platformId: string, accountId: string): JobAccountControl | undefined;
  getQueueState(): JobQueueState;
  findById(id: string): Job | undefined;
  heartbeat(jobId: string, workerId: string, now: Date, leaseExpiresAt: Date): boolean;
  isCancellationRequested(jobId: string): boolean;
  list(status?: JobStatus): readonly Job[];
  listAttempts(jobId: string): readonly JobAttempt[];
  recoverExpiredLeases(now: Date): number;
  requestCancellation(id: string, now: Date): Job | undefined;
  resumeAccount(platformId: string, accountId: string, now: Date): JobAccountControl;
  retry(id: string, now: Date): Job | undefined;
  setQueueMode(mode: JobQueueMode, now: Date): JobQueueState;
}

/** Durable external-operation checkpoint owned by a destination job. */
export interface DestinationJobRecord {
  readonly destinationId: string;
  readonly jobId: string;
  readonly remoteId?: string;
  readonly remoteStatus: string;
  readonly remoteUrl?: string;
  readonly resumableSessionUrl?: string;
  readonly uploadedBytes: number;
  readonly updatedAt: Date;
}

/** Separate from the queue so adapters can checkpoint remote work across process restarts. */
export interface DestinationJobRepository {
  find(jobId: string): DestinationJobRecord | undefined;
  save(record: DestinationJobRecord): DestinationJobRecord;
}

export interface CreateJobInput {
  readonly accountId?: string;
  readonly availableAt?: Date;
  readonly idempotencyKey?: string;
  /** The job is claimable only after this prerequisite succeeds. */
  readonly dependsOnJobId?: string;
  readonly input: JsonValue;
  readonly maxAttempts?: number;
  readonly platformId?: string;
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
    const inferredScope = inferJobConcurrencyScope(input.type, input.input);
    const platformId = input.platformId ?? inferredScope?.platformId;
    const accountId = input.accountId ?? inferredScope?.accountId;
    return this.repository.enqueue({
      id: randomUUID(),
      type: input.type,
      input: immutableJsonSnapshot(input.input),
      maxAttempts,
      now,
      ...(platformId === undefined ? {} : { platformId }),
      ...(accountId === undefined ? {} : { accountId }),
      ...(input.availableAt === undefined ? {} : { availableAt: input.availableAt }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      ...(input.dependsOnJobId === undefined ? {} : { dependsOnJobId: input.dependsOnJobId }),
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

  public retry(id: string): Job | undefined {
    return this.repository.retry(id, this.now());
  }

  public queueState(): JobQueueState {
    return this.repository.getQueueState();
  }

  public pauseQueue(): JobQueueState {
    return this.repository.setQueueMode('paused', this.now());
  }

  public resumeQueue(): JobQueueState {
    return this.repository.setQueueMode('running', this.now());
  }

  public drainQueue(): JobQueueState {
    return this.repository.setQueueMode('draining', this.now());
  }

  public accountControl(platformId: string, accountId: string): JobAccountControl | undefined {
    return this.repository.getAccountControl(platformId, accountId);
  }

  public resumeAccount(platformId: string, accountId: string): JobAccountControl {
    return this.repository.resumeAccount(platformId, accountId, this.now());
  }
}

function inferJobConcurrencyScope(
  type: string,
  input: JsonValue,
): { readonly accountId: string; readonly platformId: string } | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Readonly<Record<string, JsonValue>>;
  const definition =
    type === 'youtube.upload'
      ? { accountKey: 'accountId', platformId: 'youtube' }
      : type === 'tiktok.direct-post'
        ? { accountKey: 'accountId', platformId: 'tiktok' }
        : type === 'instagram.reels.publish'
          ? { accountKey: 'targetId', platformId: 'instagram' }
          : type === 'facebook.reels.publish'
            ? { accountKey: 'targetId', platformId: 'facebook' }
            : undefined;
  if (definition === undefined) return undefined;
  const accountId = record[definition.accountKey];
  return typeof accountId === 'string' && accountId.trim().length > 0
    ? { accountId, platformId: definition.platformId }
    : undefined;
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
    public readonly retryAfterMs?: number,
    public readonly category?: JobFailureCategory,
  ) {
    super(publicMessage);
    this.name = 'JobExecutionError';
  }
}

function classifiedJobFailureCategory(error: JobExecutionError): JobFailureCategory | undefined {
  if (error.category !== undefined) return error.category;
  if (
    /(REAUTHORIZATION|TOKEN_(?:EXPIRED|REVOKED|MISSING|INVALID)|UNAUTHORIZED|AUTHENTICATION|(?:^|_)AUTH(?:_|$))/.test(
      error.code,
    )
  )
    return 'authentication';
  if (/(PERMISSION|FORBIDDEN|SCOPE_NOT_AUTHORIZED|AUTHORIZATION)/.test(error.code))
    return 'authorization';
  if (/RATE_LIMIT/.test(error.code)) return 'rate_limit';
  return undefined;
}

export interface JobRunnerOptions {
  readonly accountConcurrency?: number;
  readonly authFailureThreshold?: number;
  readonly baseRetryDelayMs?: number;
  readonly concurrency?: number;
  readonly leaseDurationMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly now?: () => Date;
  readonly onJobSettled?: (job: Job) => Promise<void> | void;
  readonly pollIntervalMs?: number;
  readonly platformConcurrency?: number;
  readonly random?: () => number;
  readonly workerId?: string;
}

/** SQLite-independent persistent runner with bounded concurrency and cooperative cancellation. */
export class JobRunner {
  private readonly accountConcurrency: number;
  private readonly active = new Set<Promise<void>>();
  private readonly baseRetryDelayMs: number;
  private readonly authFailureThreshold: number;
  private readonly concurrency: number;
  private filling = false;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly leaseDurationMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly now: () => Date;
  private readonly onJobSettled: ((job: Job) => Promise<void> | void) | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly pollIntervalMs: number;
  private readonly platformConcurrency: number;
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
    this.platformConcurrency = options.platformConcurrency ?? this.concurrency;
    this.accountConcurrency = options.accountConcurrency ?? 1;
    this.authFailureThreshold = options.authFailureThreshold ?? 3;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
    this.now = options.now ?? (() => new Date());
    this.onJobSettled = options.onJobSettled;
    this.random = options.random ?? Math.random;
    this.workerId = options.workerId ?? randomUUID();
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1)
      throw new Error('Job concurrency must be a positive integer.');
    if (!Number.isInteger(this.platformConcurrency) || this.platformConcurrency < 1)
      throw new Error('Platform concurrency must be a positive integer.');
    if (!Number.isInteger(this.accountConcurrency) || this.accountConcurrency < 1)
      throw new Error('Account concurrency must be a positive integer.');
    if (!Number.isInteger(this.authFailureThreshold) || this.authFailureThreshold < 1)
      throw new Error('Auth failure threshold must be a positive integer.');
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

  /** Persistently stops new claims and waits for all active handlers to settle. */
  public async drain(): Promise<JobQueueState> {
    const state = this.repository.setQueueMode('draining', this.now());
    while (this.repository.countRunning() > 0) {
      this.repository.recoverExpiredLeases(this.now());
      if (this.repository.countRunning() === 0) break;
      const delay = new Promise<void>((resolve) => setTimeout(resolve, this.pollIntervalMs));
      await (this.active.size === 0
        ? delay
        : Promise.race([Promise.allSettled([...this.active]), delay]));
    }
    return state;
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
          {
            accountConcurrency: this.accountConcurrency,
            globalConcurrency: this.concurrency,
            platformConcurrency: this.platformConcurrency,
          },
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

  private retryAt(job: Job, retryAfterMs?: number): Date {
    const exponential = Math.min(
      this.maxRetryDelayMs,
      this.baseRetryDelayMs * 2 ** Math.max(0, job.attemptCount - 1),
    );
    const random = Math.min(1, Math.max(0, this.random()));
    const jittered = Math.ceil(exponential * (0.5 + random * 0.5));
    return new Date(this.now().getTime() + Math.max(jittered, retryAfterMs ?? 0));
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
        const category =
          error instanceof JobExecutionError ? classifiedJobFailureCategory(error) : undefined;
        const failure: JobFailure =
          error instanceof JobExecutionError
            ? {
                code: error.code,
                message: error.publicMessage,
                retryable: error.retryable,
                ...(category === undefined ? {} : { category }),
                ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
              }
            : { code: 'UNEXPECTED_JOB_ERROR', message: 'Job execution failed.', retryable: false };
        const canRetry = failure.retryable && job.attemptCount < job.maxAttempts;
        this.repository.fail(
          job.id,
          this.workerId,
          failure,
          this.now(),
          canRetry ? this.retryAt(job, failure.retryAfterMs) : undefined,
          this.authFailureThreshold,
        );
      }
    } finally {
      clearInterval(heartbeat);
      const settled = this.repository.findById(job.id);
      if (settled !== undefined && settled.status !== 'running') {
        try {
          await this.onJobSettled?.(settled);
        } catch {
          // Recovery notification failures must not change an already-persisted job outcome.
        }
      }
    }
  }
}

export type YouTubePrivacy = 'private' | 'public' | 'unlisted';

export type WorkflowFailurePolicy = 'best_effort';
export type TikTokWorkflowPrivacy =
  'FOLLOWER_OF_CREATOR' | 'MUTUAL_FOLLOW_FRIENDS' | 'PUBLIC_TO_EVERYONE' | 'SELF_ONLY';

export interface YouTubeWorkflowDestination {
  readonly accountId: string;
  readonly category?: string;
  readonly destinationId: 'youtube';
  readonly privacy: YouTubePrivacy;
}

export interface TikTokWorkflowDestination {
  readonly accountId: string;
  readonly captionTemplate?: string;
  readonly destinationId: 'tiktok';
  readonly disableComment?: boolean;
  readonly disableDuet?: boolean;
  readonly disableStitch?: boolean;
  readonly privacyLevel: TikTokWorkflowPrivacy;
}

export interface InstagramWorkflowDestination {
  /** Meta publish target ID, not the authorizing credential ID. */
  readonly accountId: string;
  readonly captionTemplate?: string;
  readonly destinationId: 'instagram';
  readonly shareToFeed?: boolean;
}

export interface FacebookWorkflowDestination {
  /** Meta Page target ID, not the authorizing credential ID. */
  readonly accountId: string;
  readonly destinationId: 'facebook';
  readonly titleTemplate?: string;
  readonly descriptionTemplate?: string;
}

export type WorkflowDestination =
  | YouTubeWorkflowDestination
  | TikTokWorkflowDestination
  | InstagramWorkflowDestination
  | FacebookWorkflowDestination;

/** The only step kinds accepted by the workflow compiler. Unknown JSON is never executable. */
export type WorkflowStep =
  | WorkflowSourceStep
  | WorkflowFilterStep
  | WorkflowTransformStep
  | WorkflowTranscriptionStep
  | WorkflowCaptionStep
  | WorkflowScheduleStep
  | WorkflowDestinationStep;

export interface WorkflowSourceStep {
  readonly id: string;
  readonly kind: 'source';
  readonly sourceType: 'remote' | 'watched_folder';
  readonly watchedFolder?: WatchedFolderSourceSettings;
}

export type WatchedFolderPreset = 'standard' | 'obs_recording' | 'obs_replay_buffer';

/** Durable watched-folder behavior. Presets remain ordinary editable workflow source settings. */
export interface WatchedFolderSourceSettings {
  readonly filenameMetadata: 'file_stem' | 'obs';
  readonly preset: WatchedFolderPreset;
  readonly settleMs: number;
  readonly sidecarMetadata: boolean;
}

export interface WatchedMediaMetadata {
  readonly description?: string;
  readonly externalId?: string;
  readonly publishedAt?: string;
  readonly title?: string;
}
export interface WorkflowFilterStep {
  readonly filters: SourceWorkflowFilters;
  readonly id: string;
  readonly kind: 'filter';
}
/** A pass-through remains valid for v0.5 plans; v0.6 recipes are normalized before execution. */
export interface WorkflowTransformStep {
  readonly id: string;
  readonly kind: 'transform';
  readonly operation?: 'pass_through';
  readonly plan?: TransformPlanInput;
}
/** Local inference is a durable workflow prerequisite, never a browser-side operation. */
export interface WorkflowTranscriptionStep {
  readonly id: string;
  readonly kind: 'transcription';
  readonly language?: string;
  readonly model: TranscriptionModel;
  readonly options?: Readonly<Record<string, TranscriptionOptionValue>>;
  readonly providerId: string;
}
/** Captions consume the preceding workflow transcript through an immutable SRT snapshot. */
export interface WorkflowCaptionStep {
  readonly id: string;
  readonly kind: 'captions';
  readonly mode: CaptionsTransform['mode'];
  readonly theme?: CaptionsTransform['theme'];
}
/** A scheduling boundary is compiled, but scheduling owns dispatch timing. */
export interface WorkflowScheduleStep {
  readonly id: string;
  readonly kind: 'schedule';
  readonly scheduleId: string;
}
export interface WorkflowDestinationStep {
  readonly destination: WorkflowDestination;
  readonly id: string;
  readonly kind: 'destination';
}
export interface WorkflowEdge {
  readonly from: string;
  readonly to: string;
}
export interface WorkflowDefinition {
  readonly edges: readonly WorkflowEdge[];
  readonly schemaVersion: 1;
  readonly steps: readonly WorkflowStep[];
}

/** A durable source definition whose destinations execute as independent best-effort jobs. */
export interface Workflow {
  readonly createdAt: Date;
  readonly descriptionTemplate: string;
  /** Validated editor data. It is compiled before any execution is created. */
  readonly definition: WorkflowDefinition;
  readonly destinations: readonly WorkflowDestination[];
  readonly enabled: boolean;
  readonly failurePolicy: WorkflowFailurePolicy;
  readonly id: string;
  readonly name: string;
  readonly plan: WorkflowExecutionPlan;
  readonly remoteSource?: RemoteWorkflowSource;
  readonly sourceDirectory: string;
  readonly titleTemplate: string;
  readonly updatedAt: Date;
}

export interface WorkflowInput {
  /** v0.1 compatibility input. Normalized to a single YouTube destination. */
  readonly accountId?: string;
  readonly category?: string;
  readonly descriptionTemplate?: string;
  /** Reserved for the structured editor introduced in Packet 5. */
  readonly definition?: WorkflowDefinition;
  readonly destinations?: readonly WorkflowDestination[];
  readonly enabled?: boolean;
  readonly failurePolicy?: WorkflowFailurePolicy;
  readonly name: string;
  readonly privacy?: YouTubePrivacy;
  readonly remoteSource?: RemoteWorkflowSource;
  readonly sourceDirectory?: string;
  readonly titleTemplate: string;
}

export interface SourceWorkflowFilters {
  readonly durationSecondsMax?: number;
  readonly durationSecondsMin?: number;
  readonly privacyStatuses?: readonly string[];
  readonly publishedAfter?: string;
  readonly titleContains?: string;
  readonly titleExcludes?: string;
  readonly titleRegex?: string;
}

/** Remote-source subscription captured with a workflow and versioned into each execution. */
export interface RemoteWorkflowSource {
  readonly connectionId: string;
  readonly filters?: SourceWorkflowFilters;
  readonly localOriginal?: LocalOriginalHints;
  readonly retentionPolicy?: SourceRetentionPolicy;
  readonly rightsConfirmed?: boolean;
}

export interface WorkflowRepository {
  create(workflow: Workflow): Workflow;
  delete(id: string): boolean;
  findById(id: string): Workflow | undefined;
  list(enabled?: boolean): readonly Workflow[];
  update(workflow: Workflow): Workflow | undefined;
}

/** Per-workflow source state survives restarts and prevents duplicate folder imports. */
export interface SourceCursor {
  readonly mediaId?: string;
  readonly modifiedAt: Date;
  readonly observedAt: Date;
  readonly path: string;
  readonly sizeBytes: number;
  readonly sourceKey: string;
  readonly state: 'pending' | 'processed';
  readonly workflowId: string;
}

export interface SourceCursorRepository {
  delete(workflowId: string, sourceKey: string): boolean;
  find(workflowId: string, sourceKey: string): SourceCursor | undefined;
  save(cursor: SourceCursor): SourceCursor;
}

export type SourceConnectionStatus = 'active' | 'paused' | 'authorization_failed';
export type SourcePollCadenceOwner = 'interval' | 'schedule';

/** Persistent configuration and polling checkpoint for one remote source. */
export interface SourceConnection {
  readonly adapterId: string;
  readonly configuration: Readonly<Record<string, SourceJsonValue>>;
  readonly consecutivePollFailures: number;
  readonly cadenceOwner: SourcePollCadenceOwner;
  readonly createdAt: Date;
  readonly cursor: string | null;
  readonly displayName: string;
  readonly externalSourceId: string;
  readonly id: string;
  readonly lastPollAt?: Date;
  readonly lastPollErrorCode?: string;
  readonly lastPollErrorMessage?: string;
  readonly lastSuccessfulPollAt?: Date;
  readonly nextPollAt?: Date;
  readonly status: SourceConnectionStatus;
  readonly updatedAt: Date;
}

/** A durable observation; media resolution and workflow execution are deliberately later stages. */
export interface RemoteSourceItem {
  readonly dedupeKey: string;
  readonly eventId?: string;
  readonly externalId: string;
  readonly firstObservedAt: Date;
  readonly id: string;
  readonly lastObservedAt: Date;
  readonly media?: SourceMediaDescriptor;
  readonly metadata: Readonly<Record<string, SourceJsonValue>>;
  readonly publishedAt?: Date;
  readonly sourceConnectionId: string;
  readonly updatedAt: Date;
}

export interface SourcePollingRepository {
  createConnection(input: {
    readonly adapterId: string;
    readonly configuration: Readonly<Record<string, SourceJsonValue>>;
    readonly displayName: string;
    readonly externalSourceId: string;
    readonly now: Date;
  }): SourceConnection;
  findConnection(id: string): SourceConnection | undefined;
  listConnections(): readonly SourceConnection[];
  listDue(now: Date): readonly SourceConnection[];
  listItems(connectionId: string, limit?: number): readonly SourceItemStatus[];
  requestPoll(connectionId: string, now: Date): SourceConnection | undefined;
  requestScheduledPoll(connectionId: string, now: Date): boolean;
  recordPollFailure(input: {
    readonly connectionId: string;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly nextPollAt?: Date;
    readonly now: Date;
    readonly pauseForAuthorization: boolean;
  }): SourceConnection | undefined;
  recordPollSuccess(input: {
    readonly connectionId: string;
    readonly cursor: string | null;
    readonly nextPollAt?: Date;
    readonly now: Date;
  }): SourceConnection | undefined;
  upsertObservedItem(input: {
    readonly connectionId: string;
    readonly item: SourceItemObservation;
    readonly now: Date;
  }): { readonly created: boolean; readonly item: RemoteSourceItem };
  setConnectionStatus(
    connectionId: string,
    status: Extract<SourceConnectionStatus, 'active' | 'paused'>,
    now: Date,
  ): SourceConnection | undefined;
}

/** Browser/CLI-safe source history summary. Media bytes are never exposed here. */
export interface SourceItemStatus extends RemoteSourceItem {
  readonly cleanupStatus?: SourceWorkflowExecution['cleanupStatus'];
  readonly lifecycleStatus: SourceItemLifecycleState;
  readonly resolutionStatus: SourceResolutionStatus;
}

/** Shared application surface for source setup and inspection; polling remains runner-owned. */
export class SourceService {
  public constructor(
    private readonly repository: SourcePollingRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public addYouTube(input: {
    readonly accountId: string;
    readonly channelId: string;
    readonly displayName?: string;
  }): SourceConnection {
    const accountId = input.accountId.trim();
    const channelId = input.channelId.trim();
    if (accountId.length === 0 || channelId.length === 0)
      throw new Error('A connected YouTube account and channel ID are required.');
    return this.repository.createConnection({
      adapterId: 'youtube',
      configuration: { accountId },
      displayName: input.displayName?.trim() || `YouTube channel ${channelId}`,
      externalSourceId: channelId,
      now: this.now(),
    });
  }

  public get(id: string): SourceConnection | undefined {
    return this.repository.findConnection(id);
  }

  public list(): readonly SourceConnection[] {
    return this.repository.listConnections();
  }

  public items(id: string): readonly SourceItemStatus[] {
    return this.repository.listItems(id);
  }

  public pause(id: string): SourceConnection | undefined {
    return this.repository.setConnectionStatus(id, 'paused', this.now());
  }

  public resume(id: string): SourceConnection | undefined {
    return this.repository.setConnectionStatus(id, 'active', this.now());
  }

  public poll(id: string): SourceConnection | undefined {
    return this.repository.requestPoll(id, this.now());
  }
}

export interface SourcePollingRunnerOptions {
  readonly authFailurePauseThreshold?: number;
  readonly errorRetryBaseMs?: number;
  readonly intervalMs?: number;
  readonly maxErrorRetryMs?: number;
  readonly maxPagesPerPoll?: number;
  readonly now?: () => Date;
  readonly pollIntervalMs?: number;
  readonly random?: () => number;
  readonly sourceContext: Omit<SourceAdapterContext, 'signal'>;
}

/**
 * Headless, durable remote-source detection loop. It writes observations and a normal handoff job
 * before advancing the cursor; media resolution and publishing are intentionally out of scope.
 */
export class SourcePollingRunner {
  private readonly activeConnectionIds = new Set<string>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly authFailurePauseThreshold: number;
  private readonly errorRetryBaseMs: number;
  private readonly intervalMs: number;
  private readonly maxErrorRetryMs: number;
  private readonly maxPagesPerPoll: number;
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private readonly random: () => number;
  private started = false;
  private stopping = false;
  private timer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly repository: SourcePollingRepository,
    private readonly registry: SourceRegistry,
    private readonly jobs: JobService,
    options: SourcePollingRunnerOptions,
  ) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.errorRetryBaseMs = options.errorRetryBaseMs ?? 30_000;
    this.maxErrorRetryMs = options.maxErrorRetryMs ?? 15 * 60_000;
    this.maxPagesPerPoll = options.maxPagesPerPoll ?? 10;
    this.authFailurePauseThreshold = options.authFailurePauseThreshold ?? 3;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.sourceContext = options.sourceContext;
    if (this.intervalMs < 60_000) throw new Error('Source polling must be at least every minute.');
    if (this.pollIntervalMs < 25) throw new Error('Source polling checks must be at least 25ms.');
    if (this.errorRetryBaseMs < 1_000 || this.maxErrorRetryMs < this.errorRetryBaseMs)
      throw new Error('Source poll retry delays are invalid.');
    if (!Number.isInteger(this.maxPagesPerPoll) || this.maxPagesPerPoll < 1)
      throw new Error('Source poll page limit must be a positive integer.');
    if (!Number.isInteger(this.authFailurePauseThreshold) || this.authFailurePauseThreshold < 1)
      throw new Error('Source auth failure pause threshold must be a positive integer.');
  }

  private readonly sourceContext: Omit<SourceAdapterContext, 'signal'>;

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.pollIntervalMs);
  }

  public async stop(): Promise<void> {
    if (!this.started) return;
    this.stopping = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.activeControllers) controller.abort();
    while (this.activeConnectionIds.size > 0)
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    this.started = false;
  }

  public async runOnce(): Promise<void> {
    if (this.stopping) return;
    const due = this.repository.listDue(this.now());
    await Promise.all(
      due.map(async (connection) => {
        if (this.activeConnectionIds.has(connection.id)) return;
        this.activeConnectionIds.add(connection.id);
        try {
          await this.pollConnection(connection);
        } finally {
          this.activeConnectionIds.delete(connection.id);
        }
      }),
    );
  }

  private async pollConnection(connection: SourceConnection): Promise<void> {
    const adapter = this.registry.get(connection.adapterId);
    const now = this.now();
    if (adapter === undefined) {
      this.repository.recordPollFailure({
        connectionId: connection.id,
        errorCode: 'SOURCE_ADAPTER_UNAVAILABLE',
        errorMessage: 'The configured source adapter is unavailable.',
        nextPollAt: this.retryAt(connection, now),
        now,
        pauseForAuthorization: false,
      });
      return;
    }
    const controller = new AbortController();
    this.activeControllers.add(controller);
    try {
      let cursor = connection.cursor;
      for (let page = 0; page < this.maxPagesPerPoll; page += 1) {
        const result = await adapter.poll(
          {
            configuration: connection.configuration,
            connectionExternalId: connection.externalSourceId,
            cursor,
          },
          { ...this.sourceContext, signal: controller.signal },
        );
        validateSourcePollResult(result);
        for (const item of result.items) {
          const persisted = this.repository.upsertObservedItem({
            connectionId: connection.id,
            item,
            now: this.now(),
          });
          this.jobs.create({
            type: 'source.item.observed',
            idempotencyKey: `source-item:${persisted.item.id}:observed`,
            input: { sourceConnectionId: connection.id, sourceItemId: persisted.item.id },
          });
        }
        cursor = result.cursor;
        if (!result.hasMore) {
          this.repository.recordPollSuccess({
            connectionId: connection.id,
            cursor,
            ...(connection.cadenceOwner === 'interval'
              ? { nextPollAt: this.nextPollAt(this.now()) }
              : {}),
            now: this.now(),
          });
          return;
        }
      }
      throw new Error('SOURCE_POLL_PAGE_LIMIT_REACHED');
    } catch (error) {
      if (controller.signal.aborted) return;
      const isAuthFailure =
        isPlatformError(error) &&
        (error.category === 'authentication' || error.category === 'authorization');
      const code = isPlatformError(error) ? error.code : 'SOURCE_POLL_FAILED';
      const message = isPlatformError(error)
        ? error.publicMessage
        : 'The source could not be polled. Please try again later.';
      const pauseForAuthorization =
        isAuthFailure && connection.consecutivePollFailures + 1 >= this.authFailurePauseThreshold;
      this.repository.recordPollFailure({
        connectionId: connection.id,
        errorCode: code,
        errorMessage: message,
        ...(pauseForAuthorization ? {} : { nextPollAt: this.retryAt(connection, this.now()) }),
        now: this.now(),
        pauseForAuthorization,
      });
      this.sourceContext.logger.warn(
        { adapterId: connection.adapterId, connectionId: connection.id, errorCode: code },
        'Source poll failed',
      );
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  private nextPollAt(now: Date): Date {
    // Jitter only adds delay, so configured platform-minimum intervals are never violated.
    return new Date(
      now.getTime() + this.intervalMs + Math.floor(this.intervalMs * this.random() * 0.2),
    );
  }

  private retryAt(connection: SourceConnection, now: Date): Date {
    const exponent = Math.min(connection.consecutivePollFailures, 8);
    const delay = Math.min(this.errorRetryBaseMs * 2 ** exponent, this.maxErrorRetryMs);
    return new Date(now.getTime() + delay + Math.floor(delay * this.random() * 0.2));
  }
}

export type SourceItemLifecycleState =
  | 'observed'
  | 'queued'
  | 'resolving'
  | 'media_ready'
  | 'processing'
  | 'publishing'
  | 'partial_failure'
  | 'retrying'
  | 'published'
  | 'cleanup_pending'
  | 'completed'
  | 'failed';

export type SourceResolutionStatus =
  'unresolved' | 'resolving' | 'ready' | 'unavailable' | 'failed';

export type SourceDestinationStatus =
  'pending' | 'running' | 'waiting' | 'retrying' | 'succeeded' | 'failed' | 'cancelled';

export type SourceRetentionPolicy =
  | { readonly kind: 'delete_after_success' }
  | { readonly durationSeconds: number; readonly kind: 'keep_for_duration' }
  | { readonly kind: 'keep_forever' };

export type SourceMediaOwnership =
  'user_owned_original' | 'openrepurpose_temporary' | 'openrepurpose_generated';

export type MediaResolutionState = 'resolving' | 'ready' | 'failed' | 'cancelled';

export interface SourceMediaResolution {
  readonly completedAt?: Date;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly executionId: string;
  readonly jobScopeId: string;
  readonly managedPath?: string;
  readonly mediaId?: string;
  readonly resolverId?: string;
  readonly sourceItemId: string;
  readonly startedAt: Date;
  readonly status: MediaResolutionState;
  readonly updatedAt: Date;
}

export interface SourceMediaArtifact {
  readonly cleanupState:
    | 'protected'
    | 'not_eligible'
    | 'eligible'
    | 'scheduled'
    | 'running'
    | 'completed'
    | 'failed'
    | 'retained';
  readonly deletedAt?: Date;
  readonly executionId?: string;
  readonly id: string;
  readonly mediaId?: string;
  readonly ownership: SourceMediaOwnership;
  readonly path: string;
  readonly sourceItemId: string;
  readonly state: 'available' | 'missing' | 'deleted';
  readonly updatedAt: Date;
}

export interface SourceMediaResolutionRepository {
  begin(input: {
    readonly executionId: string;
    readonly jobScopeId: string;
    readonly managedPath?: string;
    readonly now: Date;
    readonly resolverId?: string;
    readonly sourceItemId: string;
  }): SourceMediaResolution;
  find(sourceItemId: string, executionId: string): SourceMediaResolution | undefined;
  findArtifact(id: string): SourceMediaArtifact | undefined;
  findArtifactForResolution(
    sourceItemId: string,
    executionId: string,
  ): SourceMediaArtifact | undefined;
  markCleanupCompleted(id: string, now: Date): SourceMediaArtifact | undefined;
  markCleanupFailed(
    id: string,
    errorCode: string,
    errorMessage: string,
    now: Date,
  ): SourceMediaArtifact | undefined;
  markCleanupRunning(id: string, now: Date): SourceMediaArtifact | undefined;
  markFailed(input: {
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly executionId: string;
    readonly now: Date;
    readonly sourceItemId: string;
    readonly status: 'failed' | 'cancelled';
  }): SourceMediaResolution;
  markReady(input: {
    readonly executionId: string;
    readonly media: MediaAsset;
    readonly now: Date;
    readonly ownership: SourceMediaOwnership;
    readonly sourceItemId: string;
  }): { readonly artifact: SourceMediaArtifact; readonly resolution: SourceMediaResolution };
}

export interface ManagedTemporaryPath {
  readonly finalPath: string;
  readonly partialPath: string;
}

/** Storage boundary for OpenRepurpose-owned working files below the managed data root. */
export interface ManagedTemporaryStorage {
  cleanup(path: string): Promise<'deleted' | 'missing'>;
  discard(paths: ManagedTemporaryPath): Promise<void>;
  finalize(paths: ManagedTemporaryPath): Promise<string>;
  isUsableFile(path: string): Promise<boolean>;
  prepare(jobScopeId: string, extension?: string): Promise<ManagedTemporaryPath>;
  reconcileStale(input: {
    readonly activeScopeIds: readonly string[];
    readonly staleBefore: Date;
  }): Promise<{
    readonly deletedScopeIds: readonly string[];
    readonly skippedScopeIds: readonly string[];
  }>;
}

export interface LocalOriginalHints {
  readonly fingerprint?: string;
  readonly mediaId?: string;
  readonly path?: string;
}

export interface LocalOriginalMatcher {
  find(input: {
    readonly hints?: LocalOriginalHints;
    readonly sourceItem: RemoteSourceItem;
  }): Promise<MediaAsset | undefined>;
}

/** Matches only already-registered media and never copies or assumes ownership of the file. */
export class RegisteredLocalOriginalMatcher implements LocalOriginalMatcher {
  public constructor(private readonly media: MediaRepository) {}

  public async find(input: {
    readonly hints?: LocalOriginalHints;
    readonly sourceItem: RemoteSourceItem;
  }): Promise<MediaAsset | undefined> {
    const hints = input.hints;
    if (hints === undefined) return undefined;
    const normalizedPath = hints.path?.replaceAll('\\', '/').toLowerCase();
    return this.media.list().find((asset) => {
      if (asset.state !== 'available') return false;
      return (
        (hints.mediaId !== undefined && asset.id === hints.mediaId) ||
        (hints.fingerprint !== undefined && asset.fingerprint === hints.fingerprint) ||
        (normalizedPath !== undefined &&
          asset.path.replaceAll('\\', '/').toLowerCase() === normalizedPath)
      );
    });
  }
}

export interface MediaResolverRequest {
  readonly sourceItem: RemoteSourceItem;
  readonly strategy: Exclude<SourceMediaResolutionStrategy, 'local_original'>;
}

export interface MediaResolverContext {
  /** Resolver implementations must write only to this managed staging path. */
  readonly destinationPath: string;
  readonly signal: AbortSignal;
}

/** Replaceable boundary for official or explicitly enabled authorized media acquisition. */
export interface MediaResolver {
  readonly id: string;
  canResolve(request: MediaResolverRequest): boolean;
  resolve(request: MediaResolverRequest, context: MediaResolverContext): Promise<void>;
}

function externalDownloaderResolutionFailure(error: ExternalDownloaderError): MediaResolutionError {
  const publicMessages: Readonly<Record<ExternalDownloaderFailureCode, string>> = {
    authentication_required: 'The external downloader requires authorization.',
    cancelled: 'External media downloading was cancelled.',
    download_failed: 'The external downloader could not acquire the media.',
    rate_limited: 'The external downloader is temporarily rate-limited.',
    unavailable: 'The external downloader is unavailable.',
    unsupported_locator: 'No external downloader supports this media locator.',
  };
  return new MediaResolutionError(
    `MEDIA_EXTERNAL_DOWNLOADER_${error.code.toUpperCase()}`,
    error.retryable,
    publicMessages[error.code],
  );
}

export class MediaResolutionError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'MediaResolutionError';
  }
}

/**
 * Application-layer bridge from generic media resolution to optional external downloader
 * infrastructure. It deliberately knows no executable, arguments, version format, or tool output.
 */
export class ExternalDownloaderMediaResolver implements MediaResolver {
  public readonly id = 'external-downloader';

  public constructor(private readonly downloaders: ExternalDownloaderRegistry) {}

  public canResolve(request: MediaResolverRequest): boolean {
    if (request.strategy !== 'external_downloader') return false;
    const locator = request.sourceItem.media?.externalDownload?.locator;
    if (locator === undefined) return false;
    return this.downloaders.list().some((downloader) => this.supports(downloader, { locator }));
  }

  public async resolve(
    request: MediaResolverRequest,
    context: MediaResolverContext,
  ): Promise<void> {
    const locator = request.sourceItem.media?.externalDownload?.locator;
    if (request.strategy !== 'external_downloader' || locator === undefined)
      throw new MediaResolutionError(
        'MEDIA_EXTERNAL_DOWNLOADER_UNSUPPORTED_LOCATOR',
        false,
        'No external downloader supports this media locator.',
      );

    const downloadRequest = { locator } as const;
    const downloader = this.downloaders
      .list()
      .find((candidate) => this.supports(candidate, downloadRequest));
    if (downloader === undefined)
      throw new MediaResolutionError(
        'MEDIA_EXTERNAL_DOWNLOADER_UNSUPPORTED_LOCATOR',
        false,
        'No external downloader supports this media locator.',
      );

    let capabilities;
    try {
      capabilities = await downloader.capabilities();
    } catch {
      throw new MediaResolutionError(
        'MEDIA_EXTERNAL_DOWNLOADER_UNAVAILABLE',
        false,
        'The external downloader is unavailable.',
      );
    }
    if (capabilities.availability !== 'available' || !capabilities.operations.includes('download'))
      throw new MediaResolutionError(
        'MEDIA_EXTERNAL_DOWNLOADER_UNAVAILABLE',
        false,
        'The external downloader is unavailable.',
      );

    try {
      const result = await downloader.download(downloadRequest, context);
      if (result.destinationPath !== context.destinationPath)
        throw new ExternalDownloaderError(
          'download_failed',
          false,
          'The downloader returned an unexpected output path.',
        );
    } catch (error) {
      throw error instanceof ExternalDownloaderError
        ? externalDownloaderResolutionFailure(error)
        : new MediaResolutionError(
            context.signal.aborted
              ? 'MEDIA_EXTERNAL_DOWNLOADER_CANCELLED'
              : 'MEDIA_EXTERNAL_DOWNLOADER_DOWNLOAD_FAILED',
            !context.signal.aborted,
            context.signal.aborted
              ? 'External media downloading was cancelled.'
              : 'The external downloader could not acquire the media.',
          );
    }
  }

  private supports(downloader: ExternalDownloader, request: { readonly locator: string }): boolean {
    try {
      return downloader.supports(request);
    } catch {
      return false;
    }
  }
}

export interface ResolveSourceMediaInput {
  readonly executionId: string;
  readonly jobScopeId: string;
  readonly localOriginal?: LocalOriginalHints;
  readonly outputExtension?: string;
  readonly rightsConfirmed?: boolean;
  readonly signal: AbortSignal;
  readonly sourceItem: RemoteSourceItem;
}

export interface ResolvedSourceMedia {
  readonly artifact: SourceMediaArtifact;
  readonly media: MediaAsset;
  readonly reusedLocalOriginal: boolean;
}

/**
 * Durable resolution coordinator. Local originals always win; managed downloads are checkpointed
 * before acquisition and registered through the same media-import path as user imports.
 */
export class MediaResolutionService {
  public constructor(
    private readonly resolutions: SourceMediaResolutionRepository,
    private readonly originals: LocalOriginalMatcher,
    private readonly resolvers: readonly MediaResolver[],
    private readonly storage: ManagedTemporaryStorage,
    private readonly importer: MediaImportService,
    private readonly media: MediaRepository,
    private readonly now: () => Date = () => new Date(),
  ) {
    const ids = resolvers.map((resolver) => resolver.id);
    if (ids.some((id) => id.trim().length === 0) || new Set(ids).size !== ids.length)
      throw new Error('Media resolver IDs must be non-empty and unique.');
  }

  public async resolve(input: ResolveSourceMediaInput): Promise<ResolvedSourceMedia> {
    const checkpoint = this.resolutions.find(input.sourceItem.id, input.executionId);
    if (checkpoint?.status === 'ready' && checkpoint.mediaId !== undefined) {
      const existingMedia = this.media.findById(checkpoint.mediaId);
      const artifact = this.resolutions.findArtifactForResolution(
        checkpoint.sourceItemId,
        checkpoint.executionId,
      );
      if (existingMedia !== undefined && artifact !== undefined)
        return {
          artifact,
          media: existingMedia,
          reusedLocalOriginal: artifact.ownership === 'user_owned_original',
        };
    }

    if (input.signal.aborted) {
      this.resolutions.begin({
        sourceItemId: input.sourceItem.id,
        executionId: input.executionId,
        jobScopeId: input.jobScopeId,
        now: this.now(),
      });
      this.resolutions.markFailed({
        sourceItemId: input.sourceItem.id,
        executionId: input.executionId,
        status: 'cancelled',
        errorCode: 'MEDIA_RESOLUTION_CANCELLED',
        errorMessage: 'Media resolution was cancelled.',
        now: this.now(),
      });
      throw new MediaResolutionError(
        'MEDIA_RESOLUTION_CANCELLED',
        false,
        'Media resolution was cancelled.',
      );
    }
    const original = await this.originals.find({
      sourceItem: input.sourceItem,
      ...(input.localOriginal === undefined ? {} : { hints: input.localOriginal }),
    });
    if (original !== undefined) {
      this.resolutions.begin({
        sourceItemId: input.sourceItem.id,
        executionId: input.executionId,
        jobScopeId: input.jobScopeId,
        resolverId: 'local-original',
        now: this.now(),
      });
      const ready = this.resolutions.markReady({
        sourceItemId: input.sourceItem.id,
        executionId: input.executionId,
        media: original,
        ownership: 'user_owned_original',
        now: this.now(),
      });
      return { artifact: ready.artifact, media: original, reusedLocalOriginal: true };
    }

    const strategy = input.sourceItem.media?.resolutionStrategies.find(
      (candidate): candidate is Exclude<SourceMediaResolutionStrategy, 'local_original'> =>
        candidate !== 'local_original',
    );
    if (strategy === undefined)
      throw await this.persistFailure(
        input,
        'MEDIA_RESOLVER_UNAVAILABLE',
        false,
        'No configured resolver can acquire this source item.',
      );
    if (
      strategy === 'external_downloader' &&
      input.sourceItem.media?.rightsRequirement === 'explicit_confirmation' &&
      input.rightsConfirmed !== true
    )
      throw await this.persistFailure(
        input,
        'MEDIA_RIGHTS_CONFIRMATION_REQUIRED',
        false,
        'Explicit rights confirmation is required before external resolution.',
      );
    const request: MediaResolverRequest = { sourceItem: input.sourceItem, strategy };
    const resolver = this.resolvers.find((candidate) => candidate.canResolve(request));
    if (resolver === undefined)
      throw await this.persistFailure(
        input,
        'MEDIA_RESOLVER_UNAVAILABLE',
        false,
        'No configured resolver can acquire this source item.',
      );

    const paths = await this.storage.prepare(input.jobScopeId, input.outputExtension);
    this.resolutions.begin({
      sourceItemId: input.sourceItem.id,
      executionId: input.executionId,
      jobScopeId: input.jobScopeId,
      resolverId: resolver.id,
      managedPath: paths.finalPath,
      now: this.now(),
    });
    try {
      if (!(await this.storage.isUsableFile(paths.finalPath))) {
        await this.storage.discard(paths);
        this.throwIfCancelled(input.signal);
        await resolver.resolve(request, {
          destinationPath: paths.partialPath,
          signal: input.signal,
        });
        this.throwIfCancelled(input.signal);
        await this.storage.finalize(paths);
      }
      // Each execution owns its retry and retention lifetime. Identical bytes in another
      // execution must not make both executions share one cleanup path.
      const imported = await this.importer.import(paths.finalPath, { deduplicate: false });
      const ready = this.resolutions.markReady({
        sourceItemId: input.sourceItem.id,
        executionId: input.executionId,
        media: imported.asset,
        ownership: 'openrepurpose_temporary',
        now: this.now(),
      });
      return { artifact: ready.artifact, media: imported.asset, reusedLocalOriginal: false };
    } catch (error) {
      await this.storage.discard(paths);
      const cancelled = input.signal.aborted;
      const resolutionError =
        error instanceof MediaResolutionError
          ? error
          : new MediaResolutionError(
              cancelled ? 'MEDIA_RESOLUTION_CANCELLED' : 'MEDIA_RESOLUTION_FAILED',
              !cancelled,
              cancelled
                ? 'Media resolution was cancelled.'
                : 'The source media could not be resolved.',
            );
      this.resolutions.markFailed({
        sourceItemId: input.sourceItem.id,
        executionId: input.executionId,
        status: cancelled ? 'cancelled' : 'failed',
        errorCode: resolutionError.code,
        errorMessage: resolutionError.message,
        now: this.now(),
      });
      throw resolutionError;
    }
  }

  private async persistFailure(
    input: ResolveSourceMediaInput,
    code: string,
    retryable: boolean,
    message: string,
  ): Promise<MediaResolutionError> {
    this.resolutions.begin({
      sourceItemId: input.sourceItem.id,
      executionId: input.executionId,
      jobScopeId: input.jobScopeId,
      now: this.now(),
    });
    this.resolutions.markFailed({
      sourceItemId: input.sourceItem.id,
      executionId: input.executionId,
      status: 'failed',
      errorCode: code,
      errorMessage: message,
      now: this.now(),
    });
    return new MediaResolutionError(code, retryable, message);
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted)
      throw new MediaResolutionError(
        'MEDIA_RESOLUTION_CANCELLED',
        false,
        'Media resolution was cancelled.',
      );
  }
}

export function retentionCleanupAt(
  policy: SourceRetentionPolicy,
  completedAt: Date,
): Date | undefined {
  if (policy.kind === 'keep_forever') return undefined;
  if (policy.kind === 'delete_after_success') return completedAt;
  if (!Number.isInteger(policy.durationSeconds) || policy.durationSeconds <= 0)
    throw new Error('Retention duration must be a positive whole number of seconds.');
  return new Date(completedAt.getTime() + policy.durationSeconds * 1_000);
}

export class SourceMediaCleanupService {
  public constructor(
    private readonly resolutions: SourceMediaResolutionRepository,
    private readonly storage: ManagedTemporaryStorage,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async cleanupArtifact(id: string): Promise<'deleted' | 'missing' | 'protected'> {
    const artifact = this.resolutions.findArtifact(id);
    if (artifact === undefined) return 'missing';
    if (artifact.ownership === 'user_owned_original') return 'protected';
    if (artifact.cleanupState === 'completed') return 'missing';
    this.resolutions.markCleanupRunning(id, this.now());
    try {
      const result = await this.storage.cleanup(artifact.path);
      this.resolutions.markCleanupCompleted(id, this.now());
      return result;
    } catch (error) {
      this.resolutions.markCleanupFailed(
        id,
        'MEDIA_CLEANUP_FAILED',
        error instanceof Error ? error.message : 'Managed media cleanup failed.',
        this.now(),
      );
      throw error;
    }
  }
}

export interface SourceDestinationState {
  readonly required: boolean;
  readonly status: SourceDestinationStatus;
}

/** Successful destination results are terminal checkpoints and are never selected for retry. */
export function sourceDestinationNeedsWork(destination: SourceDestinationState): boolean {
  return destination.status !== 'succeeded' && destination.status !== 'cancelled';
}

/** Cleanup remains blocked until every required destination has a durable success checkpoint. */
export function allRequiredSourceDestinationsSucceeded(
  destinations: readonly SourceDestinationState[],
): boolean {
  return destinations.every(
    (destination) => !destination.required || destination.status === 'succeeded',
  );
}

/** Cleanup code may accept only OpenRepurpose-owned artifacts as deletion candidates. */
export function isOpenRepurposeManagedMedia(
  ownership: SourceMediaOwnership,
): ownership is 'openrepurpose_temporary' | 'openrepurpose_generated' {
  return ownership !== 'user_owned_original';
}

export interface WorkflowExecutionPlan {
  readonly definitionVersion: 1;
  readonly descriptionTemplate: string;
  readonly destinations: readonly WorkflowDestination[];
  readonly failurePolicy: WorkflowFailurePolicy;
  readonly id: string;
  readonly name: string;
  readonly planVersion: 'workflow-plan-v1';
  /** Topologically ordered, allow-listed operations for audit and future runners. */
  readonly steps: readonly WorkflowStep[];
  readonly titleTemplate: string;
}

const workflowStepOrder: Readonly<Record<WorkflowStep['kind'], number>> = {
  source: 0,
  filter: 1,
  transform: 2,
  transcription: 3,
  captions: 4,
  schedule: 5,
  destination: 6,
};

function validateWatchedFolderSettings(settings: WatchedFolderSourceSettings): void {
  if (!['standard', 'obs_recording', 'obs_replay_buffer'].includes(settings.preset))
    throw new Error('Unsupported watched-folder preset.');
  if (!['file_stem', 'obs'].includes(settings.filenameMetadata))
    throw new Error('Unsupported watched-folder filename metadata mode.');
  if (!Number.isInteger(settings.settleMs) || settings.settleMs < 0 || settings.settleMs > 300_000)
    throw new Error('Watched-folder settle time must be from 0 to 300000 milliseconds.');
  if (typeof settings.sidecarMetadata !== 'boolean')
    throw new Error('Watched-folder sidecar metadata must be enabled or disabled.');
}

/** Validates a workflow DAG independently of its UI representation. */
export function validateWorkflowDefinition(definition: WorkflowDefinition): void {
  if (definition.schemaVersion !== 1) throw new Error('Unsupported workflow definition version.');
  if (definition.steps.length === 0) throw new Error('A workflow must contain steps.');
  const steps = new Map<string, WorkflowStep>();
  for (const step of definition.steps) {
    if (step.id.trim().length === 0) throw new Error('A workflow step ID is required.');
    if (steps.has(step.id)) throw new Error(`Duplicate workflow step ID: ${step.id}`);
    if (step.kind === 'transform') {
      if (step.plan === undefined && step.operation !== 'pass_through')
        throw new Error('A workflow transform requires a typed recipe.');
      if (step.plan !== undefined) normalizeTransformPlan(step.plan);
    }
    if (step.kind === 'schedule' && step.scheduleId.trim().length === 0)
      throw new Error('A workflow schedule step requires a schedule ID.');
    if (step.kind === 'source') {
      if (step.sourceType === 'remote' && step.watchedFolder !== undefined)
        throw new Error('Remote workflow sources cannot use watched-folder settings.');
      if (step.sourceType === 'watched_folder' && step.watchedFolder !== undefined)
        validateWatchedFolderSettings(step.watchedFolder);
    }
    if (step.kind === 'transcription') {
      if (step.providerId.trim().length === 0)
        throw new Error('A workflow transcription step requires a provider ID.');
      if (step.model.id.trim().length === 0 || step.model.version.trim().length === 0)
        throw new Error('A workflow transcription step requires a model ID and version.');
    }
    steps.set(step.id, step);
  }
  const sources = definition.steps.filter((step) => step.kind === 'source');
  if (sources.length !== 1) throw new Error('A workflow must contain exactly one source step.');
  if (!definition.steps.some((step) => step.kind === 'destination'))
    throw new Error('A workflow source must reach at least one destination.');
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const step of definition.steps) {
    outgoing.set(step.id, []);
    incoming.set(step.id, 0);
  }
  const edgeKeys = new Set<string>();
  for (const edge of definition.edges) {
    const from = steps.get(edge.from);
    const to = steps.get(edge.to);
    if (from === undefined || to === undefined)
      throw new Error('A workflow edge references an unknown step.');
    if (from.id === to.id) throw new Error('A workflow cannot contain a self-referencing step.');
    const key = `${edge.from}\u0000${edge.to}`;
    if (edgeKeys.has(key)) throw new Error('A workflow cannot contain duplicate edges.');
    edgeKeys.add(key);
    if (workflowStepOrder[to.kind] <= workflowStepOrder[from.kind])
      throw new Error(`Unsupported workflow step ordering: ${from.kind} to ${to.kind}.`);
    outgoing.get(from.id)!.push(to.id);
    incoming.set(to.id, (incoming.get(to.id) ?? 0) + 1);
  }
  if ((incoming.get(sources[0]!.id) ?? 0) !== 0)
    throw new Error('A workflow source step cannot have incoming edges.');
  const reachable = new Set<string>();
  const visit = (id: string): void => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const next of outgoing.get(id) ?? []) visit(next);
  };
  visit(sources[0]!.id);
  if (reachable.size !== definition.steps.length)
    throw new Error('Every workflow step must be reachable from its source.');
  if (!definition.steps.some((step) => step.kind === 'destination' && reachable.has(step.id)))
    throw new Error('A workflow source must reach at least one destination.');
  for (const step of definition.steps)
    if (step.kind === 'destination' && (outgoing.get(step.id)?.length ?? 0) !== 0)
      throw new Error('A workflow destination step cannot have outgoing edges.');
  const transcriptionSteps = definition.steps.filter((step) => step.kind === 'transcription');
  const captionSteps = definition.steps.filter((step) => step.kind === 'captions');
  if (transcriptionSteps.length > 1)
    throw new Error('A workflow supports one transcription step before destination fan-out.');
  if (captionSteps.length > 1)
    throw new Error('A workflow supports one caption step before destination fan-out.');
  if (captionSteps.length > 0 && transcriptionSteps.length !== 1)
    throw new Error('A workflow caption step requires a transcription step.');
}

/** Compiles a typed DAG into the only plan format accepted by execution services. */
export function compileWorkflowExecutionPlan(input: {
  readonly definition: WorkflowDefinition;
  readonly descriptionTemplate: string;
  readonly failurePolicy: WorkflowFailurePolicy;
  readonly id: string;
  readonly name: string;
  readonly titleTemplate: string;
}): WorkflowExecutionPlan {
  validateWorkflowDefinition(input.definition);
  const destinations = input.definition.steps
    .filter((step): step is WorkflowDestinationStep => step.kind === 'destination')
    .map((step) => step.destination);
  if (destinations.length === 0) throw new Error('A workflow plan requires a destination.');
  for (const destination of destinations) validatePlanDestination(destination);
  return Object.freeze({
    planVersion: 'workflow-plan-v1' as const,
    definitionVersion: 1 as const,
    id: input.id,
    name: input.name,
    titleTemplate: input.titleTemplate,
    descriptionTemplate: input.descriptionTemplate,
    failurePolicy: input.failurePolicy,
    destinations: Object.freeze([...destinations]),
    steps: Object.freeze([...input.definition.steps]),
  });
}

function validatePlanDestination(destination: WorkflowDestination): void {
  if (destination.accountId.trim().length === 0)
    throw new Error('A destination account is required.');
  if (destination.destinationId === 'youtube') {
    if (!(['private', 'public', 'unlisted'] as const).includes(destination.privacy))
      throw new Error('Invalid YouTube privacy.');
  } else if (destination.destinationId === 'tiktok') {
    if (
      !(
        ['FOLLOWER_OF_CREATOR', 'MUTUAL_FOLLOW_FRIENDS', 'PUBLIC_TO_EVERYONE', 'SELF_ONLY'] as const
      ).includes(destination.privacyLevel)
    )
      throw new Error('Invalid TikTok privacy level.');
  } else if (
    destination.destinationId !== 'instagram' &&
    destination.destinationId !== 'facebook'
  ) {
    throw new Error('Unsupported workflow destination.');
  }
}

/** Revalidates persisted plans before execution; deserialized JSON is never trusted as commands. */
export function validateWorkflowExecutionPlan(plan: WorkflowExecutionPlan): void {
  if (plan.planVersion !== 'workflow-plan-v1' || plan.definitionVersion !== 1)
    throw new Error('Unsupported workflow execution plan version.');
  if (plan.steps.length === 0 || plan.steps.filter((step) => step.kind === 'source').length !== 1)
    throw new Error('Invalid workflow execution plan steps.');
  if (!plan.steps.some((step) => step.kind === 'destination'))
    throw new Error('Invalid workflow execution plan destination.');
  for (const destination of plan.destinations) validatePlanDestination(destination);
}

export interface SourceWorkflowExecutionSnapshot {
  readonly filters: {
    readonly applied: SourceWorkflowFilters;
    readonly matched: true;
  };
  readonly remoteSource: RemoteWorkflowSource;
  readonly schemaVersion: 1;
  readonly source: {
    readonly externalId: string;
    readonly metadata: Readonly<Record<string, SourceJsonValue>>;
    readonly publishedAt?: string;
    readonly sourceConnectionId: string;
    readonly sourceItemId: string;
  };
  readonly workflow: WorkflowExecutionPlan;
}

export interface SourceWorkflowExecution {
  readonly cleanupEligibleAt?: Date;
  readonly cleanupStatus:
    'not_eligible' | 'eligible' | 'scheduled' | 'running' | 'completed' | 'failed' | 'retained';
  readonly completedAt?: Date;
  readonly id: string;
  readonly retentionPolicy: SourceRetentionPolicy;
  readonly snapshot: SourceWorkflowExecutionSnapshot;
  readonly sourceItemId: string;
  readonly status:
    'pending' | 'running' | 'waiting' | 'retrying' | 'succeeded' | 'failed' | 'cancelled';
  readonly workflowKey: string;
  readonly workflowVersion: string;
}

export interface SourceExecutionDestination extends SourceDestinationState {
  readonly destinationId: WorkflowDestination['destinationId'];
  readonly destinationKey: string;
  readonly executionId: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly jobId?: string;
  readonly lastErrorCode?: string;
  readonly lastErrorMessage?: string;
  readonly remoteId?: string;
  readonly remoteUrl?: string;
}

export interface SourceWorkflowExecutionRepository {
  attachDestinationJob(destinationId: string, job: Job, now: Date): SourceExecutionDestination;
  create(input: {
    readonly destinations: readonly {
      readonly destinationId: WorkflowDestination['destinationId'];
      readonly destinationKey: string;
      readonly id: string;
      readonly idempotencyKey: string;
      readonly required: boolean;
    }[];
    readonly executionId: string;
    readonly now: Date;
    readonly retentionPolicy: SourceRetentionPolicy;
    readonly snapshot: SourceWorkflowExecutionSnapshot;
    readonly sourceItemId: string;
    readonly workflowId: string;
    readonly workflowKey: string;
    readonly workflowVersion: string;
  }): { readonly created: boolean; readonly execution: SourceWorkflowExecution };
  find(id: string): SourceWorkflowExecution | undefined;
  findSourceItem(id: string): RemoteSourceItem | undefined;
  listArtifacts(executionId: string): readonly SourceMediaArtifact[];
  listDestinations(executionId: string): readonly SourceExecutionDestination[];
  listDueCleanup(now: Date): readonly SourceWorkflowExecution[];
  listNeedingRun(): readonly SourceWorkflowExecution[];
  markCleanupCompleted(executionId: string, now: Date): SourceWorkflowExecution;
  markCleanupFailed(
    executionId: string,
    errorCode: string,
    errorMessage: string,
    now: Date,
  ): SourceWorkflowExecution;
  markCleanupRunning(executionId: string, now: Date): SourceWorkflowExecution;
  markRunFailed(executionId: string, retryable: boolean, now: Date): SourceWorkflowExecution;
  retryFailedDestinations(executionId: string, now: Date): number;
}

function sourceString(item: RemoteSourceItem, key: string): string | undefined {
  const value = item.metadata[key];
  return typeof value === 'string' ? value : undefined;
}

function sourceNumber(item: RemoteSourceItem, key: string): number | undefined {
  const value = item.metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Filters are deterministic and evaluated before any media-resolution call. */
export function sourceItemMatchesWorkflowFilters(
  item: RemoteSourceItem,
  filters: SourceWorkflowFilters = {},
): boolean {
  const title = sourceString(item, 'title') ?? '';
  const normalizedTitle = title.toLocaleLowerCase();
  if (
    filters.titleContains !== undefined &&
    !normalizedTitle.includes(filters.titleContains.toLocaleLowerCase())
  )
    return false;
  if (
    filters.titleExcludes !== undefined &&
    normalizedTitle.includes(filters.titleExcludes.toLocaleLowerCase())
  )
    return false;
  if (filters.titleRegex !== undefined && !new RegExp(filters.titleRegex, 'u').test(title))
    return false;
  if (
    filters.publishedAfter !== undefined &&
    (item.publishedAt === undefined ||
      item.publishedAt.getTime() <= Date.parse(filters.publishedAfter))
  )
    return false;
  const duration = sourceNumber(item, 'durationSeconds');
  if (
    filters.durationSecondsMin !== undefined &&
    (duration === undefined || duration < filters.durationSecondsMin)
  )
    return false;
  if (
    filters.durationSecondsMax !== undefined &&
    (duration === undefined || duration > filters.durationSecondsMax)
  )
    return false;
  if (filters.privacyStatuses !== undefined) {
    const privacy = sourceString(item, 'privacyStatus');
    if (privacy === undefined || !filters.privacyStatuses.includes(privacy)) return false;
  }
  return true;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sourceWorkflowVersion(workflow: Workflow): string {
  return `sha256:${createHash('sha256')
    .update(
      canonicalJson({
        name: workflow.name,
        titleTemplate: workflow.titleTemplate,
        descriptionTemplate: workflow.descriptionTemplate,
        destinations: workflow.destinations,
        failurePolicy: workflow.failurePolicy,
        remoteSource: workflow.remoteSource,
      }),
    )
    .digest('hex')}`;
}

function executionDestinationKey(destination: WorkflowDestination): string {
  return `${destination.destinationId}:${destination.accountId}`;
}

/** Coordinates source intent, resolution, and the same destination-job path used by local media. */
export class SourceWorkflowCoordinator {
  public constructor(
    private readonly workflows: WorkflowRepository,
    private readonly executions: SourceWorkflowExecutionRepository,
    private readonly resolution: MediaResolutionService,
    private readonly workflowExecution: WorkflowService,
    private readonly jobs: JobService,
    private readonly cleanup: SourceMediaCleanupService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public observe(sourceItemId: string): readonly SourceWorkflowExecution[] {
    const item = this.executions.findSourceItem(sourceItemId);
    if (item === undefined)
      throw new JobExecutionError('SOURCE_ITEM_NOT_FOUND', false, 'Source item not found.');
    const output: SourceWorkflowExecution[] = [];
    for (const workflow of this.workflows.list(true)) {
      const remote = workflow.remoteSource;
      if (
        remote === undefined ||
        remote.connectionId !== item.sourceConnectionId ||
        !sourceItemMatchesWorkflowFilters(item, remote.filters)
      )
        continue;
      const executionId = randomUUID();
      const version = sourceWorkflowVersion(workflow);
      const workflowPlan = workflow.plan;
      const snapshot: SourceWorkflowExecutionSnapshot = {
        schemaVersion: 1,
        source: {
          sourceItemId: item.id,
          sourceConnectionId: item.sourceConnectionId,
          externalId: item.externalId,
          metadata: item.metadata,
          ...(item.publishedAt === undefined
            ? {}
            : { publishedAt: item.publishedAt.toISOString() }),
        },
        filters: { applied: remote.filters ?? {}, matched: true },
        remoteSource: remote,
        workflow: workflowPlan,
      };
      const created = this.executions.create({
        executionId,
        sourceItemId: item.id,
        workflowId: workflow.id,
        workflowKey: workflow.id,
        workflowVersion: version,
        snapshot,
        retentionPolicy: remote.retentionPolicy ?? { kind: 'delete_after_success' },
        now: this.now(),
        destinations: workflow.destinations.map((destination) => {
          const destinationKey = executionDestinationKey(destination);
          return {
            id: randomUUID(),
            destinationId: destination.destinationId,
            destinationKey,
            required: true,
            idempotencyKey: `source-execution:${executionId}:destination:${destinationKey}`,
          };
        }),
      });
      this.enqueueExecution(created.execution.id);
      output.push(created.execution);
    }
    return output;
  }

  public async run(executionId: string, signal: AbortSignal): Promise<void> {
    const execution = this.executions.find(executionId);
    if (execution === undefined)
      throw new JobExecutionError(
        'SOURCE_EXECUTION_NOT_FOUND',
        false,
        'Source execution not found.',
      );
    const item = this.executions.findSourceItem(execution.sourceItemId);
    if (item === undefined)
      throw new JobExecutionError('SOURCE_ITEM_NOT_FOUND', false, 'Source item not found.');
    let resolved: ResolvedSourceMedia;
    try {
      resolved = await this.resolution.resolve({
        sourceItem: item,
        executionId: execution.id,
        jobScopeId: execution.id,
        signal,
        ...(execution.snapshot.remoteSource.localOriginal === undefined
          ? {}
          : { localOriginal: execution.snapshot.remoteSource.localOriginal }),
        ...(execution.snapshot.remoteSource.rightsConfirmed === undefined
          ? {}
          : { rightsConfirmed: execution.snapshot.remoteSource.rightsConfirmed }),
        ...(typeof item.metadata.fileExtension === 'string'
          ? { outputExtension: item.metadata.fileExtension }
          : {}),
      });
    } catch (error) {
      if (error instanceof MediaResolutionError) {
        this.executions.markRunFailed(execution.id, error.retryable, this.now());
        throw new JobExecutionError(error.code, error.retryable, error.message);
      }
      throw error;
    }
    const unfinished = this.executions
      .listDestinations(execution.id)
      .filter(sourceDestinationNeedsWork);
    const results = this.workflowExecution.executeSourceMedia(
      execution.snapshot.workflow,
      resolved.media,
      execution.snapshot.source,
      unfinished.map((destination) => ({
        destinationKey: destination.destinationKey,
        idempotencyKey: destination.idempotencyKey,
      })),
    );
    for (const result of results.destinations) {
      const destination = unfinished.find(
        (candidate) => candidate.destinationKey === result.destinationKey,
      );
      if (destination !== undefined)
        this.executions.attachDestinationJob(destination.id, result.job, this.now());
    }
  }

  public async cleanupExecution(executionId: string): Promise<void> {
    const execution = this.executions.find(executionId);
    if (execution === undefined)
      throw new JobExecutionError(
        'SOURCE_EXECUTION_NOT_FOUND',
        false,
        'Source execution not found.',
      );
    if (execution.cleanupStatus === 'completed' || execution.cleanupStatus === 'retained') return;
    this.executions.markCleanupRunning(executionId, this.now());
    try {
      for (const artifact of this.executions.listArtifacts(executionId))
        await this.cleanup.cleanupArtifact(artifact.id);
      this.executions.markCleanupCompleted(executionId, this.now());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Managed media cleanup failed.';
      this.executions.markCleanupFailed(executionId, 'MEDIA_CLEANUP_FAILED', message, this.now());
      throw new JobExecutionError('MEDIA_CLEANUP_FAILED', true, message);
    }
  }

  public recover(): void {
    for (const execution of this.executions.listNeedingRun()) this.enqueueExecution(execution.id);
    for (const execution of this.executions.listDueCleanup(this.now()))
      this.jobs.create({
        type: 'source.execution.cleanup',
        idempotencyKey: `source-execution:${execution.id}:cleanup`,
        input: { executionId: execution.id },
        maxAttempts: 3,
      });
  }

  public retryFailedDestinations(executionId: string): number {
    const retried = this.executions.retryFailedDestinations(executionId, this.now());
    if (retried > 0) this.recover();
    return retried;
  }

  private enqueueExecution(executionId: string): void {
    this.jobs.create({
      type: 'source.execution.run',
      idempotencyKey: `source-execution:${executionId}:run`,
      input: { executionId },
      maxAttempts: 3,
    });
  }
}

function executionIdFromJobInput(input: JsonValue): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new JobExecutionError('INVALID_SOURCE_JOB_INPUT', false, 'Invalid source job input.');
  const record = input as { readonly [key: string]: JsonValue };
  if (typeof record.executionId !== 'string' || record.executionId.trim().length === 0)
    throw new JobExecutionError('INVALID_SOURCE_JOB_INPUT', false, 'Invalid source job input.');
  return record.executionId;
}

export class SourceItemObservedJobHandler implements JobHandler {
  public readonly type = 'source.item.observed';
  public constructor(private readonly coordinator: SourceWorkflowCoordinator) {}
  public async execute(input: JsonValue): Promise<void> {
    if (input === null || typeof input !== 'object' || Array.isArray(input))
      throw new JobExecutionError('INVALID_SOURCE_JOB_INPUT', false, 'Invalid source job input.');
    const record = input as { readonly [key: string]: JsonValue };
    if (typeof record.sourceItemId !== 'string')
      throw new JobExecutionError('INVALID_SOURCE_JOB_INPUT', false, 'Invalid source job input.');
    this.coordinator.observe(record.sourceItemId);
  }
}

export class SourceExecutionJobHandler implements JobHandler {
  public readonly type = 'source.execution.run';
  public constructor(private readonly coordinator: SourceWorkflowCoordinator) {}
  public execute(input: JsonValue, context: JobHandlerContext): Promise<void> {
    return this.coordinator.run(executionIdFromJobInput(input), context.signal);
  }
}

export class SourceCleanupJobHandler implements JobHandler {
  public readonly type = 'source.execution.cleanup';
  public constructor(private readonly coordinator: SourceWorkflowCoordinator) {}
  public execute(input: JsonValue): Promise<void> {
    return this.coordinator.cleanupExecution(executionIdFromJobInput(input));
  }
}

const templateVariables = new Set([
  'file.name',
  'file.stem',
  'media.duration',
  'workflow.name',
  'source.title',
  'source.description',
  'source.publishedAt',
  'source.externalId',
]);
const templateToken = /{{\s*([^{}\s]+)\s*}}/g;

export function validateTemplate(template: string): void {
  if (template.length > 20_000) throw new Error('A template is too long.');
  for (const match of template.matchAll(templateToken)) {
    if (!templateVariables.has(match[1] ?? ''))
      throw new Error(`Unknown template variable: ${match[1] ?? ''}`);
  }
  const hasToken = /{{\s*[^{}\s]+\s*}}/.test(template);
  if (template.includes('{{') && !hasToken)
    throw new Error('A template contains an invalid variable.');
}

export interface WorkflowTemplateContext {
  readonly file: { readonly name: string; readonly stem: string };
  readonly media: { readonly duration: string };
  readonly source?: {
    readonly description: string;
    readonly externalId: string;
    readonly publishedAt: string;
    readonly title: string;
  };
  readonly workflow: { readonly name: string };
}

export function renderTemplate(template: string, context: WorkflowTemplateContext): string {
  validateTemplate(template);
  const values: Record<string, string> = {
    'file.name': context.file.name,
    'file.stem': context.file.stem,
    'media.duration': context.media.duration,
    'workflow.name': context.workflow.name,
    'source.title': context.source?.title ?? '',
    'source.description': context.source?.description ?? '',
    'source.publishedAt': context.source?.publishedAt ?? '',
    'source.externalId': context.source?.externalId ?? '',
  };
  return template.replace(templateToken, (_match, key: string) => values[key] ?? '');
}

export interface WorkflowDestinationJobResult extends EnqueueJobResult {
  readonly destinationId: WorkflowDestination['destinationId'];
  readonly destinationKey: string;
}

export interface WorkflowExecutionResult {
  readonly destinations: readonly WorkflowDestinationJobResult[];
  readonly failurePolicy: WorkflowFailurePolicy;
  readonly transcription?: {
    readonly transcriptId: string;
    readonly transcriptionJobId?: string;
  };
  readonly workflowId: string;
}

function legacyWorkflowDefinition(
  sourceType: WorkflowSourceStep['sourceType'],
  destinations: readonly WorkflowDestination[],
  filters?: SourceWorkflowFilters,
): WorkflowDefinition {
  const source: WorkflowSourceStep = { id: 'source', kind: 'source', sourceType };
  const filter: WorkflowFilterStep | undefined =
    filters === undefined || Object.keys(filters).length === 0
      ? undefined
      : { id: 'filter', kind: 'filter', filters };
  const previous = filter?.id ?? source.id;
  const destinationSteps = destinations.map((destination, position): WorkflowDestinationStep => ({
    id: `destination-${position + 1}`,
    kind: 'destination',
    destination,
  }));
  return {
    schemaVersion: 1,
    steps: [source, ...(filter === undefined ? [] : [filter]), ...destinationSteps],
    edges: [
      ...(filter === undefined ? [] : [{ from: source.id, to: filter.id }]),
      ...destinationSteps.map((step) => ({ from: previous, to: step.id })),
    ],
  };
}

/**
 * Reserves one deterministic derivative and exposes its transform job as a durable prerequisite.
 * Destination jobs retain their ordinary handlers; their media ID is the validated derivative ID.
 */
export class WorkflowTransformService {
  public constructor(
    private readonly derivatives: TransformDerivativeRepository,
    private readonly jobs: JobService,
    private readonly tool: TransformToolIdentity,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public prepare(
    media: MediaAsset,
    plan: TransformPlanInput,
  ): {
    readonly cacheHit: boolean;
    readonly mediaId: string;
    readonly prerequisiteJobId?: string;
  } {
    const identity = createTransformCacheIdentity({
      sourceFingerprint: media.fingerprint,
      plan,
      outputProfileVersion: 'common-mp4-v1',
      tool: this.tool,
    });
    const reserved = this.derivatives.reserve({
      id: randomUUID(),
      identity,
      now: this.now(),
      sourceMediaId: media.id,
    });
    if (reserved.derivative.status === 'succeeded' && reserved.derivative.output !== undefined)
      return { cacheHit: true, mediaId: reserved.derivative.id };
    const transform = this.jobs.create({
      type: 'media.transform',
      idempotencyKey: `transform:${identity.cacheKey}`,
      input: { derivativeId: reserved.derivative.id },
      maxAttempts: 3,
    });
    return {
      cacheHit: !reserved.created,
      mediaId: reserved.derivative.id,
      prerequisiteJobId: transform.job.id,
    };
  }
}

export interface TransformRunResult {
  readonly cached: boolean;
  readonly derivative: TransformDerivative;
  readonly job?: Job;
}

function derivativeIdForTransformJob(job: Job): string | undefined {
  if (job.type !== 'media.transform' || typeof job.input !== 'object' || job.input === null)
    return undefined;
  const derivativeId = (job.input as Readonly<Record<string, JsonValue>>).derivativeId;
  return typeof derivativeId === 'string' && derivativeId.trim().length > 0
    ? derivativeId
    : undefined;
}

/** Shared application service for direct UI/CLI transform runs and derivative inspection. */
export class TransformService {
  private readonly preparer: WorkflowTransformService | undefined;

  public constructor(
    private readonly media: MediaRepository,
    private readonly derivatives: TransformDerivativeRepository,
    private readonly jobs: JobService,
    tool?: TransformToolIdentity,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.preparer =
      tool === undefined ? undefined : new WorkflowTransformService(derivatives, jobs, tool, now);
  }

  public run(mediaId: string, plan: TransformPlanInput): TransformRunResult {
    if (this.preparer === undefined)
      throw new Error('FFmpeg is required to create a transform derivative.');
    const media = this.media.findById(mediaId);
    if (media === undefined) throw new Error('Media not found.');
    if (media.state !== 'available') throw new Error('Media is not available for transformation.');
    const prepared = this.preparer.prepare(media, plan);
    const derivative = this.derivatives.findById(prepared.mediaId);
    if (derivative === undefined) throw new Error('Transform derivative reservation failed.');
    const job =
      prepared.prerequisiteJobId === undefined
        ? undefined
        : this.jobs.show(prepared.prerequisiteJobId)?.job;
    return {
      cached: prepared.cacheHit,
      derivative,
      ...(job === undefined ? {} : { job }),
    };
  }

  public inspect(id: string): TransformDerivative | undefined {
    return this.derivatives.findById(id);
  }

  public list(status?: TransformDerivativeStatus): readonly TransformDerivative[] {
    return this.derivatives.list(status);
  }

  public forJob(job: Job): TransformDerivative | undefined {
    const derivativeId = derivativeIdForTransformJob(job);
    return derivativeId === undefined ? undefined : this.derivatives.findById(derivativeId);
  }

  public cancelJob(jobId: string): Job | undefined {
    const existing = this.jobs.show(jobId)?.job;
    if (existing === undefined) return undefined;
    const derivative = this.forJob(existing);
    const job = this.jobs.cancel(jobId);
    if (
      derivative !== undefined &&
      job?.status === 'cancelled' &&
      (derivative.status === 'pending' || derivative.status === 'running')
    ) {
      this.derivatives.markCancelled(derivative.id, this.now());
    }
    return job;
  }
}

/** Read-only media-library view that makes validated derivatives publishable without duplicating them. */
export class DerivativeAwareMediaRepository implements MediaRepository {
  public constructor(
    private readonly media: MediaRepository,
    private readonly derivatives: TransformDerivativeRepository,
  ) {}

  public create(asset: MediaAsset): MediaAsset {
    return this.media.create(asset);
  }
  public findByFingerprint(fingerprint: string): MediaAsset | undefined {
    return this.media.findByFingerprint(fingerprint);
  }
  public findById(id: string): MediaAsset | undefined {
    const asset = this.media.findById(id);
    if (asset !== undefined) return asset;
    const derivative = this.derivatives.findById(id);
    if (derivative?.status !== 'succeeded' || derivative.output === undefined) return undefined;
    return {
      id: derivative.id,
      fingerprint: derivative.cacheKey,
      path: derivative.output.path,
      sizeBytes: derivative.output.sizeBytes,
      state: 'available',
      createdAt: derivative.createdAt,
      modifiedAt: derivative.updatedAt,
      metadata: {
        ...derivative.output.metadata,
        durationSeconds: derivative.output.metadata.durationMillis / 1000,
      },
    };
  }
  public list(): readonly MediaAsset[] {
    return this.media.list();
  }
}

/** Workflow application service: validates user input and snapshots rendered metadata into jobs. */
export class WorkflowService {
  public constructor(
    private readonly workflows: WorkflowRepository,
    private readonly jobs: JobService,
    private readonly now: () => Date = () => new Date(),
    private readonly transforms?: WorkflowTransformService,
    private readonly transcriptions?: WorkflowTranscriptionService,
  ) {}

  public create(input: WorkflowInput): Workflow {
    const workflow = this.validateAndBuild(input, randomUUID(), this.now(), this.now());
    return this.workflows.create(workflow);
  }

  public delete(id: string): boolean {
    return this.workflows.delete(id);
  }
  public get(id: string): Workflow | undefined {
    return this.workflows.findById(id);
  }
  public list(enabled?: boolean): readonly Workflow[] {
    return this.workflows.list(enabled);
  }

  public update(id: string, input: WorkflowInput): Workflow | undefined {
    const existing = this.workflows.findById(id);
    if (existing === undefined) return undefined;
    return this.workflows.update(this.validateAndBuild(input, id, existing.createdAt, this.now()));
  }

  /** Uses rendered values, not a live workflow reference, so later edits cannot affect this job. */
  public executeWatchedMedia(
    workflowId: string,
    media: MediaAsset,
    metadata?: WatchedMediaMetadata,
  ): WorkflowExecutionResult | undefined {
    const workflow = this.workflows.findById(workflowId);
    if (workflow === undefined || !workflow.enabled) return undefined;
    return this.executeMedia(
      workflow.plan,
      media,
      metadata === undefined
        ? undefined
        : {
            externalId: metadata.externalId ?? media.fingerprint,
            metadata: {
              ...(metadata.title === undefined ? {} : { title: metadata.title }),
              ...(metadata.description === undefined ? {} : { description: metadata.description }),
            },
            ...(metadata.publishedAt === undefined ? {} : { publishedAt: metadata.publishedAt }),
            sourceConnectionId: `watched-folder:${workflow.id}`,
            sourceItemId: media.id,
          },
    );
  }

  /** Executes an immutable remote-source plan through the normal destination job fan-out. */
  public executeSourceMedia(
    workflow: WorkflowExecutionPlan,
    media: MediaAsset,
    source: SourceWorkflowExecutionSnapshot['source'],
    intents: readonly { readonly destinationKey: string; readonly idempotencyKey: string }[],
  ): WorkflowExecutionResult {
    return this.executeMedia(workflow, media, source, intents);
  }

  /** Resumes the immutable workflow snapshot after its durable transcription prerequisite. */
  public resumeAfterTranscription(continuation: JsonValue): WorkflowExecutionResult {
    if (continuation === null || typeof continuation !== 'object' || Array.isArray(continuation))
      throw new Error('Workflow transcription continuation is invalid.');
    const value = continuation as Readonly<Record<string, JsonValue>>;
    if (
      value.workflow === null ||
      typeof value.workflow !== 'object' ||
      Array.isArray(value.workflow) ||
      value.media === null ||
      typeof value.media !== 'object' ||
      Array.isArray(value.media)
    )
      throw new Error('Workflow transcription continuation is invalid.');
    return this.executeMedia(
      value.workflow as unknown as WorkflowExecutionPlan,
      value.media as unknown as MediaAsset,
      value.source === undefined
        ? undefined
        : (value.source as SourceWorkflowExecutionSnapshot['source']),
      value.intents === undefined
        ? undefined
        : (value.intents as unknown as readonly {
            readonly destinationKey: string;
            readonly idempotencyKey: string;
          }[]),
    );
  }

  private executeMedia(
    workflow: WorkflowExecutionPlan,
    media: MediaAsset,
    source?: SourceWorkflowExecutionSnapshot['source'],
    intents?: readonly { readonly destinationKey: string; readonly idempotencyKey: string }[],
  ): WorkflowExecutionResult {
    validateWorkflowExecutionPlan(workflow);
    const name = media.path.replace(/^.*[\\/]/, '');
    const stem = name.replace(/\.[^.]*$/, '');
    const duration =
      media.metadata.durationSeconds === undefined ? '' : String(media.metadata.durationSeconds);
    const context: WorkflowTemplateContext = {
      file: { name, stem },
      media: { duration },
      workflow,
      ...(source === undefined
        ? {}
        : {
            source: {
              title: typeof source.metadata.title === 'string' ? source.metadata.title : '',
              description:
                typeof source.metadata.description === 'string' ? source.metadata.description : '',
              publishedAt: source.publishedAt ?? '',
              externalId: source.externalId,
            },
          }),
    };
    const title = renderTemplate(workflow.titleTemplate, context).trim();
    if (title.length === 0) throw new Error('A workflow title template must render a title.');
    const description = renderTemplate(workflow.descriptionTemplate, context);
    const destinationPlans = workflow.destinations
      .map((destination) => ({ destination, destinationKey: executionDestinationKey(destination) }))
      .filter(
        ({ destinationKey }) =>
          intents === undefined ||
          intents.some((intent) => intent.destinationKey === destinationKey),
      );
    const transcriptionSteps = workflow.steps.filter(
      (step): step is WorkflowTranscriptionStep => step.kind === 'transcription',
    );
    let transcript: Transcript | undefined;
    if (transcriptionSteps.length === 1) {
      if (this.transcriptions === undefined)
        throw new Error('A transcription provider is required for workflow transcription steps.');
      const prepared = this.transcriptions.prepare({
        media,
        step: transcriptionSteps[0]!,
        continuation: {
          workflow,
          media,
          ...(source === undefined ? {} : { source }),
          ...(intents === undefined ? {} : { intents }),
        } as unknown as JsonValue,
      });
      if (prepared.transcriptionJobId !== undefined)
        return {
          workflowId: workflow.id,
          failurePolicy: workflow.failurePolicy,
          destinations: [],
          transcription: {
            transcriptId: prepared.transcript.id,
            transcriptionJobId: prepared.transcriptionJobId,
          },
        };
      transcript = prepared.transcript;
    }
    const captionSteps = workflow.steps.filter(
      (step): step is WorkflowCaptionStep => step.kind === 'captions',
    );
    const transformPlans = workflow.steps
      .filter((step): step is WorkflowTransformStep => step.kind === 'transform')
      .flatMap((step) => (step.plan === undefined ? [] : [step.plan]));
    if (transformPlans.length > 1)
      throw new Error(
        'A workflow execution supports one transform recipe before destination fan-out.',
      );
    const captionPlan =
      captionSteps.length === 0
        ? undefined
        : transcript === undefined
          ? (() => {
              throw new Error('A workflow caption step requires a completed transcription.');
            })()
          : ({
              user: {
                ...(transformPlans[0]?.user ?? {}),
                steps: [
                  ...(transformPlans[0]?.user.steps ?? []),
                  createCaptionRenderStep(
                    transcript,
                    captionSteps[0]!.mode,
                    captionSteps[0]!.theme,
                  ),
                ],
              },
              ...(transformPlans[0]?.destination === undefined
                ? {}
                : { destination: transformPlans[0].destination }),
            } satisfies TransformPlanInput);
    const effectiveTransformPlan = captionPlan ?? transformPlans[0];
    const prepared: { readonly mediaId: string; readonly prerequisiteJobId?: string } =
      effectiveTransformPlan === undefined
        ? { mediaId: media.id }
        : this.transforms === undefined
          ? (() => {
              throw new Error('FFmpeg and ffprobe are required for workflow transforms.');
            })()
          : this.transforms.prepare(media, effectiveTransformPlan);
    const destinations = destinationPlans.map(
      ({ destination, destinationKey }): WorkflowDestinationJobResult => {
        const common = {
          accountId: destination.accountId,
          mediaId: prepared.mediaId,
          workflow: { id: workflow.id, name: workflow.name },
        };
        const result =
          destination.destinationId === 'youtube'
            ? this.jobs.create({
                type: 'youtube.upload',
                idempotencyKey: this.destinationIdempotencyKey(
                  workflow,
                  media,
                  destination,
                  intents,
                ),
                input: {
                  ...common,
                  metadata: {
                    title,
                    description,
                    privacy: destination.privacy,
                    ...(destination.category === undefined
                      ? {}
                      : { category: destination.category }),
                  },
                },
                ...(prepared.prerequisiteJobId === undefined
                  ? {}
                  : { dependsOnJobId: prepared.prerequisiteJobId }),
              })
            : destination.destinationId === 'tiktok'
              ? this.jobs.create({
                  type: 'tiktok.direct-post',
                  idempotencyKey: this.destinationIdempotencyKey(
                    workflow,
                    media,
                    destination,
                    intents,
                  ),
                  input: {
                    ...common,
                    metadata: {
                      caption:
                        destination.captionTemplate === undefined
                          ? title
                          : renderTemplate(destination.captionTemplate, context),
                      privacyLevel: destination.privacyLevel,
                      ...(destination.disableComment === undefined
                        ? {}
                        : { disableComment: destination.disableComment }),
                      ...(destination.disableDuet === undefined
                        ? {}
                        : { disableDuet: destination.disableDuet }),
                      ...(destination.disableStitch === undefined
                        ? {}
                        : { disableStitch: destination.disableStitch }),
                    },
                  },
                  ...(prepared.prerequisiteJobId === undefined
                    ? {}
                    : { dependsOnJobId: prepared.prerequisiteJobId }),
                })
              : destination.destinationId === 'instagram'
                ? this.jobs.create({
                    type: 'instagram.reels.publish',
                    idempotencyKey: this.destinationIdempotencyKey(
                      workflow,
                      media,
                      destination,
                      intents,
                    ),
                    input: {
                      mediaId: prepared.mediaId,
                      targetId: destination.accountId,
                      metadata: {
                        caption:
                          destination.captionTemplate === undefined
                            ? title
                            : renderTemplate(destination.captionTemplate, context),
                        ...(destination.shareToFeed === undefined
                          ? {}
                          : { shareToFeed: destination.shareToFeed }),
                      },
                    },
                    ...(prepared.prerequisiteJobId === undefined
                      ? {}
                      : { dependsOnJobId: prepared.prerequisiteJobId }),
                  })
                : this.jobs.create({
                    type: 'facebook.reels.publish',
                    idempotencyKey: this.destinationIdempotencyKey(
                      workflow,
                      media,
                      destination,
                      intents,
                    ),
                    input: {
                      mediaId: prepared.mediaId,
                      targetId: destination.accountId,
                      metadata: {
                        ...(destination.titleTemplate === undefined
                          ? { title }
                          : { title: renderTemplate(destination.titleTemplate, context) }),
                        ...(destination.descriptionTemplate === undefined
                          ? { description }
                          : {
                              description: renderTemplate(destination.descriptionTemplate, context),
                            }),
                      },
                    },
                    ...(prepared.prerequisiteJobId === undefined
                      ? {}
                      : { dependsOnJobId: prepared.prerequisiteJobId }),
                  });
        return { destinationId: destination.destinationId, destinationKey, ...result };
      },
    );
    return {
      workflowId: workflow.id,
      failurePolicy: workflow.failurePolicy,
      destinations,
      ...(transcript === undefined ? {} : { transcription: { transcriptId: transcript.id } }),
    };
  }

  private destinationIdempotencyKey(
    workflow: WorkflowExecutionPlan,
    media: MediaAsset,
    destination: WorkflowDestination,
    intents?: readonly { readonly destinationKey: string; readonly idempotencyKey: string }[],
  ): string {
    const destinationKey = executionDestinationKey(destination);
    const intent = intents?.find((candidate) => candidate.destinationKey === destinationKey);
    if (intents !== undefined && intent === undefined)
      throw new Error(`Missing source destination intent: ${destinationKey}`);
    if (intent !== undefined) return intent.idempotencyKey;
    return `workflow:${workflow.id}:media:${media.id}:${destination.destinationId}:${destination.accountId}`;
  }

  private validateAndBuild(
    input: WorkflowInput,
    id: string,
    createdAt: Date,
    updatedAt: Date,
  ): Workflow {
    if (input.name.trim().length === 0) throw new Error('A workflow name is required.');
    const sourceDirectory = input.sourceDirectory?.trim() ?? '';
    if (input.remoteSource === undefined && sourceDirectory.length === 0)
      throw new Error('A watched folder is required.');
    if (input.remoteSource !== undefined && sourceDirectory.length > 0)
      throw new Error('A workflow must use either a watched folder or a remote source.');
    if (input.titleTemplate.trim().length === 0) throw new Error('A title template is required.');
    validateTemplate(input.titleTemplate);
    validateTemplate(input.descriptionTemplate ?? '');
    if (input.failurePolicy !== undefined && input.failurePolicy !== 'best_effort')
      throw new Error('Only best-effort destination execution is supported.');
    if (
      input.destinations !== undefined &&
      (input.accountId !== undefined || input.category !== undefined || input.privacy !== undefined)
    )
      throw new Error('Use either destinations or the legacy YouTube account fields, not both.');
    const destinations =
      input.destinations === undefined
        ? this.legacyYouTubeDestination(input)
        : input.destinations.map((destination) => this.validateDestination(destination));
    if (destinations.length === 0) throw new Error('At least one destination is required.');
    if (
      new Set(
        destinations.map((destination) => `${destination.destinationId}:${destination.accountId}`),
      ).size !== destinations.length
    )
      throw new Error('A workflow can contain each destination only once.');
    const remoteSource =
      input.remoteSource === undefined ? undefined : this.validateRemoteSource(input.remoteSource);
    const definition =
      input.definition ??
      legacyWorkflowDefinition(
        remoteSource === undefined ? 'watched_folder' : 'remote',
        destinations,
        remoteSource?.filters,
      );
    const expectedSourceType = remoteSource === undefined ? 'watched_folder' : 'remote';
    const source = definition.steps.find(
      (step): step is WorkflowSourceStep => step.kind === 'source',
    );
    if (source?.sourceType !== expectedSourceType)
      throw new Error('The workflow source step must match the configured source.');
    const definitionDestinations = definition.steps
      .filter((step): step is WorkflowDestinationStep => step.kind === 'destination')
      .map((step) => this.validateDestination(step.destination));
    if (JSON.stringify(definitionDestinations) !== JSON.stringify(destinations))
      throw new Error('Workflow definition destinations must match configured destinations.');
    const normalizedDefinition: WorkflowDefinition = {
      ...definition,
      steps: definition.steps.map((step) =>
        step.kind !== 'destination'
          ? step
          : { ...step, destination: this.validateDestination(step.destination) },
      ),
    };
    const plan = compileWorkflowExecutionPlan({
      definition: normalizedDefinition,
      id,
      name: input.name.trim(),
      titleTemplate: input.titleTemplate,
      descriptionTemplate: input.descriptionTemplate ?? '',
      failurePolicy: 'best_effort',
    });
    return {
      id,
      name: input.name.trim(),
      enabled: input.enabled ?? true,
      sourceDirectory,
      ...(remoteSource === undefined ? {} : { remoteSource }),
      titleTemplate: input.titleTemplate,
      descriptionTemplate: input.descriptionTemplate ?? '',
      destinations,
      definition: normalizedDefinition,
      plan,
      failurePolicy: 'best_effort',
      createdAt,
      updatedAt,
    };
  }

  private validateRemoteSource(source: RemoteWorkflowSource): RemoteWorkflowSource {
    const connectionId = source.connectionId.trim();
    if (connectionId.length === 0) throw new Error('A remote source connection is required.');
    const filters = source.filters ?? {};
    for (const [name, value] of [
      ['durationSecondsMin', filters.durationSecondsMin],
      ['durationSecondsMax', filters.durationSecondsMax],
    ] as const)
      if (value !== undefined && (!Number.isFinite(value) || value < 0))
        throw new Error(`${name} must be a non-negative number.`);
    if (
      filters.durationSecondsMin !== undefined &&
      filters.durationSecondsMax !== undefined &&
      filters.durationSecondsMin > filters.durationSecondsMax
    )
      throw new Error('Minimum source duration cannot exceed maximum source duration.');
    if (
      filters.publishedAfter !== undefined &&
      !Number.isFinite(Date.parse(filters.publishedAfter))
    )
      throw new Error('publishedAfter must be an RFC 3339 timestamp.');
    if (filters.titleRegex !== undefined) {
      try {
        new RegExp(filters.titleRegex, 'u');
      } catch {
        throw new Error('Source title regex is invalid.');
      }
    }
    const retentionPolicy = source.retentionPolicy ?? { kind: 'delete_after_success' as const };
    if (retentionPolicy.kind === 'keep_for_duration')
      retentionCleanupAt(retentionPolicy, new Date(0));
    return {
      connectionId,
      ...(Object.keys(filters).length === 0 ? {} : { filters }),
      retentionPolicy,
      ...(source.localOriginal === undefined ? {} : { localOriginal: source.localOriginal }),
      ...(source.rightsConfirmed === undefined ? {} : { rightsConfirmed: source.rightsConfirmed }),
    };
  }

  private legacyYouTubeDestination(input: WorkflowInput): readonly WorkflowDestination[] {
    if (input.accountId === undefined || input.accountId.trim().length === 0)
      throw new Error('At least one destination is required.');
    return [
      this.validateDestination({
        accountId: input.accountId,
        destinationId: 'youtube',
        privacy: input.privacy ?? 'private',
        ...(input.category === undefined ? {} : { category: input.category }),
      }),
    ];
  }

  private validateDestination(destination: WorkflowDestination): WorkflowDestination {
    const accountId = destination.accountId.trim();
    if (accountId.length === 0) throw new Error('A destination account is required.');
    if (destination.destinationId === 'youtube') {
      if (!(['private', 'public', 'unlisted'] as const).includes(destination.privacy))
        throw new Error('Invalid YouTube privacy.');
      const category = destination.category?.trim();
      return {
        destinationId: 'youtube',
        accountId,
        privacy: destination.privacy,
        ...(category === undefined || category === '' ? {} : { category }),
      };
    }
    if (destination.destinationId === 'instagram') {
      if (destination.captionTemplate !== undefined) validateTemplate(destination.captionTemplate);
      return {
        destinationId: 'instagram',
        accountId,
        ...(destination.captionTemplate === undefined
          ? {}
          : { captionTemplate: destination.captionTemplate }),
        ...(destination.shareToFeed === undefined ? {} : { shareToFeed: destination.shareToFeed }),
      };
    }
    if (destination.destinationId === 'facebook') {
      if (destination.titleTemplate !== undefined) validateTemplate(destination.titleTemplate);
      if (destination.descriptionTemplate !== undefined)
        validateTemplate(destination.descriptionTemplate);
      return {
        destinationId: 'facebook',
        accountId,
        ...(destination.titleTemplate === undefined
          ? {}
          : { titleTemplate: destination.titleTemplate }),
        ...(destination.descriptionTemplate === undefined
          ? {}
          : { descriptionTemplate: destination.descriptionTemplate }),
      };
    }
    if (
      !(
        ['FOLLOWER_OF_CREATOR', 'MUTUAL_FOLLOW_FRIENDS', 'PUBLIC_TO_EVERYONE', 'SELF_ONLY'] as const
      ).includes(destination.privacyLevel)
    )
      throw new Error('Invalid TikTok privacy level.');
    if (destination.captionTemplate !== undefined) validateTemplate(destination.captionTemplate);
    return {
      destinationId: 'tiktok',
      accountId,
      privacyLevel: destination.privacyLevel,
      ...(destination.captionTemplate === undefined
        ? {}
        : { captionTemplate: destination.captionTemplate }),
      ...(destination.disableComment === undefined
        ? {}
        : { disableComment: destination.disableComment }),
      ...(destination.disableDuet === undefined ? {} : { disableDuet: destination.disableDuet }),
      ...(destination.disableStitch === undefined
        ? {}
        : { disableStitch: destination.disableStitch }),
    };
  }
}
