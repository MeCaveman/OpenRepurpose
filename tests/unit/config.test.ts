import { describe, expect, it } from 'vitest';
import { posix, win32 } from 'node:path';
import { loadApplicationConfig, resolveApplicationPaths } from '../../packages/shared/src/index.js';

const linuxRuntime = {
  homeDirectory: '/home/ada',
  path: posix,
  platform: 'linux' as const,
  temporaryDirectory: '/tmp',
};
const windowsRuntime = {
  homeDirectory: 'C:\\Users\\Ada',
  path: win32,
  platform: 'win32' as const,
  temporaryDirectory: 'C:\\Temp',
};

describe('application configuration', () => {
  it('uses platform-native Windows application directories', () => {
    const paths = resolveApplicationPaths(
      {
        APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
      },
      windowsRuntime,
    );
    expect(paths.configDirectory).toBe('C:\\Users\\Ada\\AppData\\Roaming\\OpenRepurpose');
    expect(paths.dataDirectory).toBe('C:\\Users\\Ada\\AppData\\Local\\OpenRepurpose');
    expect(paths.sessionKeyPath).toBe(
      'C:\\Users\\Ada\\AppData\\Roaming\\OpenRepurpose\\session.key',
    );
    expect(paths.secretKeyPath).toBe(
      'C:\\Users\\Ada\\AppData\\Roaming\\OpenRepurpose\\secret-vault.key',
    );
    expect(paths.secretVaultPath).toBe(
      'C:\\Users\\Ada\\AppData\\Local\\OpenRepurpose\\secrets.vault.json',
    );
    expect(paths.transcriptionModelDirectory).toBe(
      'C:\\Users\\Ada\\AppData\\Local\\OpenRepurpose\\models\\whisper-cpp',
    );
  });

  it('uses XDG paths on Linux and accepts absolute deployment overrides', () => {
    const paths = resolveApplicationPaths(
      { XDG_CONFIG_HOME: '/etc/openrepurpose', XDG_DATA_HOME: '/srv/openrepurpose' },
      linuxRuntime,
    );
    expect(paths.configDirectory).toBe('/etc/openrepurpose/OpenRepurpose');
    expect(paths.databasePath).toBe('/srv/openrepurpose/OpenRepurpose/openrepurpose.sqlite');

    const config = loadApplicationConfig(
      {
        APP_CONFIG_DIR: '/config',
        APP_DATA_DIR: '/data',
        APP_TEMP_DIR: '/tmp/openrepurpose',
        DATABASE_URL: '/data/database.sqlite',
        APP_URL: 'https://repurpose.example.test',
        BIND_HOST: '0.0.0.0',
        DEV_SERVER_URL: 'http://127.0.0.1:5173',
        PORT: '8080',
        SESSION_KEY_PATH: '/config/custom-session.key',
        SECRET_KEY_PATH: '/config/custom-secret.key',
        SECRET_VAULT_PATH: '/data/custom-secrets.json',
        WHISPER_MODEL_DIR: '/models/whisper',
        JOB_CONCURRENCY: '8',
        JOB_PLATFORM_CONCURRENCY: '4',
        JOB_ACCOUNT_CONCURRENCY: '2',
        JOB_AUTH_FAILURE_THRESHOLD: '5',
      },
      linuxRuntime,
    );
    expect(config.appUrl.origin).toBe('https://repurpose.example.test');
    expect(config.bindHost).toBe('0.0.0.0');
    expect(config.developmentServerUrl?.origin).toBe('http://127.0.0.1:5173');
    expect(config.paths.sessionKeyPath).toBe('/config/custom-session.key');
    expect(config.paths.secretKeyPath).toBe('/config/custom-secret.key');
    expect(config.paths.secretVaultPath).toBe('/data/custom-secrets.json');
    expect(config.paths.transcriptionModelDirectory).toBe('/models/whisper');
    expect(config.port).toBe(8080);
    expect(config.jobRunner).toMatchObject({
      concurrency: 8,
      platformConcurrency: 4,
      accountConcurrency: 2,
      authFailureThreshold: 5,
    });
    expect(config.transformRunner).toEqual({
      killGraceMs: 5_000,
      stallTimeoutMs: 300_000,
      timeoutMs: 21_600_000,
    });
  });

  it('rejects invalid network configuration', () => {
    expect(() => loadApplicationConfig({ PORT: '70000' }, linuxRuntime)).toThrow();
    expect(() => loadApplicationConfig({ APP_URL: 'file:///tmp/app' }, linuxRuntime)).toThrow(
      'must use http or https',
    );
    expect(() =>
      loadApplicationConfig({ JOB_RETRY_BASE_MS: '1000', JOB_RETRY_MAX_MS: '999' }, linuxRuntime),
    ).toThrow('must be greater than or equal to JOB_RETRY_BASE_MS');
    expect(() =>
      loadApplicationConfig({ OBS_WEBSOCKET_URL: 'ws://obs.example.test:4455' }, linuxRuntime),
    ).toThrow('must use wss for a non-loopback OBS endpoint');
    expect(() => loadApplicationConfig({ OBS_WEBSOCKET_PASSWORD: 'secret' }, linuxRuntime)).toThrow(
      'requires OBS_WEBSOCKET_URL',
    );
  });

  it('loads explicit LAN, TLS, and reverse-proxy configuration without weakening the loopback default', () => {
    const config = loadApplicationConfig(
      {
        APP_URL: 'https://repurpose.example.test',
        BIND_HOST: '0.0.0.0',
        LAN_ENABLED: 'true',
        LAN_ACCESS_TOKEN: 'a'.repeat(32),
        TLS_CERT_PATH: '/config/tls/cert.pem',
        TLS_KEY_PATH: '/config/tls/key.pem',
        TRUST_PROXY: 'true',
      },
      linuxRuntime,
    );
    expect(config.network).toEqual({
      lanEnabled: true,
      lanAccessToken: 'a'.repeat(32),
      tls: { certPath: '/config/tls/cert.pem', keyPath: '/config/tls/key.pem' },
      trustedProxy: true,
    });
    expect(() =>
      loadApplicationConfig({ TLS_CERT_PATH: '/config/tls/cert.pem' }, linuxRuntime),
    ).toThrow('TLS_CERT_PATH and TLS_KEY_PATH must be configured together');
  });

  it('loads an optional local OBS WebSocket hint without making folder watches depend on it', () => {
    const config = loadApplicationConfig(
      {
        OBS_WEBSOCKET_URL: 'ws://127.0.0.1:4455',
        OBS_WEBSOCKET_PASSWORD: 'local-only-password',
        OBS_WEBSOCKET_RECONNECT_MS: '7500',
      },
      linuxRuntime,
    );
    expect(config.obsWebSocket).toMatchObject({
      password: 'local-only-password',
      reconnectDelayMs: 7_500,
    });
    expect(config.obsWebSocket?.url.toString()).toBe('ws://127.0.0.1:4455/');
  });

  it('loads an explicit webhook allowlist with bounded delivery settings', () => {
    const config = loadApplicationConfig(
      {
        WEBHOOK_DESTINATIONS_JSON: JSON.stringify([
          {
            id: 'local-automation',
            name: 'Local automation',
            url: 'http://127.0.0.1:8787/events',
            events: ['job.succeeded', 'job.succeeded', 'job.failed'],
            secret: 'a-long-random-secret',
          },
        ]),
        WEBHOOK_CONNECT_TIMEOUT_MS: '1500',
        WEBHOOK_TIMEOUT_MS: '4000',
        WEBHOOK_MAX_ATTEMPTS: '5',
      },
      linuxRuntime,
    );
    expect(config.webhooks).toMatchObject({
      connectTimeoutMs: 1_500,
      maxAttempts: 5,
      timeoutMs: 4_000,
    });
    expect(config.webhooks.destinations[0]).toMatchObject({
      events: ['job.succeeded', 'job.failed'],
      id: 'local-automation',
      secret: 'a-long-random-secret',
    });
    expect(config.webhooks.destinations[0]?.url.toString()).toBe('http://127.0.0.1:8787/events');
  });

  it('rejects malformed or unsafe webhook bootstrap configuration', () => {
    expect(() =>
      loadApplicationConfig({ WEBHOOK_DESTINATIONS_JSON: 'not-json' }, linuxRuntime),
    ).toThrow('must be valid JSON');
    expect(() =>
      loadApplicationConfig(
        {
          WEBHOOK_DESTINATIONS_JSON: JSON.stringify([
            {
              id: 'hook',
              name: 'Hook',
              url: 'https://user:password@example.test/events',
              events: ['job.failed'],
              secret: 'a-long-random-secret',
            },
          ]),
        },
        linuxRuntime,
      ),
    ).toThrow('must not embed credentials');
    expect(() =>
      loadApplicationConfig(
        { WEBHOOK_CONNECT_TIMEOUT_MS: '5000', WEBHOOK_TIMEOUT_MS: '1000' },
        linuxRuntime,
      ),
    ).toThrow('must be less than or equal to WEBHOOK_TIMEOUT_MS');
  });

  it('rejects relative path overrides', () => {
    expect(() => loadApplicationConfig({ APP_DATA_DIR: 'relative-data' }, linuxRuntime)).toThrow(
      'must be an absolute path',
    );
  });

  it('keeps session, vault, and vault-key files distinct', () => {
    expect(() =>
      loadApplicationConfig(
        { SESSION_KEY_PATH: '/config/shared.key', SECRET_KEY_PATH: '/config/shared.key' },
        linuxRuntime,
      ),
    ).toThrow('must be distinct');
  });
});
