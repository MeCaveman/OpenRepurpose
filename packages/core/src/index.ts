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
  readonly retryAfterMs?: number;
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
    public readonly retryAfterMs?: number,
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
        const failure: JobFailure =
          error instanceof JobExecutionError
            ? {
                code: error.code,
                message: error.publicMessage,
                retryable: error.retryable,
                ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
              }
            : { code: 'UNEXPECTED_JOB_ERROR', message: 'Job execution failed.', retryable: false };
        const canRetry = failure.retryable && job.attemptCount < job.maxAttempts;
        this.repository.fail(
          job.id,
          this.workerId,
          failure,
          this.now(),
          ...(canRetry ? [this.retryAt(job, failure.retryAfterMs)] : []),
        );
      }
    } finally {
      clearInterval(heartbeat);
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

export type WorkflowDestination = YouTubeWorkflowDestination | TikTokWorkflowDestination;

/** A durable source definition whose destinations execute as independent best-effort jobs. */
export interface Workflow {
  readonly createdAt: Date;
  readonly descriptionTemplate: string;
  readonly destinations: readonly WorkflowDestination[];
  readonly enabled: boolean;
  readonly failurePolicy: WorkflowFailurePolicy;
  readonly id: string;
  readonly name: string;
  readonly sourceDirectory: string;
  readonly titleTemplate: string;
  readonly updatedAt: Date;
}

export interface WorkflowInput {
  /** v0.1 compatibility input. Normalized to a single YouTube destination. */
  readonly accountId?: string;
  readonly category?: string;
  readonly descriptionTemplate?: string;
  readonly destinations?: readonly WorkflowDestination[];
  readonly enabled?: boolean;
  readonly failurePolicy?: WorkflowFailurePolicy;
  readonly name: string;
  readonly privacy?: YouTubePrivacy;
  readonly sourceDirectory: string;
  readonly titleTemplate: string;
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
  find(workflowId: string, sourceKey: string): SourceCursor | undefined;
  save(cursor: SourceCursor): SourceCursor;
}

const templateVariables = new Set(['file.name', 'file.stem', 'media.duration', 'workflow.name']);
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
  readonly workflow: { readonly name: string };
}

export function renderTemplate(template: string, context: WorkflowTemplateContext): string {
  validateTemplate(template);
  const values: Record<string, string> = {
    'file.name': context.file.name,
    'file.stem': context.file.stem,
    'media.duration': context.media.duration,
    'workflow.name': context.workflow.name,
  };
  return template.replace(templateToken, (_match, key: string) => values[key] ?? '');
}

export interface WorkflowDestinationJobResult extends EnqueueJobResult {
  readonly destinationId: WorkflowDestination['destinationId'];
}

export interface WorkflowExecutionResult {
  readonly destinations: readonly WorkflowDestinationJobResult[];
  readonly failurePolicy: WorkflowFailurePolicy;
  readonly workflowId: string;
}

/** Workflow application service: validates user input and snapshots rendered metadata into jobs. */
export class WorkflowService {
  public constructor(
    private readonly workflows: WorkflowRepository,
    private readonly jobs: JobService,
    private readonly now: () => Date = () => new Date(),
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
  ): WorkflowExecutionResult | undefined {
    const workflow = this.workflows.findById(workflowId);
    if (workflow === undefined || !workflow.enabled) return undefined;
    const name = media.path.replace(/^.*[\\/]/, '');
    const stem = name.replace(/\.[^.]*$/, '');
    const duration =
      media.metadata.durationSeconds === undefined ? '' : String(media.metadata.durationSeconds);
    const context: WorkflowTemplateContext = {
      file: { name, stem },
      media: { duration },
      workflow,
    };
    const title = renderTemplate(workflow.titleTemplate, context).trim();
    if (title.length === 0) throw new Error('A workflow title template must render a title.');
    const description = renderTemplate(workflow.descriptionTemplate, context);
    const destinations = workflow.destinations.map((destination): WorkflowDestinationJobResult => {
      const common = {
        accountId: destination.accountId,
        mediaId: media.id,
        workflow: { id: workflow.id, name: workflow.name },
      };
      const result =
        destination.destinationId === 'youtube'
          ? this.jobs.create({
              type: 'youtube.upload',
              idempotencyKey: this.destinationIdempotencyKey(workflow, media, destination),
              input: {
                ...common,
                metadata: {
                  title,
                  description,
                  privacy: destination.privacy,
                  ...(destination.category === undefined ? {} : { category: destination.category }),
                },
              },
            })
          : this.jobs.create({
              type: 'tiktok.direct-post',
              idempotencyKey: this.destinationIdempotencyKey(workflow, media, destination),
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
            });
      return { destinationId: destination.destinationId, ...result };
    });
    return { workflowId: workflow.id, failurePolicy: workflow.failurePolicy, destinations };
  }

  private destinationIdempotencyKey(
    workflow: Workflow,
    media: MediaAsset,
    destination: WorkflowDestination,
  ): string {
    return `workflow:${workflow.id}:media:${media.id}:${destination.destinationId}:${destination.accountId}`;
  }

  private validateAndBuild(
    input: WorkflowInput,
    id: string,
    createdAt: Date,
    updatedAt: Date,
  ): Workflow {
    if (input.name.trim().length === 0) throw new Error('A workflow name is required.');
    if (input.sourceDirectory.trim().length === 0) throw new Error('A watched folder is required.');
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
      new Set(destinations.map((destination) => destination.destinationId)).size !==
      destinations.length
    )
      throw new Error('A workflow can contain each destination only once.');
    return {
      id,
      name: input.name.trim(),
      enabled: input.enabled ?? true,
      sourceDirectory: input.sourceDirectory.trim(),
      titleTemplate: input.titleTemplate,
      descriptionTemplate: input.descriptionTemplate ?? '',
      destinations,
      failurePolicy: 'best_effort',
      createdAt,
      updatedAt,
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
