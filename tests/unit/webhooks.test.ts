import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JobRunner,
  JobService,
  WebhookDeliveryJobHandler,
  WebhookService,
  WebhookTransportError,
  createWebhookEvent,
  createWebhookSignature,
  webhookSecretReference,
  type WebhookTransport,
} from '@openrepurpose/core';
import { SqliteJobRepository, SqliteWebhookRepository } from '@openrepurpose/db';
import { createTemporaryDatabase, InMemorySecretStore } from '@openrepurpose/testkit';
import type { TemporaryDatabase } from '@openrepurpose/testkit';
import {
  NodeWebhookTransport,
  WebhookNetworkPolicy,
  isForbiddenWebhookAddress,
} from '../../apps/server/src/webhooks.js';

describe('outbound webhooks', () => {
  let temporary: TemporaryDatabase | undefined;

  afterEach(() => temporary?.dispose());

  it('signs the exact body together with its timestamp and delivery ID', () => {
    const input = {
      body: '{"schemaVersion":1,"type":"job.succeeded"}',
      deliveryId: 'delivery-1',
      secret: 'a-long-signing-secret',
      timestamp: '1700000000',
    };
    expect(createWebhookSignature(input)).toBe(
      `v1=${createHmac('sha256', input.secret)
        .update(`${input.timestamp}.${input.deliveryId}.${input.body}`)
        .digest('hex')}`,
    );
  });

  it('allows explicit public, private, and loopback destinations but blocks special targets', async () => {
    const publicPolicy = new WebhookNetworkPolicy({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    await expect(
      publicPolicy.resolve(new URL('https://hooks.example.test/events')),
    ).resolves.toEqual({ address: '93.184.216.34', family: 4 });
    await expect(publicPolicy.resolve(new URL('http://127.0.0.1:8080/events'))).resolves.toEqual({
      address: '127.0.0.1',
      family: 4,
    });
    await expect(publicPolicy.resolve(new URL('http://10.0.0.8/events'))).resolves.toEqual({
      address: '10.0.0.8',
      family: 4,
    });

    for (const address of [
      '0.0.0.0',
      '100.100.100.200',
      '169.254.169.254',
      '192.0.2.10',
      '224.0.0.1',
      '::',
      'fe80::1',
      'fd00:ec2::254',
      'ff02::1',
      '::ffff:169.254.169.254',
      '64:ff9b::a9fe:a9fe',
      '2002:a9fe:a9fe::',
      'fec0::1',
    ])
      expect(isForbiddenWebhookAddress(address), address).toBe(true);
    expect(isForbiddenWebhookAddress('::1')).toBe(false);
  });

  it('rejects a DNS answer set when any address is metadata, link-local, or reserved', async () => {
    const policy = new WebhookNetworkPolicy({
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
    });
    await expect(
      policy.resolve(new URL('https://rebind.example.test/events')),
    ).rejects.toMatchObject({ code: 'WEBHOOK_TARGET_BLOCKED', retryable: false });
    await expect(
      policy.resolve(new URL('https://user:password@example.test/events')),
    ).rejects.toMatchObject({ code: 'WEBHOOK_URL_INVALID' });
    await expect(
      policy.resolve(new URL('https://example.test/events#secret')),
    ).rejects.toMatchObject({ code: 'WEBHOOK_URL_INVALID' });
  });

  it('pins the approved address, validates the connected peer, and does not follow redirects', async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      if (request.url === '/large') {
        response.statusCode = 200;
        response.end('x'.repeat(2_048));
        return;
      }
      response.statusCode = 302;
      response.setHeader('Location', 'http://169.254.169.254/latest/meta-data/');
      response.end('redirect ignored');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Test server did not bind.');
      const transport = new NodeWebhookTransport(new WebhookNetworkPolicy(), {
        connectTimeoutMs: 500,
        maxResponseBytes: 1_024,
        timeoutMs: 1_000,
      });
      await expect(
        transport.send(new URL(`http://127.0.0.1:${String(address.port)}/events`), {
          body: '{}',
          headers: { 'content-type': 'application/json' },
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ retryable: false, statusCode: 302 });
      await expect(
        transport.send(new URL(`http://127.0.0.1:${String(address.port)}/large`), {
          body: '{}',
          headers: { 'content-type': 'application/json' },
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'WEBHOOK_RESPONSE_TOO_LARGE', retryable: false });
      expect(requests).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it('persists subscriptions, signs deliveries, and records bounded retry history', async () => {
    temporary = createTemporaryDatabase();
    const jobRepository = new SqliteJobRepository(temporary.database);
    const jobs = new JobService(jobRepository);
    const webhooks = new SqliteWebhookRepository(temporary.database);
    const secrets = new InMemorySecretStore();
    const policy = { validate: async () => undefined };
    const service = new WebhookService(webhooks, jobs, secrets, policy, 2);
    await service.configure([
      {
        events: ['job.succeeded'],
        id: 'local-automation',
        name: 'Local automation',
        secret: 'this-is-a-test-signing-secret',
        url: new URL('http://127.0.0.1:8787/events'),
      },
    ]);
    const requests: { body: string; headers: Readonly<Record<string, string>> }[] = [];
    let attempts = 0;
    const transport: WebhookTransport = {
      send: async (_url, request) => {
        requests.push({ body: request.body, headers: request.headers });
        attempts += 1;
        return attempts === 1
          ? { retryAfterMs: 0, retryable: true, statusCode: 503 }
          : { retryable: false, statusCode: 204 };
      },
    };
    const runner = new JobRunner(
      jobRepository,
      [
        new WebhookDeliveryJobHandler(webhooks, secrets, transport, {
          maxAttempts: 2,
          random: () => 0,
          retryBaseMs: 0,
          retryMaxMs: 0,
        }),
      ],
      { baseRetryDelayMs: 0, maxRetryDelayMs: 0, pollIntervalMs: 10 },
    );

    service.publish(
      createWebhookEvent('job.succeeded', { jobId: 'job-1', jobType: 'youtube.upload' }),
    );
    await runner.runOnce();
    expect(webhooks.listDeliveries()[0]).toMatchObject({ status: 'retrying' });
    await runner.runOnce();

    const delivery = webhooks.listDeliveries()[0]!;
    expect(delivery).toMatchObject({ lastResponseStatus: 204, status: 'succeeded' });
    expect(jobRepository.listAttempts(delivery.jobId!)).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[0]!.body)).toEqual(
      expect.objectContaining({
        data: { jobId: 'job-1', jobType: 'youtube.upload' },
        schemaVersion: 1,
        type: 'job.succeeded',
      }),
    );
    const headers = requests[0]!.headers;
    expect(headers['x-openrepurpose-signature']).toBe(
      createWebhookSignature({
        body: requests[0]!.body,
        deliveryId: delivery.id,
        secret: 'this-is-a-test-signing-secret',
        timestamp: headers['x-openrepurpose-timestamp']!,
      }),
    );
    expect(JSON.stringify(webhooks.listDestinations())).not.toContain(
      'this-is-a-test-signing-secret',
    );
    expect(await secrets.get(webhookSecretReference('local-automation'))).toBe(
      'this-is-a-test-signing-secret',
    );
  });

  it('does not retry policy failures', async () => {
    temporary = createTemporaryDatabase();
    const jobRepository = new SqliteJobRepository(temporary.database);
    const jobs = new JobService(jobRepository);
    const webhooks = new SqliteWebhookRepository(temporary.database);
    const secrets = new InMemorySecretStore();
    const service = new WebhookService(
      webhooks,
      jobs,
      secrets,
      { validate: async () => undefined },
      4,
    );
    await service.configure([
      {
        events: ['job.failed'],
        id: 'blocked-after-rebind',
        name: 'Blocked after rebind',
        secret: 'this-is-a-test-signing-secret',
        url: new URL('https://hooks.example.test/events'),
      },
    ]);
    const runner = new JobRunner(
      jobRepository,
      [
        new WebhookDeliveryJobHandler(
          webhooks,
          secrets,
          {
            send: async () => {
              throw new WebhookTransportError('WEBHOOK_TARGET_BLOCKED', false);
            },
          },
          { maxAttempts: 4, retryBaseMs: 0, retryMaxMs: 0 },
        ),
      ],
      { baseRetryDelayMs: 0, maxRetryDelayMs: 0 },
    );
    service.publish(createWebhookEvent('job.failed', { errorCode: 'SAFE_CODE', jobId: 'job-2' }));
    await runner.runOnce();

    const delivery = webhooks.listDeliveries()[0]!;
    expect(delivery).toMatchObject({
      lastErrorCode: 'WEBHOOK_TARGET_BLOCKED',
      status: 'failed',
    });
    expect(jobRepository.listAttempts(delivery.jobId!)).toHaveLength(1);
  });
});
