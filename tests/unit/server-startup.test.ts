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
    jobRunner: {
      accountConcurrency: 1,
      authFailureThreshold: 3,
      baseRetryDelayMs: 1_000,
      concurrency: 2,
      leaseDurationMs: 30_000,
      maxRetryDelayMs: 60_000,
      pollIntervalMs: 250,
      platformConcurrency: 2,
    },
    transformRunner: {
      killGraceMs: 5_000,
      stallTimeoutMs: 300_000,
      timeoutMs: 21_600_000,
    },
    paths: {
      configDirectory: testDirectory,
      dataDirectory: resolve('test-results/data'),
      databasePath: resolve('test-results/data/openrepurpose.sqlite'),
      secretKeyPath: resolve(testDirectory, 'secret-vault.key'),
      secretVaultPath: resolve('test-results/data/secrets.vault.json'),
      sessionKeyPath: keyPath,
      temporaryDirectory: resolve('test-results/temp'),
      transcriptionModelDirectory: resolve('test-results/data/models/whisper-cpp'),
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

  it('fails closed for LAN binding until explicit authentication is configured', () => {
    expect(() => assertLocalOnly(config('0.0.0.0'))).toThrow('requires LAN_ENABLED=true');
    const lan = {
      ...config('0.0.0.0', 'https://repurpose.example.test'),
      network: { lanEnabled: true, lanAccessToken: 'a'.repeat(32), trustedProxy: false },
    };
    expect(() => assertLocalOnly(lan)).not.toThrow();
    expect(() => assertLocalOnly(config('127.0.0.1'))).not.toThrow();
  });
});
