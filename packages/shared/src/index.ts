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
  readonly sessionKeyPath: string;
  readonly temporaryDirectory: string;
}

export interface ApplicationConfig {
  readonly appUrl: URL;
  readonly bindHost: string;
  readonly developmentServerUrl?: URL;
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
      SESSION_KEY_PATH: absolutePath.optional(),
      BIND_HOST: z.string().trim().min(1).default('127.0.0.1'),
      PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
      APP_URL: httpUrlSchema().default('http://127.0.0.1:3000'),
      DEV_SERVER_URL: httpUrlSchema().optional(),
    })
    .parse(environment);
  const defaults = resolveApplicationPaths(environment, runtime);

  return {
    appUrl: new URL(parsed.APP_URL),
    bindHost: parsed.BIND_HOST,
    ...(parsed.DEV_SERVER_URL === undefined
      ? {}
      : { developmentServerUrl: new URL(parsed.DEV_SERVER_URL) }),
    paths: {
      configDirectory: parsed.APP_CONFIG_DIR ?? defaults.configDirectory,
      dataDirectory: parsed.APP_DATA_DIR ?? defaults.dataDirectory,
      databasePath: parsed.DATABASE_URL ?? defaults.databasePath,
      sessionKeyPath: parsed.SESSION_KEY_PATH ?? defaults.sessionKeyPath,
      temporaryDirectory: parsed.APP_TEMP_DIR ?? defaults.temporaryDirectory,
    },
    port: parsed.PORT,
  };
}
