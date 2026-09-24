import { homedir, tmpdir } from 'node:os';
import * as hostPath from 'node:path';
import { z } from 'zod';

export { z } from 'zod';
export type { ZodType } from 'zod';

/** The product release identifier exposed by the CLI, HTTP health routes, and MCP. */
export const OPENREPURPOSE_VERSION = '1.0.0' as const;

export interface Environment {
  readonly [name: string]: string | undefined;
}

export interface ApplicationPaths {
  readonly configDirectory: string;
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly secretKeyPath: string;
  readonly secretVaultPath: string;
  readonly sessionKeyPath: string;
  readonly temporaryDirectory: string;
  readonly transcriptionModelDirectory: string;
}

export interface ApplicationConfig {
  readonly appUrl: URL;
  readonly bindHost: string;
  readonly developmentServerUrl?: URL;
  /** Password is a startup bootstrap value; server composition copies it into SecretStore. */
  readonly obsWebSocket?: {
    readonly password?: string;
    readonly reconnectDelayMs: number;
    readonly url: URL;
  };
  readonly jobRunner: {
    readonly accountConcurrency: number;
    readonly authFailureThreshold: number;
    readonly baseRetryDelayMs: number;
    readonly concurrency: number;
    readonly leaseDurationMs: number;
    readonly maxRetryDelayMs: number;
    readonly pollIntervalMs: number;
    readonly platformConcurrency: number;
  };
  readonly network?: {
    /** Non-loopback exposure is an explicit operator decision. */
    readonly lanEnabled: boolean;
    /** Required for browser/static access when LAN exposure is enabled. Never log this value. */
    readonly lanAccessToken?: string;
    readonly trustedProxy: boolean;
    readonly tls?: { readonly certPath: string; readonly keyPath: string };
  };
  readonly transformRunner: {
    readonly killGraceMs: number;
    readonly stallTimeoutMs: number;
    readonly timeoutMs: number;
  };
  readonly webhooks: {
    readonly connectTimeoutMs: number;
    readonly destinations: readonly {
      readonly events: readonly (
        | 'job.failed'
        | 'job.succeeded'
        | 'workflow.execution.completed'
        | 'workflow.execution.started'
      )[];
      readonly id: string;
      readonly name: string;
      /** Startup bootstrap value copied into SecretStore by server composition. */
      readonly secret: string;
      readonly url: URL;
    }[];
    readonly maxAttempts: number;
    readonly maxResponseBytes: number;
    readonly retryBaseMs: number;
    readonly retryMaxMs: number;
    readonly timeoutMs: number;
  };
  readonly watchedFolder?: { readonly pollIntervalMs: number; readonly settleMs: number };
  readonly paths: ApplicationPaths;
  readonly port: number;
}

export interface PathResolutionRuntime {
  readonly homeDirectory: string;
  readonly path: Pick<typeof hostPath, 'isAbsolute' | 'resolve'>;
  readonly platform: NodeJS.Platform;
  readonly temporaryDirectory: string;
}

const defaultPathResolutionRuntime: PathResolutionRuntime = {
  homeDirectory: homedir(),
  path: hostPath,
  platform: process.platform,
  temporaryDirectory: tmpdir(),
};

function pathSchema(runtime: PathResolutionRuntime) {
  return z.string().trim().min(1).refine(runtime.path.isAbsolute, 'must be an absolute path');
}

function httpUrlSchema() {
  return z.url().superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      context.addIssue({ code: 'custom', message: 'must use http or https' });
    if (url.username.length > 0 || url.password.length > 0)
      context.addIssue({ code: 'custom', message: 'must not embed credentials' });
    if (url.pathname !== '/' || url.search.length > 0 || url.hash.length > 0)
      context.addIssue({
        code: 'custom',
        message: 'must be an origin without a path, query, or hash',
      });
  });
}

function obsWebSocketUrlSchema() {
  return z
    .string()
    .trim()
    .url()
    .superRefine((value, context) => {
      const url = new URL(value);
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        context.addIssue({ code: 'custom', message: 'must use ws or wss' });
        return;
      }
      if (url.username.length > 0 || url.password.length > 0)
        context.addIssue({ code: 'custom', message: 'must not embed credentials' });
      if (
        url.protocol === 'ws:' &&
        !new Set(['127.0.0.1', '::1', 'localhost']).has(url.hostname.toLowerCase())
      )
        context.addIssue({
          code: 'custom',
          message: 'must use wss for a non-loopback OBS endpoint',
        });
    });
}

const webhookEventSchema = z.enum([
  'job.failed',
  'job.succeeded',
  'workflow.execution.completed',
  'workflow.execution.started',
]);

const webhookDestinationSchema = z
  .object({
    events: z.array(webhookEventSchema).min(1).max(4),
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
    name: z.string().trim().min(1).max(120),
    secret: z.string().min(16).max(4_096),
    url: z
      .string()
      .trim()
      .url()
      .superRefine((value, context) => {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
          context.addIssue({ code: 'custom', message: 'must use http or https' });
        if (url.username.length > 0 || url.password.length > 0)
          context.addIssue({ code: 'custom', message: 'must not embed credentials' });
        if (url.hash.length > 0)
          context.addIssue({ code: 'custom', message: 'must not include a fragment' });
      }),
  })
  .strict();

function webhookDestinationsSchema() {
  return z
    .string()
    .default('[]')
    .transform((value, context) => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        context.addIssue({ code: 'custom', message: 'must be valid JSON' });
        return z.NEVER;
      }
    })
    .pipe(z.array(webhookDestinationSchema).max(20))
    .superRefine((destinations, context) => {
      const ids = new Set<string>();
      for (const [index, destination] of destinations.entries()) {
        if (ids.has(destination.id))
          context.addIssue({
            code: 'custom',
            message: 'destination IDs must be unique',
            path: [index, 'id'],
          });
        ids.add(destination.id);
      }
    });
}

/**
 * Resolves host-native locations without creating them. Deployment code can override every path
 * with an absolute environment value, so no local-PC path is assumed by application services.
 */
export function resolveApplicationPaths(
  environment: Environment = process.env,
  runtime: PathResolutionRuntime = defaultPathResolutionRuntime,
): ApplicationPaths {
  const isWindows = runtime.platform === 'win32';
  const configBase = isWindows
    ? (environment.APPDATA ?? runtime.path.resolve(runtime.homeDirectory, 'AppData', 'Roaming'))
    : (environment.XDG_CONFIG_HOME ?? runtime.path.resolve(runtime.homeDirectory, '.config'));
  const dataBase = isWindows
    ? (environment.LOCALAPPDATA ?? runtime.path.resolve(runtime.homeDirectory, 'AppData', 'Local'))
    : (environment.XDG_DATA_HOME ?? runtime.path.resolve(runtime.homeDirectory, '.local', 'share'));
  const configDirectory =
    environment.APP_CONFIG_DIR ?? runtime.path.resolve(configBase, 'OpenRepurpose');
  const dataDirectory = environment.APP_DATA_DIR ?? runtime.path.resolve(dataBase, 'OpenRepurpose');

  return {
    configDirectory,
    dataDirectory,
    databasePath:
      environment.DATABASE_URL ?? runtime.path.resolve(dataDirectory, 'openrepurpose.sqlite'),
    secretKeyPath:
      environment.SECRET_KEY_PATH ?? runtime.path.resolve(configDirectory, 'secret-vault.key'),
    secretVaultPath:
      environment.SECRET_VAULT_PATH ?? runtime.path.resolve(dataDirectory, 'secrets.vault.json'),
    sessionKeyPath:
      environment.SESSION_KEY_PATH ?? runtime.path.resolve(configDirectory, 'session.key'),
    temporaryDirectory:
      environment.APP_TEMP_DIR ?? runtime.path.resolve(runtime.temporaryDirectory, 'OpenRepurpose'),
    transcriptionModelDirectory:
      environment.WHISPER_MODEL_DIR ?? runtime.path.resolve(dataDirectory, 'models', 'whisper-cpp'),
  };
}

/** Loads and validates all runtime environment values at the composition boundary. */
export function loadApplicationConfig(
  environment: Environment = process.env,
  runtime: PathResolutionRuntime = defaultPathResolutionRuntime,
): ApplicationConfig {
  const absolutePath = pathSchema(runtime);
  const parsed = z
    .object({
      APP_CONFIG_DIR: absolutePath.optional(),
      APP_DATA_DIR: absolutePath.optional(),
      APP_TEMP_DIR: absolutePath.optional(),
      DATABASE_URL: absolutePath.optional(),
      SECRET_KEY_PATH: absolutePath.optional(),
      SECRET_VAULT_PATH: absolutePath.optional(),
      SESSION_KEY_PATH: absolutePath.optional(),
      WHISPER_MODEL_DIR: absolutePath.optional(),
      BIND_HOST: z.string().trim().min(1).default('127.0.0.1'),
      LAN_ENABLED: z.enum(['true', 'false']).default('false'),
      LAN_ACCESS_TOKEN: z.string().min(32).max(512).optional(),
      TLS_CERT_PATH: absolutePath.optional(),
      TLS_KEY_PATH: absolutePath.optional(),
      TRUST_PROXY: z.enum(['true', 'false']).default('false'),
      PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
      APP_URL: httpUrlSchema().default('http://127.0.0.1:3000'),
      DEV_SERVER_URL: httpUrlSchema().optional(),
      JOB_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
      JOB_PLATFORM_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
      JOB_ACCOUNT_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
      JOB_AUTH_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(20).default(3),
      JOB_LEASE_MS: z.coerce.number().int().min(1_000).default(30_000),
      JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(25).default(250),
      JOB_RETRY_BASE_MS: z.coerce.number().int().min(0).default(1_000),
      JOB_RETRY_MAX_MS: z.coerce.number().int().min(0).default(60_000),
      TRANSFORM_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(21_600_000),
      TRANSFORM_STALL_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(300_000),
      TRANSFORM_KILL_GRACE_MS: z.coerce.number().int().min(0).default(5_000),
      WATCH_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(2_000),
      WATCH_SETTLE_MS: z.coerce.number().int().min(0).default(10_000),
      OBS_WEBSOCKET_URL: obsWebSocketUrlSchema().optional(),
      OBS_WEBSOCKET_PASSWORD: z.string().max(4_096).optional(),
      OBS_WEBSOCKET_RECONNECT_MS: z.coerce.number().int().min(1_000).max(300_000).default(5_000),
      WEBHOOK_DESTINATIONS_JSON: webhookDestinationsSchema(),
      WEBHOOK_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),
      WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
      WEBHOOK_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).default(65_536),
      WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(4),
      WEBHOOK_RETRY_BASE_MS: z.coerce.number().int().min(0).max(3_600_000).default(1_000),
      WEBHOOK_RETRY_MAX_MS: z.coerce.number().int().min(0).max(86_400_000).default(60_000),
    })
    .refine((values) => values.JOB_RETRY_MAX_MS >= values.JOB_RETRY_BASE_MS, {
      message: 'must be greater than or equal to JOB_RETRY_BASE_MS',
      path: ['JOB_RETRY_MAX_MS'],
    })
    .refine(
      (values) =>
        (values.TLS_CERT_PATH === undefined && values.TLS_KEY_PATH === undefined) ||
        (values.TLS_CERT_PATH !== undefined && values.TLS_KEY_PATH !== undefined),
      {
        message: 'TLS_CERT_PATH and TLS_KEY_PATH must be configured together.',
        path: ['TLS_KEY_PATH'],
      },
    )
    .refine(
      (values) =>
        values.OBS_WEBSOCKET_URL !== undefined || values.OBS_WEBSOCKET_PASSWORD === undefined,
      { message: 'requires OBS_WEBSOCKET_URL', path: ['OBS_WEBSOCKET_PASSWORD'] },
    )
    .refine((values) => values.WEBHOOK_CONNECT_TIMEOUT_MS <= values.WEBHOOK_TIMEOUT_MS, {
      message: 'must be less than or equal to WEBHOOK_TIMEOUT_MS',
      path: ['WEBHOOK_CONNECT_TIMEOUT_MS'],
    })
    .refine((values) => values.WEBHOOK_RETRY_MAX_MS >= values.WEBHOOK_RETRY_BASE_MS, {
      message: 'must be greater than or equal to WEBHOOK_RETRY_BASE_MS',
      path: ['WEBHOOK_RETRY_MAX_MS'],
    })
    .parse(environment);
  const defaults = resolveApplicationPaths(environment, runtime);
  const paths: ApplicationPaths = {
    configDirectory: parsed.APP_CONFIG_DIR ?? defaults.configDirectory,
    dataDirectory: parsed.APP_DATA_DIR ?? defaults.dataDirectory,
    databasePath: parsed.DATABASE_URL ?? defaults.databasePath,
    secretKeyPath: parsed.SECRET_KEY_PATH ?? defaults.secretKeyPath,
    secretVaultPath: parsed.SECRET_VAULT_PATH ?? defaults.secretVaultPath,
    sessionKeyPath: parsed.SESSION_KEY_PATH ?? defaults.sessionKeyPath,
    temporaryDirectory: parsed.APP_TEMP_DIR ?? defaults.temporaryDirectory,
    transcriptionModelDirectory: parsed.WHISPER_MODEL_DIR ?? defaults.transcriptionModelDirectory,
  };
  const sensitivePaths = [paths.secretKeyPath, paths.secretVaultPath, paths.sessionKeyPath].map(
    (path) => {
      const resolved = runtime.path.resolve(path);
      return runtime.platform === 'win32' ? resolved.toLowerCase() : resolved;
    },
  );
  if (new Set(sensitivePaths).size !== sensitivePaths.length)
    throw new Error('SESSION_KEY_PATH, SECRET_KEY_PATH, and SECRET_VAULT_PATH must be distinct.');

  return {
    appUrl: new URL(parsed.APP_URL),
    bindHost: parsed.BIND_HOST,
    ...(parsed.DEV_SERVER_URL === undefined
      ? {}
      : { developmentServerUrl: new URL(parsed.DEV_SERVER_URL) }),
    ...(parsed.OBS_WEBSOCKET_URL === undefined
      ? {}
      : {
          obsWebSocket: {
            ...(parsed.OBS_WEBSOCKET_PASSWORD === undefined
              ? {}
              : { password: parsed.OBS_WEBSOCKET_PASSWORD }),
            reconnectDelayMs: parsed.OBS_WEBSOCKET_RECONNECT_MS,
            url: new URL(parsed.OBS_WEBSOCKET_URL),
          },
        }),
    jobRunner: {
      accountConcurrency: parsed.JOB_ACCOUNT_CONCURRENCY,
      authFailureThreshold: parsed.JOB_AUTH_FAILURE_THRESHOLD,
      baseRetryDelayMs: parsed.JOB_RETRY_BASE_MS,
      concurrency: parsed.JOB_CONCURRENCY,
      leaseDurationMs: parsed.JOB_LEASE_MS,
      maxRetryDelayMs: parsed.JOB_RETRY_MAX_MS,
      pollIntervalMs: parsed.JOB_POLL_INTERVAL_MS,
      platformConcurrency: parsed.JOB_PLATFORM_CONCURRENCY,
    },
    network: {
      lanEnabled: parsed.LAN_ENABLED === 'true',
      ...(parsed.LAN_ACCESS_TOKEN === undefined ? {} : { lanAccessToken: parsed.LAN_ACCESS_TOKEN }),
      trustedProxy: parsed.TRUST_PROXY === 'true',
      ...(parsed.TLS_CERT_PATH === undefined
        ? {}
        : { tls: { certPath: parsed.TLS_CERT_PATH, keyPath: parsed.TLS_KEY_PATH! } }),
    },
    transformRunner: {
      killGraceMs: parsed.TRANSFORM_KILL_GRACE_MS,
      stallTimeoutMs: parsed.TRANSFORM_STALL_TIMEOUT_MS,
      timeoutMs: parsed.TRANSFORM_TIMEOUT_MS,
    },
    webhooks: {
      connectTimeoutMs: parsed.WEBHOOK_CONNECT_TIMEOUT_MS,
      destinations: parsed.WEBHOOK_DESTINATIONS_JSON.map((destination) => ({
        ...destination,
        events: [...new Set(destination.events)],
        url: new URL(destination.url),
      })),
      maxAttempts: parsed.WEBHOOK_MAX_ATTEMPTS,
      maxResponseBytes: parsed.WEBHOOK_MAX_RESPONSE_BYTES,
      retryBaseMs: parsed.WEBHOOK_RETRY_BASE_MS,
      retryMaxMs: parsed.WEBHOOK_RETRY_MAX_MS,
      timeoutMs: parsed.WEBHOOK_TIMEOUT_MS,
    },
    watchedFolder: {
      pollIntervalMs: parsed.WATCH_POLL_INTERVAL_MS,
      settleMs: parsed.WATCH_SETTLE_MS,
    },
    paths,
    port: parsed.PORT,
  };
}
