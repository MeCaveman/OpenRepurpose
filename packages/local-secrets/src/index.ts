import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SecretReference, SecretStore } from '@openrepurpose/platform-sdk';
import { secretReferenceKey } from '@openrepurpose/platform-sdk';

interface SecretVaultDocument {
  readonly secrets: Record<string, string>;
  readonly version: 1;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function restrictPermissions(path: string): Promise<void> {
  try {
    await chmod(path, 0o600);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

function parseVault(raw: string): SecretVaultDocument {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error('The local secret vault is not valid JSON.');
  }
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    !('version' in candidate) ||
    candidate.version !== 1 ||
    !('secrets' in candidate) ||
    typeof candidate.secrets !== 'object' ||
    candidate.secrets === null ||
    Array.isArray(candidate.secrets) ||
    Object.values(candidate.secrets).some((value) => typeof value !== 'string')
  ) {
    throw new Error('The local secret vault has an unsupported format.');
  }
  return { version: 1, secrets: candidate.secrets as Record<string, string> };
}

/**
 * AES-256-GCM encrypted local SecretStore. The key and vault are separate files with restrictive
 * host permissions. This protects backups and casual inspection, not malware running as the user.
 */
export class EncryptedFileSecretStore implements SecretStore {
  private mutation = Promise.resolve();

  public constructor(
    private readonly vaultPath: string,
    private readonly keyPath: string,
  ) {}

  public async delete(reference: SecretReference): Promise<boolean> {
    return this.exclusive(async () => {
      const document = await this.readVault();
      const key = secretReferenceKey(reference);
      if (!(key in document.secrets)) return false;
      delete document.secrets[key];
      await this.writeVault(document);
      return true;
    });
  }

  public async get(reference: SecretReference): Promise<string | undefined> {
    await this.mutation;
    const document = await this.readVault();
    const referenceKey = secretReferenceKey(reference);
    const encrypted = document.secrets[referenceKey];
    if (encrypted === undefined) return undefined;
    return this.decrypt(encrypted, await this.loadOrCreateKey(), referenceKey);
  }

  public async set(reference: SecretReference, value: string): Promise<void> {
    if (value.length === 0) throw new Error('Secret values cannot be empty.');
    await this.exclusive(async () => {
      const document = await this.readVault();
      const referenceKey = secretReferenceKey(reference);
      document.secrets[referenceKey] = this.encrypt(
        value,
        await this.loadOrCreateKey(),
        referenceKey,
      );
      await this.writeVault(document);
    });
  }

  private decrypt(value: string, key: Buffer, referenceKey: string): string {
    const [version, encodedIv, encodedTag, encodedCiphertext, ...extra] = value.split('.');
    if (
      version !== 'v1' ||
      encodedIv === undefined ||
      encodedTag === undefined ||
      encodedCiphertext === undefined ||
      extra.length > 0
    ) {
      throw new Error('The local secret vault entry has an unsupported format.');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encodedIv, 'base64url'));
      decipher.setAAD(Buffer.from(referenceKey));
      decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('The local secret vault entry could not be decrypted.');
    }
  }

  private encrypt(value: string, key: Buffer, referenceKey: string): string {
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

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutation;
    let release: () => void = () => undefined;
    this.mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async loadOrCreateKey(): Promise<Buffer> {
    let key: Buffer;
    try {
      key = await readFile(this.keyPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      await mkdir(dirname(this.keyPath), { recursive: true });
      const generated = randomBytes(32);
      try {
        await writeFile(this.keyPath, generated, { flag: 'wx', mode: 0o600 });
        key = generated;
      } catch (writeError) {
        if (!isNodeError(writeError) || writeError.code !== 'EEXIST') throw writeError;
        key = await readFile(this.keyPath);
      }
    }
    if (key.length !== 32) throw new Error('The local secret-vault key must contain 32 bytes.');
    await restrictPermissions(this.keyPath);
    return key;
  }

  private async readVault(): Promise<SecretVaultDocument> {
    try {
      return parseVault(await readFile(this.vaultPath, 'utf8'));
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return { version: 1, secrets: {} };
      throw error;
    }
  }

  private async writeVault(document: SecretVaultDocument): Promise<void> {
    await mkdir(dirname(this.vaultPath), { recursive: true });
    const temporaryPath = `${this.vaultPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(document)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporaryPath, this.vaultPath);
      await restrictPermissions(this.vaultPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
