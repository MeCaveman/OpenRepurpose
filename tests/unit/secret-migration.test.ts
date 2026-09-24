import { createCipheriv, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EncryptedFileSecretStore,
  SecretVaultRecoveryRequiredError,
} from '@openrepurpose/local-secrets';
import { secretReferenceKey, type SecretReference } from '@openrepurpose/platform-sdk';

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'openrepurpose-secret-migration-'));
  directories.push(directory);
  return directory;
}

function legacyCiphertext(value: string, key: Buffer, referenceKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(referenceKey));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

describe('v1.0 secret-vault migration', () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('verifies every legacy entry, archives the v0.x vault, and migrates atomically', async () => {
    const directory = await temporaryDirectory();
    const keyPath = join(directory, 'config', 'secret-vault.key');
    const vaultPath = join(directory, 'data', 'secrets.vault.json');
    const key = randomBytes(32);
    const reference: SecretReference = {
      name: 'refresh-token',
      ownerId: 'account-1',
      scope: 'account',
    };
    const referenceKey = secretReferenceKey(reference);
    await mkdir(join(directory, 'config'), { recursive: true });
    await writeFile(keyPath, key);
    await mkdir(join(directory, 'data'), { recursive: true });
    const legacy = JSON.stringify({
      version: 1,
      secrets: { [referenceKey]: legacyCiphertext('legacy-refresh-token', key, referenceKey) },
    });
    await writeFile(vaultPath, `${legacy}\n`);

    const store = new EncryptedFileSecretStore(vaultPath, keyPath);
    expect(await store.inspect()).toMatchObject({ kind: 'migration_required', secretCount: 1 });
    const result = await store.initialize();

    expect(result).toMatchObject({ migrated: true, secretCount: 1, version: 2 });
    expect(await readFile(result.backupPath!, 'utf8')).toBe(`${legacy}\n`);
    expect(await store.get(reference)).toBe('legacy-refresh-token');
    expect(JSON.parse(await readFile(vaultPath, 'utf8'))).toMatchObject({
      format: 'openrepurpose-secret-vault',
      version: 2,
    });
    expect(await readFile(vaultPath, 'utf8')).not.toContain('legacy-refresh-token');
  });

  it('does not create a replacement key when an existing vault key is missing', async () => {
    const directory = await temporaryDirectory();
    const keyPath = join(directory, 'secret-vault.key');
    const vaultPath = join(directory, 'secrets.vault.json');
    await writeFile(vaultPath, `${JSON.stringify({ version: 1, secrets: {} })}\n`);
    const store = new EncryptedFileSecretStore(vaultPath, keyPath);

    await expect(store.initialize()).rejects.toBeInstanceOf(SecretVaultRecoveryRequiredError);
    expect(existsSync(keyPath)).toBe(false);
    expect(await store.inspect()).toEqual({ kind: 'reconnect_required', reason: 'key_missing' });

    const recovered = await store.recoverForReconnect(
      'archive-and-reconnect',
      new Date('2026-09-24T10:00:00.000Z'),
    );
    expect(recovered.archivedVaultPath).toBeDefined();
    expect(existsSync(recovered.archivedVaultPath!)).toBe(true);
    expect(existsSync(vaultPath)).toBe(false);
  });

  it('leaves the legacy vault untouched when any entry cannot be decrypted', async () => {
    const directory = await temporaryDirectory();
    const keyPath = join(directory, 'secret-vault.key');
    const vaultPath = join(directory, 'secrets.vault.json');
    await writeFile(keyPath, randomBytes(32));
    const legacy = `${JSON.stringify({ version: 1, secrets: { broken: 'v1.invalid.entry.value' } })}\n`;
    await writeFile(vaultPath, legacy);

    await expect(
      new EncryptedFileSecretStore(vaultPath, keyPath).initialize(),
    ).rejects.toBeInstanceOf(SecretVaultRecoveryRequiredError);
    expect(await readFile(vaultPath, 'utf8')).toBe(legacy);
    expect(existsSync(`${vaultPath}.v1.backup`)).toBe(false);
  });
});
