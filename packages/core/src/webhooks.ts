import { createHmac, randomUUID } from 'node:crypto';
import type { SecretReference, SecretStore } from '@openrepurpose/platform-sdk';
import {
  JobExecutionError,
  type Job,
  type JobHandler,
  type JobHandlerContext,
  type JobService,
  type JsonValue,
} from './index.js';

export const webhookEventTypes = [
  'job.failed',
  'job.succeeded',
  'workflow.execution.completed',
  'workflow.execution.started',
] as const;

export type WebhookEventType = (typeof webhookEventTypes)[number];
export type WebhookDeliveryStatus = 'failed' | 'pending' | 'retrying' | 'running' | 'succeeded';

export interface WebhookEvent {
  readonly data: Readonly<Record<string, JsonValue>>;
  readonly id: string;
  readonly occurredAt: Date;
  readonly type: WebhookEventType;
}

export interface WebhookDestination {
  readonly createdAt: Date;
  readonly enabled: boolean;
  readonly events: readonly WebhookEventType[];
  readonly id: string;
  readonly name: string;
  readonly updatedAt: Date;
  readonly url: string;
}

export interface ConfiguredWebhookDestination {
  readonly events: readonly WebhookEventType[];
  readonly id: string;
  readonly name: string;
  readonly secret: string;
  readonly url: URL;
}

export interface WebhookDelivery {
  readonly completedAt?: Date;
  readonly createdAt: Date;
  readonly destinationId: string;
  readonly eventId: string;
  readonly eventType: WebhookEventType;
  readonly id: string;
  readonly jobId?: string;
  readonly lastErrorCode?: string;
  readonly lastResponseStatus?: number;
  readonly payload: string;
  readonly status: WebhookDeliveryStatus;
  readonly updatedAt: Date;
  readonly url: string;
}

export interface CreateWebhookDeliveryInput {
  readonly createdAt: Date;
  readonly destinationId: string;
  readonly eventId: string;
  readonly eventType: WebhookEventType;
  readonly id: string;
  readonly payload: string;
  readonly url: string;
}

export interface WebhookRepository {
  attachJob(deliveryId: string, jobId: string, now: Date): WebhookDelivery;
  createDelivery(input: CreateWebhookDeliveryInput): WebhookDelivery;
  findDelivery(id: string): WebhookDelivery | undefined;
  findDestination(id: string): WebhookDestination | undefined;
  listDeliveries(): readonly WebhookDelivery[];
  listDestinations(): readonly WebhookDestination[];
  listUnqueuedDeliveries(): readonly WebhookDelivery[];
  reconcileDestinations(
    destinations: readonly Omit<ConfiguredWebhookDestination, 'secret'>[],
    now: Date,
  ): readonly WebhookDestination[];
  recordAttemptStarted(deliveryId: string, now: Date): WebhookDelivery;
  recordAttemptResult(
    deliveryId: string,
    result:
      | { readonly status: 'succeeded'; readonly statusCode: number }
      | {
          readonly errorCode: string;
          readonly status: 'failed' | 'retrying';
          readonly statusCode?: number;
        },
    now: Date,
  ): WebhookDelivery;
}

export interface WebhookUrlPolicy {
  validate(url: URL): Promise<void>;
}

export interface WebhookTransportRequest {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface WebhookTransportResult {
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly statusCode: number;
}

export interface WebhookTransport {
  send(url: URL, request: WebhookTransportRequest): Promise<WebhookTransportResult>;
}

export class WebhookTransportError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super('Webhook transport failed.');
    this.name = 'WebhookTransportError';
  }
}

export interface ApplicationEventPublisher {
  publish(event: WebhookEvent): void;
}

export function createWebhookEvent(
  type: WebhookEventType,
  data: Readonly<Record<string, JsonValue>>,
  occurredAt: Date = new Date(),
): WebhookEvent {
  return { data, id: randomUUID(), occurredAt, type };
}

export function webhookSecretReference(destinationId: string): SecretReference {
  return {
    name: 'signing-secret',
    ownerId: `webhook:${destinationId}`,
    scope: 'application',
  };
}

function serializeEvent(event: WebhookEvent): string {
  const payload = JSON.stringify({
    data: event.data,
    id: event.id,
    occurredAt: event.occurredAt.toISOString(),
    schemaVersion: 1,
    type: event.type,
  });
  if (Buffer.byteLength(payload, 'utf8') > 65_536)
    throw new Error('Webhook event payload exceeds 65536 bytes.');
  return payload;
}

/** Persists allowlisted event deliveries and schedules them through the shared durable job queue. */
export class WebhookService implements ApplicationEventPublisher {
  public constructor(
    private readonly repository: WebhookRepository,
    private readonly jobs: JobService,
    private readonly secrets: SecretStore,
    private readonly urlPolicy: WebhookUrlPolicy,
    private readonly maxAttempts: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)
      throw new Error('Webhook maxAttempts must be between 1 and 10.');
  }

  public async configure(
    configured: readonly ConfiguredWebhookDestination[],
  ): Promise<readonly WebhookDestination[]> {
    const previous = this.repository.listDestinations();
    for (const destination of configured) await this.urlPolicy.validate(destination.url);
    for (const destination of configured)
      await this.secrets.set(webhookSecretReference(destination.id), destination.secret);
    const destinations = this.repository.reconcileDestinations(
      configured.map(({ events, id, name, url }) => ({ events, id, name, url })),
      this.now(),
    );
    const configuredIds = new Set(configured.map((destination) => destination.id));
    for (const destination of previous)
      if (!configuredIds.has(destination.id))
        await this.secrets.delete(webhookSecretReference(destination.id));
    return destinations;
  }

  public publish(event: WebhookEvent): void {
    const payload = serializeEvent(event);
    for (const destination of this.repository
      .listDestinations()
      .filter((candidate) => candidate.enabled && candidate.events.includes(event.type))) {
      const delivery = this.repository.createDelivery({
        createdAt: this.now(),
        destinationId: destination.id,
        eventId: event.id,
        eventType: event.type,
        id: randomUUID(),
        payload,
        url: destination.url,
      });
      this.enqueue(delivery);
    }
  }

  /** Repairs the narrow crash window between delivery persistence and idempotent job creation. */
  public recover(): number {
    const unqueued = this.repository.listUnqueuedDeliveries();
    for (const delivery of unqueued) this.enqueue(delivery);
    return unqueued.length;
  }

  public listDestinations(): readonly WebhookDestination[] {
    return this.repository.listDestinations();
  }

  public listDeliveries(): readonly WebhookDelivery[] {
    return this.repository.listDeliveries();
  }

  private enqueue(delivery: WebhookDelivery): void {
    const result = this.jobs.create({
      accountId: delivery.destinationId,
      idempotencyKey: `webhook-delivery:${delivery.id}`,
      input: { deliveryId: delivery.id },
      maxAttempts: this.maxAttempts,
      platformId: 'webhook',
      type: 'webhook.deliver',
    });
    this.repository.attachJob(delivery.id, result.job.id, this.now());
  }
}

function deliveryIdFromInput(input: JsonValue): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new JobExecutionError(
      'WEBHOOK_INPUT_INVALID',
      false,
      'Webhook delivery input is invalid.',
    );
  const deliveryId = (input as Readonly<Record<string, JsonValue>>).deliveryId;
  if (typeof deliveryId !== 'string' || deliveryId.length === 0 || deliveryId.length > 128)
    throw new JobExecutionError(
      'WEBHOOK_INPUT_INVALID',
      false,
      'Webhook delivery input is invalid.',
    );
  return deliveryId;
}

export function createWebhookSignature(input: {
  readonly body: string;
  readonly deliveryId: string;
  readonly secret: string;
  readonly timestamp: string;
}): string {
  return `v1=${createHmac('sha256', input.secret)
    .update(`${input.timestamp}.${input.deliveryId}.${input.body}`, 'utf8')
    .digest('hex')}`;
}

export interface WebhookDeliveryJobHandlerOptions {
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly now?: () => Date;
  readonly random?: () => number;
}

/** Network-agnostic job handler. The transport owns DNS pinning, peer checks, and body limits. */
export class WebhookDeliveryJobHandler implements JobHandler {
  public readonly type = 'webhook.deliver';
  private readonly now: () => Date;
  private readonly random: () => number;

  public constructor(
    private readonly repository: WebhookRepository,
    private readonly secrets: SecretStore,
    private readonly transport: WebhookTransport,
    private readonly options: WebhookDeliveryJobHandlerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
  }

  public async execute(input: JsonValue, context: JobHandlerContext): Promise<void> {
    const deliveryId = deliveryIdFromInput(input);
    const delivery = this.repository.findDelivery(deliveryId);
    if (delivery === undefined)
      throw new JobExecutionError(
        'WEBHOOK_DELIVERY_NOT_FOUND',
        false,
        'Webhook delivery was not found.',
      );
    this.repository.recordAttemptStarted(delivery.id, this.now());
    const destination = this.repository.findDestination(delivery.destinationId);
    if (
      destination === undefined ||
      !destination.enabled ||
      destination.url !== delivery.url ||
      !destination.events.includes(delivery.eventType)
    ) {
      this.repository.recordAttemptResult(
        delivery.id,
        { errorCode: 'WEBHOOK_DESTINATION_NOT_ALLOWED', status: 'failed' },
        this.now(),
      );
      throw new JobExecutionError(
        'WEBHOOK_DESTINATION_NOT_ALLOWED',
        false,
        'Webhook destination is no longer allowlisted.',
      );
    }
    const secret = await this.secrets.get(webhookSecretReference(destination.id));
    if (secret === undefined) {
      this.repository.recordAttemptResult(
        delivery.id,
        { errorCode: 'WEBHOOK_SECRET_MISSING', status: 'failed' },
        this.now(),
      );
      throw new JobExecutionError(
        'WEBHOOK_SECRET_MISSING',
        false,
        'Webhook signing secret is unavailable.',
      );
    }
    const timestamp = String(Math.floor(this.now().getTime() / 1_000));
    let result: WebhookTransportResult;
    try {
      result = await this.transport.send(new URL(delivery.url), {
        body: delivery.payload,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'OpenRepurpose-Webhooks/1',
          'x-openrepurpose-delivery': delivery.id,
          'x-openrepurpose-event': delivery.eventType,
          'x-openrepurpose-signature': createWebhookSignature({
            body: delivery.payload,
            deliveryId: delivery.id,
            secret,
            timestamp,
          }),
          'x-openrepurpose-timestamp': timestamp,
        },
        signal: context.signal,
      });
    } catch (error) {
      if (context.signal.aborted) {
        this.repository.recordAttemptResult(
          delivery.id,
          { errorCode: 'WEBHOOK_CANCELLED', status: 'failed' },
          this.now(),
        );
        throw new JobExecutionError('WEBHOOK_CANCELLED', false, 'Webhook delivery was cancelled.');
      }
      if (error instanceof WebhookTransportError) {
        const retryable = error.retryable && context.attemptNumber < this.options.maxAttempts;
        this.repository.recordAttemptResult(
          delivery.id,
          { errorCode: error.code, status: retryable ? 'retrying' : 'failed' },
          this.now(),
        );
        throw new JobExecutionError(
          error.code,
          retryable,
          'Webhook delivery failed.',
          this.retryDelay(context.attemptNumber),
        );
      }
      result = { retryable: true, statusCode: 0 };
    }
    if (result.statusCode >= 200 && result.statusCode < 300) {
      this.repository.recordAttemptResult(
        delivery.id,
        { status: 'succeeded', statusCode: result.statusCode },
        this.now(),
      );
      return;
    }
    const retryable = result.retryable && context.attemptNumber < this.options.maxAttempts;
    const errorCode =
      result.statusCode === 0
        ? 'WEBHOOK_NETWORK_ERROR'
        : `WEBHOOK_HTTP_${String(result.statusCode)}`;
    this.repository.recordAttemptResult(
      delivery.id,
      {
        errorCode,
        status: retryable ? 'retrying' : 'failed',
        ...(result.statusCode === 0 ? {} : { statusCode: result.statusCode }),
      },
      this.now(),
    );
    throw new JobExecutionError(
      errorCode,
      retryable,
      'Webhook delivery failed.',
      Math.max(this.retryDelay(context.attemptNumber), result.retryAfterMs ?? 0),
    );
  }

  private retryDelay(attemptNumber: number): number {
    const retryDelay = Math.min(
      this.options.retryMaxMs,
      this.options.retryBaseMs * 2 ** Math.max(0, attemptNumber - 1),
    );
    return Math.ceil(retryDelay * (0.5 + Math.min(1, Math.max(0, this.random())) * 0.5));
  }
}

export function webhookEventForSettledJob(
  job: Job,
  occurredAt: Date = new Date(),
): WebhookEvent | undefined {
  if (job.type === 'webhook.deliver') return undefined;
  if (job.status !== 'succeeded' && job.status !== 'failed') return undefined;
  return createWebhookEvent(
    job.status === 'succeeded' ? 'job.succeeded' : 'job.failed',
    {
      jobId: job.id,
      jobType: job.type,
      ...(job.lastErrorCode === undefined ? {} : { errorCode: job.lastErrorCode }),
      ...(job.platformId === undefined ? {} : { platformId: job.platformId }),
    },
    occurredAt,
  );
}
