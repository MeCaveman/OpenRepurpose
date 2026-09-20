import { homedir, tmpdir } from 'node:os';
import * as hostPath from 'node:path';
import { z } from 'zod';

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
}

export interface ApplicationConfig {
  readonly appUrl: URL;
  readonly bindHost: string;
  readonly developmentServerUrl?: URL;
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
  readonly transformRunner: {
    readonly killGraceMs: number;
    readonly stallTimeoutMs: number;
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
  return z.url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  }, 'must use http or https');
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
      BIND_HOST: z.string().trim().min(1).default('127.0.0.1'),
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
    })
    .refine((values) => values.JOB_RETRY_MAX_MS >= values.JOB_RETRY_BASE_MS, {
      message: 'must be greater than or equal to JOB_RETRY_BASE_MS',
      path: ['JOB_RETRY_MAX_MS'],
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
    transformRunner: {
      killGraceMs: parsed.TRANSFORM_KILL_GRACE_MS,
      stallTimeoutMs: parsed.TRANSFORM_STALL_TIMEOUT_MS,
      timeoutMs: parsed.TRANSFORM_TIMEOUT_MS,
    },
    watchedFolder: {
      pollIntervalMs: parsed.WATCH_POLL_INTERVAL_MS,
      settleMs: parsed.WATCH_SETTLE_MS,
    },
    paths,
    port: parsed.PORT,
  };
}
