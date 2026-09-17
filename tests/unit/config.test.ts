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
      },
      linuxRuntime,
    );
    expect(config.appUrl.origin).toBe('https://repurpose.example.test');
    expect(config.bindHost).toBe('0.0.0.0');
    expect(config.developmentServerUrl?.origin).toBe('http://127.0.0.1:5173');
    expect(config.paths.sessionKeyPath).toBe('/config/custom-session.key');
    expect(config.port).toBe(8080);
  });

  it('rejects invalid network configuration', () => {
    expect(() => loadApplicationConfig({ PORT: '70000' }, linuxRuntime)).toThrow();
    expect(() => loadApplicationConfig({ APP_URL: 'file:///tmp/app' }, linuxRuntime)).toThrow(
      'must use http or https',
    );
  });

  it('rejects relative path overrides', () => {
    expect(() => loadApplicationConfig({ APP_DATA_DIR: 'relative-data' }, linuxRuntime)).toThrow(
      'must be an absolute path',
    );
  });
});
