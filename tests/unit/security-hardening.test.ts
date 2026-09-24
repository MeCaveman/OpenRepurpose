import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteOAuthAuthorizationRequestRepository } from '@openrepurpose/db';
import { LocalManagedTemporaryStorage, LocalTransformOutputStorage } from '@openrepurpose/media';
import { createTemporaryDatabase, type TemporaryDatabase } from '@openrepurpose/testkit';

describe('v1.0 security hardening', () => {
  let temporary: TemporaryDatabase | undefined;

  afterEach(() => {
    temporary?.dispose();
    temporary = undefined;
  });

  it('scopes one-time OAuth state consumption to the callback provider', () => {
    temporary = createTemporaryDatabase();
    const requests = new SqliteOAuthAuthorizationRequestRepository(temporary.database);
    requests.create({
      bindingHash: 'binding-hash',
      createdAt: new Date(0),
      expiresAt: new Date(60_000),
      id: 'oauth-request-1',
      provider: 'youtube',
      redirectUri: 'http://127.0.0.1:3000/api/oauth/youtube/callback',
      stateHash: 'state-hash',
    });

    expect(requests.consumeByStateHash('tiktok', 'state-hash', 'binding-hash')).toBeUndefined();
    expect(requests.consumeByStateHash('youtube', 'state-hash', 'binding-hash')?.id).toBe(
      'oauth-request-1',
    );
    expect(requests.consumeByStateHash('youtube', 'state-hash', 'binding-hash')).toBeUndefined();
  });

  it.each(['CON', 'nul.txt', 'COM1', 'clip.'])(
    'rejects cross-platform unsafe managed path segment %s',
    async (segment) => {
      const directory = resolve('test-results/security-managed-paths');
      await expect(new LocalManagedTemporaryStorage(directory).prepare(segment)).rejects.toThrow(
        'safe identifier',
      );
      await expect(new LocalTransformOutputStorage(directory).prepare(segment, 1)).rejects.toThrow(
        'safe identifier',
      );
    },
  );

  it('pins every CI action to an immutable commit with least-privilege permissions', () => {
    const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
    const actionReferences = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gmu)].map(
      (match) => match[1]!,
    );
    expect(actionReferences.length).toBeGreaterThan(0);
    expect(actionReferences.every((reference) => /@[a-f0-9]{40}$/u.test(reference))).toBe(true);
    expect(workflow).toMatch(/permissions:\s*\r?\n\s+contents:\s+read/u);
  });

  it('keeps every production child process on argument arrays with shell execution disabled', () => {
    for (const path of [
      'packages/media/src/index.ts',
      'packages/media/src/transform-runner.ts',
      'packages/media/src/whisper-cpp.ts',
    ]) {
      const source = readFileSync(resolve(path), 'utf8');
      const spawnCount = source.match(/\bspawn\(/gu)?.length ?? 0;
      const disabledShellCount = source.match(/shell:\s*false/gu)?.length ?? 0;
      expect(spawnCount, path).toBeGreaterThan(0);
      expect(disabledShellCount, path).toBe(spawnCount);
      expect(source, path).not.toMatch(/shell:\s*true/gu);
    }
  });
});
