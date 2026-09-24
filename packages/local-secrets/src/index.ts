import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SecretReference, SecretStore } from '@openrepurpose/platform-sdk';
import { secretReferenceKey } from '@openrepurpose/platform-sdk';

interface LegacySecretVaultDocument {
  readonly secrets: Record<string, string>;
  readonly version: 1;
}

interface SecretVaultDocument {
  readonly format: 'openrepurpose-secret-vault';
  readonly keyId: string;
  readonly secrets: Record<string, string>;
  readonly version: 2;
}

type ParsedVault = LegacySecretVaultDocument | SecretVaultDocument;
type RecoveryReason = 'key_invalid' | 'key_missing' | 'vault_invalid' | 'vault_unreadable';

export type SecretVaultInspection =
  | { readonly kind: 'empty' }
  | { readonly kind: 'migration_required'; readonly secretCount: number; readonly version: 1 }
  | { readonly kind: 'ready'; readonly secretCount: number; readonly version: 2 }
  | { readonly kind: 'reconnect_required'; readonly reason: RecoveryReason };

export interface SecretVaultMigrationResult {
  readonly backupPath?: string;
  readonly migrated: boolean;
  readonly secretCount: number;
  readonly version: 2;
}

export interface SecretVaultRecoveryResult {
  readonly archivedKeyPath?: string;
  readonly archivedVaultPath?: string;
}

export class SecretVaultRecoveryRequiredError extends Error {
  public readonly code = 'SECRET_VAULT_RECONNECT_REQUIRED';

  public constructor(
    message: string,
    public readonly reason: RecoveryReason,
  ) {
    super(message);
    this.name = 'SecretVaultRecoveryRequiredError';
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function restrictPermissions(path: string): Promise<void> {
  try {
    await chmod(path, 0o600);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

function parseVault(raw: string): ParsedVault {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new SecretVaultRecoveryRequiredError(
      'The local secret vault is not valid JSON. Restore its original files or run `openrepurpose secrets recover --confirm-reconnect` to archive it and reconnect accounts.',
      'vault_invalid',
    );
  }
  if (typeof candidate !== 'object' || candidate === null || !('version' in candidate))
    throw new SecretVaultRecoveryRequiredError(
      'The local secret vault has an unsupported format. Restore its original files or archive it with the secrets recovery command before reconnecting accounts.',
      'vault_invalid',
    );
  if (
    (candidate.version === 1 || candidate.version === 2) &&
    'secrets' in candidate &&
    typeof candidate.secrets === 'object' &&
    candidate.secrets !== null &&
    !Array.isArray(candidate.secrets) &&
    Object.values(candidate.secrets).every((value) => typeof value === 'string')
  ) {
    if (candidate.version === 1)
      return { version: 1, secrets: candidate.secrets as Record<string, string> };
    if (
      'format' in candidate &&
      candidate.format === 'openrepurpose-secret-vault' &&
      'keyId' in candidate &&
      typeof candidate.keyId === 'string' &&
      /^[a-f0-9]{64}$/u.test(candidate.keyId)
    )
      return {
        format: 'openrepurpose-secret-vault',
        keyId: candidate.keyId,
        secrets: candidate.secrets as Record<string, string>,
        version: 2,
      };
  }
  throw new SecretVaultRecoveryRequiredError(
    'The local secret vault has an unsupported format. Restore its original files or archive it with the secrets recovery command before reconnecting accounts.',
    'vault_invalid',
  );
}

function keyId(key: Buffer): string {
  return createHash('sha256').update('openrepurpose-secret-vault-key\0').update(key).digest('hex');
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replaceAll(':', '-');
}

/**
 * Versioned AES-256-GCM local SecretStore for Windows, Linux desktop, and headless Linux. The
 * separate random key and vault files limit backup/casual disclosure; they do not protect against
 * malware or another process running with the same user authority.
 */
export class EncryptedFileSecretStore implements SecretStore {
  private initialization: Promise<SecretVaultMigrationResult> | undefined;
  private mutation = Promise.resolve();

  public constructor(
    private readonly vaultPath: string,
    private readonly keyPath: string,
  ) {}

  public async delete(reference: SecretReference): Promise<boolean> {
    return this.exclusive(async () => {
      const document = await this.readReadyVault();
      const key = secretReferenceKey(reference);
      if (!(key in document.secrets)) return false;
      delete document.secrets[key];
      await this.writeVault(document);
      return true;
    });
  }

  public async get(reference: SecretReference): Promise<string | undefined> {
    await this.mutation;
    const document = await this.readReadyVault();
    const referenceKey = secretReferenceKey(reference);
    const encrypted = document.secrets[referenceKey];
    if (encrypted === undefined) return undefined;
    return this.decrypt(encrypted, await this.loadExistingKey(), referenceKey, 2);
  }

  /** Validates the key/vault pair and atomically migrates the interim v0.x vault when needed. */
  public async initialize(): Promise<SecretVaultMigrationResult> {
    this.initialization ??= this.initializeOnce();
    return this.initialization;
  }

  /** Read-only status used by CLI diagnostics; it never creates keys or mutates the vault. */
  public async inspect(): Promise<SecretVaultInspection> {
    let raw: string;
    try {
      raw = await readFile(this.vaultPath, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return { kind: 'empty' };
      return { kind: 'reconnect_required', reason: 'vault_unreadable' };
    }
    let document: ParsedVault;
    try {
      document = parseVault(raw);
    } catch {
      return { kind: 'reconnect_required', reason: 'vault_invalid' };
    }
    let key: Buffer;
    try {
      key = await readFile(this.keyPath);
    } catch (error) {
      return {
        kind: 'reconnect_required',
        reason: isNodeError(error) && error.code === 'ENOENT' ? 'key_missing' : 'key_invalid',
      };
    }
    if (key.length !== 32 || (document.version === 2 && document.keyId !== keyId(key)))
      return { kind: 'reconnect_required', reason: 'key_invalid' };
    try {
      for (const [referenceKey, encrypted] of Object.entries(document.secrets))
        this.decrypt(encrypted, key, referenceKey, document.version);
    } catch {
      return { kind: 'reconnect_required', reason: 'key_invalid' };
    }
    return document.version === 1
      ? {
          kind: 'migration_required',
          secretCount: Object.keys(document.secrets).length,
          version: 1,
        }
      : { kind: 'ready', secretCount: Object.keys(document.secrets).length, version: 2 };
  }

  /** Archives unreadable material instead of deleting it. */
  public async recoverForReconnect(
    confirmation: 'archive-and-reconnect',
    now: Date = new Date(),
  ): Promise<SecretVaultRecoveryResult> {
    if (confirmation !== 'archive-and-reconnect')
      throw new Error('Reconnect confirmation is required.');
    await this.mutation;
    const suffix = `.recovery-${safeTimestamp(now)}-${randomBytes(4).toString('hex')}.bak`;
    const result: { archivedKeyPath?: string; archivedVaultPath?: string } = {};
    if (await pathExists(this.vaultPath)) {
      result.archivedVaultPath = `${this.vaultPath}${suffix}`;
      await rename(this.vaultPath, result.archivedVaultPath);
      await restrictPermissions(result.archivedVaultPath);
    }
    if (await pathExists(this.keyPath)) {
      result.archivedKeyPath = `${this.keyPath}${suffix}`;
      await rename(this.keyPath, result.archivedKeyPath);
      await restrictPermissions(result.archivedKeyPath);
    }
    this.initialization = undefined;
    return result;
  }

  public async set(reference: SecretReference, value: string): Promise<void> {
    if (value.length === 0) throw new Error('Secret values cannot be empty.');
    await this.exclusive(async () => {
      const document = await this.readReadyVault();
      const referenceKey = secretReferenceKey(reference);
      document.secrets[referenceKey] = this.encrypt(
        value,
        await this.loadOrCreateKey(),
        referenceKey,
      );
      await this.writeVault(document);
    });
  }

  private decrypt(
    value: string,
    key: Buffer,
    referenceKey: string,
    expectedVersion: 1 | 2,
  ): string {
    const [version, encodedIv, encodedTag, encodedCiphertext, ...extra] = value.split('.');
    if (
      version !== `v${expectedVersion}` ||
      encodedIv === undefined ||
      encodedTag === undefined ||
      encodedCiphertext === undefined ||
      extra.length > 0
    )
      throw new SecretVaultRecoveryRequiredError(
        'A local secret vault entry has an unsupported format. Restore the original key/vault pair or use the explicit reconnect recovery command.',
        'vault_invalid',
      );
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encodedIv, 'base64url'));
      decipher.setAAD(
        Buffer.from(expectedVersion === 1 ? referenceKey : `openrepurpose:v2:${referenceKey}`),
      );
      decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch (error) {
      if (error instanceof SecretVaultRecoveryRequiredError) throw error;
      throw new SecretVaultRecoveryRequiredError(
        'The local secret vault cannot be decrypted with its configured key. The files were left untouched; restore the matching key or archive them with the reconnect recovery command.',
        'key_invalid',
      );
    }
  }

  private encrypt(value: string, key: Buffer, referenceKey: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`openrepurpose:v2:${referenceKey}`));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [
      'v2',
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

  private async initializeOnce(): Promise<SecretVaultMigrationResult> {
    let raw: string;
    try {
      raw = await readFile(this.vaultPath, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT')
        return { migrated: false, secretCount: 0, version: 2 };
      throw error;
    }
    const document = parseVault(raw);
    const key = await this.loadExistingKey();
    if (document.version === 2) {
      if (document.keyId !== keyId(key))
        throw new SecretVaultRecoveryRequiredError(
          'The local secret vault key does not match the vault. The files were left untouched; restore the matching key or use explicit reconnect recovery.',
          'key_invalid',
        );
      for (const [referenceKey, encrypted] of Object.entries(document.secrets))
        this.decrypt(encrypted, key, referenceKey, 2);
      return { migrated: false, secretCount: Object.keys(document.secrets).length, version: 2 };
    }
    const plaintext = Object.entries(document.secrets).map(
      ([referenceKey, encrypted]) =>
        [referenceKey, this.decrypt(encrypted, key, referenceKey, 1)] as const,
    );
    const backupPath = `${this.vaultPath}.v1.backup`;
    try {
      await copyFile(this.vaultPath, backupPath, constants.COPYFILE_EXCL);
      await restrictPermissions(backupPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      const existing = await readFile(backupPath, 'utf8');
      if (existing !== raw)
        throw new Error(
          `Legacy vault backup already exists with different contents: ${backupPath}`,
          { cause: error },
        );
    }
    const migrated: SecretVaultDocument = {
      format: 'openrepurpose-secret-vault',
      keyId: keyId(key),
      secrets: Object.fromEntries(
        plaintext.map(([referenceKey, value]) => [
          referenceKey,
          this.encrypt(value, key, referenceKey),
        ]),
      ),
      version: 2,
    };
    await this.writeVault(migrated);
    return { backupPath, migrated: true, secretCount: plaintext.length, version: 2 };
  }

  private async loadExistingKey(): Promise<Buffer> {
    let key: Buffer;
    try {
      key = await readFile(this.keyPath);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT')
        throw new SecretVaultRecoveryRequiredError(
          'The local secret vault exists but its key is missing. No replacement key was created. Restore the matching key or run `openrepurpose secrets recover --confirm-reconnect` to archive the vault and reconnect accounts.',
          'key_missing',
        );
      throw error;
    }
    if (key.length !== 32)
      throw new SecretVaultRecoveryRequiredError(
        'The local secret-vault key is invalid. Restore the matching 32-byte key or use explicit reconnect recovery.',
        'key_invalid',
      );
    await restrictPermissions(this.keyPath);
    return key;
  }

  private async loadOrCreateKey(): Promise<Buffer> {
    if (await pathExists(this.vaultPath)) return this.loadExistingKey();
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
    if (key.length !== 32)
      throw new SecretVaultRecoveryRequiredError(
        'The local secret-vault key is invalid. Archive it with the reconnect recovery command before creating new secrets.',
        'key_invalid',
      );
    await restrictPermissions(this.keyPath);
    return key;
  }

  private async readReadyVault(): Promise<SecretVaultDocument> {
    await this.initialize();
    try {
      const document = parseVault(await readFile(this.vaultPath, 'utf8'));
      if (document.version !== 2)
        throw new Error('The local secret vault migration did not complete.');
      return document;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        const key = await this.loadOrCreateKey();
        return {
          format: 'openrepurpose-secret-vault',
          keyId: keyId(key),
          secrets: {},
          version: 2,
        };
      }
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
