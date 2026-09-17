import { afterEach, describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertLocalOnly, loadOrCreateSessionKey } from '@openrepurpose/server';
import type { ApplicationConfig } from '@openrepurpose/shared';

const testDirectory = resolve('test-results/session-key');
const keyPath = resolve(testDirectory, 'session.key');

function config(bindHost: string, appUrl = 'http://127.0.0.1:3000'): ApplicationConfig {
  return {
    appUrl: new URL(appUrl),
    bindHost,
    paths: {
      configDirectory: testDirectory,
      dataDirectory: resolve('test-results/data'),
      databasePath: resolve('test-results/data/openrepurpose.sqlite'),
      sessionKeyPath: keyPath,
      temporaryDirectory: resolve('test-results/temp'),
    },
    port: 3000,
  };
}

describe('server startup security', () => {
  afterEach(() => rmSync(testDirectory, { recursive: true, force: true }));

  it('creates and reuses an exact-length session key', () => {
    const first = loadOrCreateSessionKey(keyPath);
    const second = loadOrCreateSessionKey(keyPath);
    expect(first).toHaveLength(32);
    expect(second).toEqual(first);
  });

  it('rejects malformed persisted session keys', () => {
    loadOrCreateSessionKey(keyPath);
    writeFileSync(keyPath, 'too-short');
    expect(() => loadOrCreateSessionKey(keyPath)).toThrow('exactly 32 bytes');
  });

  it('rejects LAN/public binding and public origins in this packet', () => {
    expect(() => assertLocalOnly(config('0.0.0.0'))).toThrow('not enabled in v0.1');
    expect(() => assertLocalOnly(config('127.0.0.1', 'https://repurpose.example.test'))).toThrow(
      'not enabled in v0.1',
    );
    expect(() => assertLocalOnly(config('127.0.0.1'))).not.toThrow();
  });
});
