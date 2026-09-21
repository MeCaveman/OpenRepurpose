import { describe, expect, it } from 'vitest';
import {
  DestinationRegistry,
  PlatformError,
  REDACTED_LOG_VALUE,
  SourceRegistry,
  createRedactingLogger,
  isPlatformError,
  parseRetryAfterMs,
  validateSourcePollResult,
  type AdapterContext,
  type PublishRequest,
  type RedactedLogEntry,
  type SecretReference,
  type SourceAdapterContext,
  type SourcePollResult,
} from '@openrepurpose/platform-sdk';
import {
  InMemorySecretStore,
  MockDestinationAdapter,
  MockSourceAdapter,
  mockDestinationCapabilities,
  mockSourceCapabilities,
} from '@openrepurpose/testkit';

const request: PublishRequest = {
  accountId: 'account-1',
  media: {
    id: 'media-1',
    kind: 'video',
    path: 'C:\\Media\\clip.mp4',
    sizeBytes: 42,
  },
  metadata: { privacy: 'private', title: 'Clip' },
};

function createContext(secretStore: InMemorySecretStore): AdapterContext {
  return {
    idempotencyKey: 'job-1:destination-1',
    logger: createRedactingLogger({ subsystem: 'test', write: () => undefined }),
    secretStore,
    signal: new AbortController().signal,
  };
}

function createSourceContext(secretStore: InMemorySecretStore): SourceAdapterContext {
  return {
    logger: createRedactingLogger({ subsystem: 'source-test', write: () => undefined }),
    secretStore,
    signal: new AbortController().signal,
  };
}

describe('destination adapter contract', () => {
  it('discovers safe capabilities and validates/publishes through the common contract', async () => {
    const secretStore = new InMemorySecretStore();
    const reference: SecretReference = {
      name: 'refresh-token',
      ownerId: request.accountId,
      scope: 'account',
    };
    await secretStore.set(reference, 'server-only-refresh-token');
    const adapter = new MockDestinationAdapter();
    const context = createContext(secretStore);

    expect(await adapter.capabilities()).toEqual(mockDestinationCapabilities);
    expect(await adapter.validate(request)).toEqual({ valid: true });
    expect(await adapter.publish(request, context)).toEqual({
      remoteId: 'mock-remote-id',
      state: 'processing',
    });
    expect(await adapter.getStatus('mock-remote-id', context)).toEqual({ state: 'published' });
    expect(adapter.publishCalls).toEqual([{ context, input: request }]);

    const browserSafeOutput = JSON.stringify({
      capabilities: await adapter.capabilities(),
      result: await adapter.publish(request, context),
    });
    expect(browserSafeOutput).not.toContain('server-only-refresh-token');
    expect(browserSafeOutput).not.toContain('secretStore');
  });

  it('registers replaceable adapters without a provider switch and rejects duplicates', () => {
    const first = new MockDestinationAdapter({ id: 'first' });
    const second = new MockDestinationAdapter({ id: 'second' });
    const registry = new DestinationRegistry([first]);
    const unregister = registry.register(second);

    expect(registry.list()).toEqual([first, second]);
    expect(registry.require('second')).toBe(second);
    expect(() => registry.register(new MockDestinationAdapter({ id: 'first' }))).toThrow(
      'Duplicate destination adapter: first',
    );
    expect(() => registry.require('missing')).toThrow('Unknown destination adapter: missing');

    unregister();
    expect(registry.get('second')).toBeUndefined();
  });
});

describe('source adapter contract', () => {
  it('keeps detection serializable, cursor-based, and stable across repeated observations', async () => {
    const adapter = new MockSourceAdapter();
    const context = createSourceContext(new InMemorySecretStore());
    const request = { connectionExternalId: 'channel-1', cursor: null } as const;

    const first = await adapter.poll(request, context);
    validateSourcePollResult(first);
    const repeated = await adapter.poll({ ...request, cursor: first.cursor }, context);
    validateSourcePollResult(repeated);

    expect(await adapter.capabilities()).toEqual(mockSourceCapabilities);
    expect(first.items.map((item) => item.externalId)).toEqual(
      repeated.items.map((item) => item.externalId),
    );
    expect(first.cursor).toBe('cursor-1');
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(adapter.pollCalls.map((call) => call.request.cursor)).toEqual([null, 'cursor-1']);
  });

  it('rejects observations that cannot provide a stable, unambiguous identity', () => {
    const invalidPages: readonly SourcePollResult[] = [
      {
        cursor: 'cursor',
        hasMore: false,
        items: [{ externalId: ' ', metadata: {} }],
      },
      {
        cursor: 'cursor',
        hasMore: false,
        items: [
          { externalId: 'duplicate', metadata: {} },
          { externalId: 'duplicate', metadata: {} },
        ],
      },
      {
        cursor: ' ',
        hasMore: false,
        items: [],
      },
      {
        cursor: null,
        hasMore: false,
        items: [
          {
            externalId: 'item',
            metadata: {},
            publishedAt: 'not-a-date',
          },
        ],
      },
      { cursor: null, hasMore: true, items: [] },
      {
        cursor: null,
        hasMore: false,
        items: [
          {
            externalId: 'missing-locator',
            media: {
              availability: 'available',
              resolutionStrategies: ['external_downloader'],
              rightsRequirement: 'explicit_confirmation',
            },
            metadata: {},
          },
        ],
      },
    ];

    for (const page of invalidPages) expect(() => validateSourcePollResult(page)).toThrow();
  });

  it('registers replaceable source adapters without a provider switch', () => {
    const first = new MockSourceAdapter({ id: 'first-source' });
    const second = new MockSourceAdapter({ id: 'second-source' });
    const registry = new SourceRegistry([first]);
    const unregister = registry.register(second);

    expect(registry.list()).toEqual([first, second]);
    expect(registry.require('second-source')).toBe(second);
    expect(() => registry.register(new MockSourceAdapter({ id: 'first-source' }))).toThrow(
      'Duplicate source adapter: first-source',
    );
    unregister();
    expect(registry.get('second-source')).toBeUndefined();
  });
});

describe('platform errors', () => {
  it('parses Retry-After seconds and HTTP dates', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(parseRetryAfterMs('1.5', now)).toBe(1_500);
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5_000);
    expect(parseRetryAfterMs('invalid', now)).toBeUndefined();
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
  });

  it('carries stable public classification without exposing an internal cause', () => {
    const error = new PlatformError({
      category: 'rate_limit',
      code: 'YOUTUBE_RATE_LIMITED',
      cause: new Error('Authorization: Bearer internal-token'),
      publicMessage: 'The platform rate limit was reached.',
      retryAfterMs: 30_000,
      retryable: true,
    });

    expect(isPlatformError(error)).toBe(true);
    expect(error).toMatchObject({
      category: 'rate_limit',
      code: 'YOUTUBE_RATE_LIMITED',
      message: 'The platform rate limit was reached.',
      publicMessage: 'The platform rate limit was reached.',
      retryAfterMs: 30_000,
      retryable: true,
    });
    expect(JSON.stringify(error)).not.toContain('internal-token');
  });
});

describe('SecretStore contract', () => {
  it('isolates references and deletes values without exposing enumeration', async () => {
    const store = new InMemorySecretStore();
    const first: SecretReference = { name: 'token', ownerId: 'one', scope: 'account' };
    const second: SecretReference = { name: 'token', ownerId: 'two', scope: 'account' };

    await store.set(first, 'first-secret');
    await store.set(second, 'second-secret');
    expect(await store.get(first)).toBe('first-secret');
    expect(await store.get(second)).toBe('second-secret');
    expect(await store.delete(first)).toBe(true);
    expect(await store.get(first)).toBeUndefined();
    expect(await store.delete(first)).toBe(false);
  });
});

describe('redacting logger', () => {
  it('redacts nested sensitive fields, authorization values, errors, cycles, and known literals', () => {
    const entries: RedactedLogEntry[] = [];
    const logger = createRedactingLogger({
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      secrets: ['literal-client-value'],
      subsystem: 'destination',
      write: (entry) => entries.push(entry),
    }).child({ adapterId: 'mock' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    logger.error(
      {
        authorization: 'Bearer top-secret-token',
        error: new Error('request failed with Bearer nested-secret'),
        nested: {
          clientSecret: 'client-secret',
          safe: 'literal-client-value must disappear',
        },
        cyclic,
      },
      'callback?code=oauth-code and literal-client-value',
    );

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('top-secret-token');
    expect(serialized).not.toContain('nested-secret');
    expect(serialized).not.toContain('client-secret');
    expect(serialized).not.toContain('oauth-code');
    expect(serialized).not.toContain('literal-client-value');
    expect(serialized).toContain(REDACTED_LOG_VALUE);
    expect(entries[0]).toMatchObject({
      fields: { adapterId: 'mock', authorization: REDACTED_LOG_VALUE },
      level: 'error',
      subsystem: 'destination',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
  });
});
