import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const DEFAULT_DISK_RESERVE_BYTES = 256 * 1024 * 1024;

export interface ModelChecksum {
  readonly algorithm: 'sha1';
  readonly value: string;
}

export interface WhisperModelCatalogEntry {
  readonly checksum: ModelChecksum;
  readonly description: string;
  readonly displayName: string;
  readonly id: string;
  readonly languageSupport: 'english' | 'multilingual';
  readonly performance: 'fastest' | 'fast' | 'balanced' | 'accurate' | 'most-accurate';
  readonly sizeBytes: number;
  readonly sourceUrl: string;
  readonly version: string;
}

export type ModelInstallStatus = 'not-installed' | 'installed' | 'downloading' | 'failed';
export type ModelIntegrityStatus = 'not-installed' | 'unverified' | 'verified' | 'failed';

export interface ModelDownloadProgress {
  readonly downloadedBytes: number;
  readonly percent?: number;
  readonly totalBytes: number;
}

export interface WhisperModelView extends WhisperModelCatalogEntry {
  readonly diskRequiredBytes: number;
  readonly diskWarning: boolean;
  readonly error?: string;
  readonly installedAt?: string;
  readonly installedBytes?: number;
  readonly integrity: ModelIntegrityStatus;
  readonly progress?: ModelDownloadProgress;
  readonly status: ModelInstallStatus;
}

export interface WhisperModelManagerView {
  readonly availableBytes?: number;
  readonly models: readonly WhisperModelView[];
  readonly reserveBytes: number;
  readonly storagePath: string;
}

export interface ModelDownloadOptions {
  readonly onProgress?: (progress: ModelDownloadProgress) => void;
  readonly signal?: AbortSignal;
}

export interface TranscriptionModelManager {
  delete(id: string): Promise<WhisperModelView>;
  download(id: string, options?: ModelDownloadOptions): Promise<WhisperModelView>;
  list(): Promise<WhisperModelManagerView>;
  startDownload(id: string): Promise<WhisperModelView>;
  verify(id: string): Promise<WhisperModelView>;
}

export type ModelManagerErrorCode =
  | 'MODEL_ALREADY_DOWNLOADING'
  | 'MODEL_CHECKSUM_MISMATCH'
  | 'MODEL_DISK_SPACE_LOW'
  | 'MODEL_DOWNLOAD_FAILED'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_NOT_INSTALLED'
  | 'MODEL_STORAGE_UNSAFE';

export class ModelManagerError extends Error {
  public constructor(
    public readonly code: ModelManagerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelManagerError';
  }
}

/**
 * Curated from whisper.cpp's official model table. The version key is content-addressed because
 * upstream model files do not have independent semantic releases.
 */
export const WHISPER_CPP_MODEL_CATALOG: readonly WhisperModelCatalogEntry[] = [
  {
    id: 'tiny.en',
    displayName: 'Tiny · English',
    description: 'Lowest storage and quickest CPU runs for English-only drafts.',
    languageSupport: 'english',
    performance: 'fastest',
    sizeBytes: 75 * 1024 * 1024,
    checksum: { algorithm: 'sha1', value: 'c78c86eb1a8faa21b369bcd33207cc90d64ae9df' },
    sourceUrl: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
    version: 'sha1-c78c86eb1a8f',
  },
  {
    id: 'tiny',
    displayName: 'Tiny · Multilingual',
    description: 'Fastest multilingual option when turnaround matters more than detail.',
    languageSupport: 'multilingual',
    performance: 'fastest',
    sizeBytes: 75 * 1024 * 1024,
    checksum: { algorithm: 'sha1', value: 'bd577a113a864445d4c299885e0cb97d4ba92b5f' },
    sourceUrl: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
    version: 'sha1-bd577a113a86',
  },
  {
    id: 'base.en',
    displayName: 'Base · English',
    description: 'A compact English model with a practical speed and accuracy balance.',
    languageSupport: 'english',
    performance: 'fast',
    sizeBytes: 142 * 1024 * 1024,
    checksum: { algorithm: 'sha1', value: '137c40403d78fd54d454da0f9bd998f78703390c' },
    sourceUrl: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
    version: 'sha1-137c40403d78',
  },
  {
    id: 'base',
    displayName: 'Base · Multilingual',
    description: 'Recommended starting point for multilingual local transcription.',
    languageSupport: 'multilingual',
    performance: 'fast',
    sizeBytes: 142 * 1024 * 1024,
    checksum: { algorithm: 'sha1', value: '465707469ff3a37a2b9b8d8f89f2f99de7299dac' },
    sourceUrl: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    version: 'sha1-465707469ff3',
  },
  {
    id: 'small',
    displayName: 'Small · Multilingual',
    description: 'Higher accuracy for everyday creator work with moderate CPU and disk cost.',
    languageSupport: 'multilingual',
    performance: 'balanced',
    sizeBytes: 466 * 1024 * 1024,
    checksum: { algorithm: 'sha1', value: '55356645c2b361a969dfd0ef2c5a50d530afd8d5' },
    sourceUrl: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    version: 'sha1-55356645c2b3',
  },
  {
    id: 'large-v3-turbo-q5_0',
    displayName: 'Large v3 Turbo · Quantized',
    description: 'Strong multilingual accuracy with a compressed footprint and faster inference.',
    languageSupport: 'multilingual',
    performance: 'accurate',
    sizeBytes: 547 * 1024 * 1024,
    checksum: { algorithm: 'sha1', value: 'e050f7970618a659205450ad97eb95a18d69c9ee' },
    sourceUrl:
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    version: 'sha1-e050f7970618',
  },
  {
    id: 'medium',
    displayName: 'Medium · Multilingual',
    description: 'Accuracy-first multilingual model for capable machines and longer waits.',
    languageSupport: 'multilingual',
    performance: 'most-accurate',
    sizeBytes: Math.round(1.5 * 1024 * 1024 * 1024),
    checksum: { algorithm: 'sha1', value: 'fd9727b6e1217c2f614f9b698455c4ffd82463b4' },
    sourceUrl: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
    version: 'sha1-fd9727b6e121',
  },
];

interface InstalledModelManifest {
  readonly checksum: ModelChecksum;
  readonly id: string;
  readonly installedAt: string;
  readonly sizeBytes: number;
  readonly sourceUrl: string;
  readonly version: string;
}

interface MutableDownloadState {
  downloadedBytes: number;
  error?: string;
  status: 'downloading' | 'failed';
  totalBytes: number;
}

export interface LocalWhisperModelManagerOptions {
  readonly diskReserveBytes?: number;
  readonly fetcher?: typeof fetch;
  readonly freeSpace?: (path: string) => Promise<number | undefined>;
  readonly now?: () => Date;
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot.length > 0 && !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
}

function pathSegment(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value))
    throw new ModelManagerError('MODEL_STORAGE_UNSAFE', 'Model metadata contains an unsafe path.');
  return value;
}

function missingFile(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

async function defaultFreeSpace(path: string): Promise<number | undefined> {
  try {
    const details = await statfs(path);
    return details.bavail * details.bsize;
  } catch {
    return undefined;
  }
}

async function sha1(path: string): Promise<string> {
  return new Promise((resolveChecksum, rejectChecksum) => {
    const hash = createHash('sha1');
    const stream = createReadStream(path);
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk));
    stream.once('error', rejectChecksum);
    stream.once('end', () => resolveChecksum(hash.digest('hex')));
  });
}

function publicFailure(error: unknown): string {
  if (error instanceof ModelManagerError) return error.message;
  return 'The model download failed. Check the local connection and try again.';
}

/** Local, atomic whisper.cpp model storage and user-initiated transfer service. */
export class LocalWhisperModelManager implements TranscriptionModelManager {
  private readonly active = new Map<string, Promise<WhisperModelView>>();
  private readonly catalogById: ReadonlyMap<string, WhisperModelCatalogEntry>;
  private readonly diskReserveBytes: number;
  private readonly downloadState = new Map<string, MutableDownloadState>();
  private readonly fetcher: typeof fetch;
  private readonly freeSpace: (path: string) => Promise<number | undefined>;
  private readonly now: () => Date;
  public readonly root: string;

  public constructor(
    catalog: readonly WhisperModelCatalogEntry[],
    root: string,
    options: LocalWhisperModelManagerOptions = {},
  ) {
    if (!isAbsolute(root)) throw new Error('The transcription model directory must be absolute.');
    this.root = resolve(root);
    this.catalogById = new Map(
      catalog.map((entry) => {
        pathSegment(entry.id);
        pathSegment(entry.version);
        if (entry.sizeBytes <= 0 || !Number.isSafeInteger(entry.sizeBytes))
          throw new Error(`Model ${entry.id} has an invalid size.`);
        return [entry.id, entry] as const;
      }),
    );
    if (this.catalogById.size !== catalog.length) throw new Error('Duplicate model catalog ID.');
    this.diskReserveBytes = options.diskReserveBytes ?? DEFAULT_DISK_RESERVE_BYTES;
    this.fetcher = options.fetcher ?? fetch;
    this.freeSpace = options.freeSpace ?? defaultFreeSpace;
    this.now = options.now ?? (() => new Date());
  }

  public async list(): Promise<WhisperModelManagerView> {
    await this.prepareRoot();
    const availableBytes = await this.freeSpace(this.root);
    return {
      ...(availableBytes === undefined ? {} : { availableBytes }),
      models: await Promise.all(
        [...this.catalogById.values()].map((entry) => this.view(entry, availableBytes)),
      ),
      reserveBytes: this.diskReserveBytes,
      storagePath: this.root,
    };
  }

  public async startDownload(id: string): Promise<WhisperModelView> {
    const entry = this.requireEntry(id);
    const task = this.download(entry.id);
    void task.catch(() => undefined);
    return this.view(entry, await this.freeSpaceAfterPrepare());
  }

  public async download(id: string, options: ModelDownloadOptions = {}): Promise<WhisperModelView> {
    const entry = this.requireEntry(id);
    const existing = this.active.get(entry.id);
    if (existing !== undefined) return existing;
    this.downloadState.set(entry.id, {
      downloadedBytes: 0,
      status: 'downloading',
      totalBytes: entry.sizeBytes,
    });
    const task = this.performDownload(entry, options)
      .catch((error: unknown) => {
        this.downloadState.set(entry.id, {
          downloadedBytes: this.downloadState.get(entry.id)?.downloadedBytes ?? 0,
          error: publicFailure(error),
          status: 'failed',
          totalBytes: this.downloadState.get(entry.id)?.totalBytes ?? entry.sizeBytes,
        });
        throw error;
      })
      .finally(() => this.active.delete(entry.id));
    this.active.set(entry.id, task);
    return task;
  }

  public async verify(id: string): Promise<WhisperModelView> {
    const entry = this.requireEntry(id);
    const modelPath = this.modelPath(entry);
    if (!(await this.regularFile(modelPath)))
      throw new ModelManagerError('MODEL_NOT_INSTALLED', `${entry.displayName} is not installed.`);
    const actual = await sha1(modelPath);
    if (actual !== entry.checksum.value) {
      this.downloadState.set(entry.id, {
        downloadedBytes: 0,
        error: 'The installed file does not match the published checksum.',
        status: 'failed',
        totalBytes: entry.sizeBytes,
      });
      throw new ModelManagerError(
        'MODEL_CHECKSUM_MISMATCH',
        `${entry.displayName} failed checksum verification.`,
      );
    }
    const details = await lstat(modelPath);
    await this.writeManifest(entry, details.size);
    this.downloadState.delete(entry.id);
    return this.view(entry, await this.freeSpaceAfterPrepare());
  }

  public async delete(id: string): Promise<WhisperModelView> {
    const entry = this.requireEntry(id);
    if (this.active.has(entry.id))
      throw new ModelManagerError(
        'MODEL_ALREADY_DOWNLOADING',
        `${entry.displayName} cannot be deleted while it is downloading.`,
      );
    const directory = this.versionDirectory(entry);
    try {
      const details = await lstat(directory);
      if (details.isSymbolicLink())
        throw new ModelManagerError(
          'MODEL_STORAGE_UNSAFE',
          'Refusing to delete a symbolic link from managed model storage.',
        );
      await rm(directory, { force: true, recursive: true });
    } catch (error) {
      if (!missingFile(error)) throw error;
    }
    this.downloadState.delete(entry.id);
    return this.view(entry, await this.freeSpaceAfterPrepare());
  }

  private requireEntry(id: string): WhisperModelCatalogEntry {
    const entry = this.catalogById.get(id);
    if (entry === undefined)
      throw new ModelManagerError('MODEL_NOT_FOUND', `Unknown transcription model: ${id}`);
    return entry;
  }

  private versionDirectory(entry: WhisperModelCatalogEntry): string {
    const directory = resolve(this.root, pathSegment(entry.id), pathSegment(entry.version));
    if (!isInside(this.root, directory))
      throw new ModelManagerError('MODEL_STORAGE_UNSAFE', 'Model path escaped managed storage.');
    return directory;
  }

  private modelPath(entry: WhisperModelCatalogEntry): string {
    return resolve(this.versionDirectory(entry), 'ggml-model.bin');
  }

  private manifestPath(entry: WhisperModelCatalogEntry): string {
    return resolve(this.versionDirectory(entry), 'model.json');
  }

  private async prepareRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const details = await lstat(this.root);
    if (!details.isDirectory() || details.isSymbolicLink())
      throw new ModelManagerError(
        'MODEL_STORAGE_UNSAFE',
        'The transcription model storage path must be a real directory.',
      );
  }

  private async freeSpaceAfterPrepare(): Promise<number | undefined> {
    await this.prepareRoot();
    return this.freeSpace(this.root);
  }

  private async regularFile(path: string): Promise<boolean> {
    try {
      const details = await lstat(path);
      return details.isFile() && !details.isSymbolicLink() && details.size > 0;
    } catch (error) {
      if (missingFile(error)) return false;
      throw error;
    }
  }

  private async readManifest(
    entry: WhisperModelCatalogEntry,
  ): Promise<InstalledModelManifest | undefined> {
    try {
      const value = JSON.parse(await readFile(this.manifestPath(entry), 'utf8')) as unknown;
      if (typeof value !== 'object' || value === null) return undefined;
      const manifest = value as Partial<InstalledModelManifest>;
      if (
        manifest.id !== entry.id ||
        manifest.version !== entry.version ||
        manifest.checksum?.algorithm !== entry.checksum.algorithm ||
        manifest.checksum.value !== entry.checksum.value ||
        typeof manifest.installedAt !== 'string' ||
        typeof manifest.sizeBytes !== 'number' ||
        manifest.sourceUrl !== entry.sourceUrl
      )
        return undefined;
      return manifest as InstalledModelManifest;
    } catch (error) {
      if (missingFile(error) || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  private async view(
    entry: WhisperModelCatalogEntry,
    availableBytes: number | undefined,
  ): Promise<WhisperModelView> {
    const modelPath = this.modelPath(entry);
    const installed = await this.regularFile(modelPath);
    const details = installed ? await lstat(modelPath) : undefined;
    const manifest = installed ? await this.readManifest(entry) : undefined;
    const transfer = this.downloadState.get(entry.id);
    const diskRequiredBytes = entry.sizeBytes + this.diskReserveBytes;
    const base = {
      ...entry,
      diskRequiredBytes,
      diskWarning: availableBytes !== undefined && availableBytes < diskRequiredBytes,
    };
    if (transfer?.status === 'downloading') {
      const percent =
        transfer.totalBytes > 0
          ? Math.min(100, (transfer.downloadedBytes / transfer.totalBytes) * 100)
          : undefined;
      return {
        ...base,
        status: 'downloading',
        integrity: 'not-installed',
        progress: {
          downloadedBytes: transfer.downloadedBytes,
          ...(percent === undefined ? {} : { percent }),
          totalBytes: transfer.totalBytes,
        },
      };
    }
    if (installed && details !== undefined)
      return {
        ...base,
        status: 'installed',
        integrity:
          manifest !== undefined && manifest.sizeBytes === details.size ? 'verified' : 'unverified',
        installedBytes: details.size,
        ...(manifest === undefined ? {} : { installedAt: manifest.installedAt }),
      };
    if (transfer?.status === 'failed')
      return {
        ...base,
        status: 'failed',
        integrity: 'failed',
        ...(transfer.error === undefined ? {} : { error: transfer.error }),
      };
    return { ...base, status: 'not-installed', integrity: 'not-installed' };
  }

  private async performDownload(
    entry: WhisperModelCatalogEntry,
    options: ModelDownloadOptions,
  ): Promise<WhisperModelView> {
    await this.prepareRoot();
    const availableBytes = await this.freeSpace(this.root);
    const requiredBytes = entry.sizeBytes + this.diskReserveBytes;
    if (availableBytes !== undefined && availableBytes < requiredBytes)
      throw new ModelManagerError(
        'MODEL_DISK_SPACE_LOW',
        `${entry.displayName} needs more free disk space before downloading.`,
      );

    const directory = this.versionDirectory(entry);
    await mkdir(directory, { recursive: true });
    const directoryDetails = await lstat(directory);
    if (!directoryDetails.isDirectory() || directoryDetails.isSymbolicLink())
      throw new ModelManagerError('MODEL_STORAGE_UNSAFE', 'Model directory is unsafe.');
    const target = this.modelPath(entry);
    if (await this.regularFile(target)) {
      const actual = await sha1(target);
      if (actual === entry.checksum.value) {
        const details = await lstat(target);
        await this.writeManifest(entry, details.size);
        this.downloadState.delete(entry.id);
        return this.view(entry, await this.freeSpace(this.root));
      }
      await rm(target, { force: true });
      await rm(this.manifestPath(entry), { force: true });
    }

    const partial = resolve(directory, `.download-${randomUUID()}.partial`);
    this.downloadState.set(entry.id, {
      downloadedBytes: 0,
      status: 'downloading',
      totalBytes: entry.sizeBytes,
    });
    try {
      const response = await this.fetcher(entry.sourceUrl, {
        redirect: 'follow',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!response.ok || response.body === null)
        throw new ModelManagerError(
          'MODEL_DOWNLOAD_FAILED',
          `${entry.displayName} could not be downloaded from the published source.`,
        );
      const contentLength = Number(response.headers.get('content-length'));
      const totalBytes =
        Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : entry.sizeBytes;
      const state = this.downloadState.get(entry.id)!;
      state.totalBytes = totalBytes;
      const hash = createHash(entry.checksum.algorithm);
      const file = await open(partial, 'wx');
      try {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (options.signal?.aborted === true) throw options.signal.reason;
          await file.write(value);
          hash.update(value);
          state.downloadedBytes += value.byteLength;
          const progress: ModelDownloadProgress = {
            downloadedBytes: state.downloadedBytes,
            percent: Math.min(100, (state.downloadedBytes / totalBytes) * 100),
            totalBytes,
          };
          options.onProgress?.(progress);
        }
      } finally {
        await file.close();
      }
      if (hash.digest('hex') !== entry.checksum.value)
        throw new ModelManagerError(
          'MODEL_CHECKSUM_MISMATCH',
          `${entry.displayName} did not match the published checksum. The downloaded bytes were removed.`,
        );
      await rename(partial, target);
      const details = await lstat(target);
      await this.writeManifest(entry, details.size);
      this.downloadState.delete(entry.id);
      return this.view(entry, await this.freeSpace(this.root));
    } finally {
      await rm(partial, { force: true });
    }
  }

  private async writeManifest(entry: WhisperModelCatalogEntry, sizeBytes: number): Promise<void> {
    const manifest: InstalledModelManifest = {
      checksum: entry.checksum,
      id: entry.id,
      installedAt: this.now().toISOString(),
      sizeBytes,
      sourceUrl: entry.sourceUrl,
      version: entry.version,
    };
    const path = this.manifestPath(entry);
    await mkdir(dirname(path), { recursive: true });
    const temporary = resolve(dirname(path), `.model-${randomUUID()}.json`);
    try {
      await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
