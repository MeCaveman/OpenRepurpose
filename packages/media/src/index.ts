import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdir, realpath, rename, rm } from 'node:fs/promises';
import { readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type {
  LocalFileInspector,
  ManagedTemporaryPath,
  ManagedTemporaryStorage,
  MediaProbe,
  MediaProbeMetadata,
  SourceCursorRepository,
  WorkflowService,
} from '@openrepurpose/core';
import type { MediaImportService } from '@openrepurpose/core';

function isPathInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot.length > 0 && !pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot);
}

function safeScopeId(value: string): string {
  if (value === '.' || value === '..' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value))
    throw new Error('A managed temporary scope must be a safe identifier.');
  return value;
}

function safeExtension(value: string | undefined): string {
  if (value === undefined || value === '') return '.bin';
  const extension = value.startsWith('.') ? value : `.${value}`;
  if (!/^\.[a-zA-Z0-9]{1,10}$/.test(extension))
    throw new Error('A managed media extension must contain only letters and numbers.');
  return extension.toLowerCase();
}

/** Job/execution-scoped storage rooted at `<dataDirectory>/storage/temp`. */
export class LocalManagedTemporaryStorage implements ManagedTemporaryStorage {
  public readonly root: string;

  public constructor(dataDirectory: string) {
    if (!isAbsolute(dataDirectory))
      throw new Error('The application data directory must be absolute.');
    this.root = resolve(dataDirectory, 'storage', 'temp');
  }

  public async prepare(jobScopeId: string, extension?: string): Promise<ManagedTemporaryPath> {
    const scopeDirectory = resolve(this.root, safeScopeId(jobScopeId));
    if (!isPathInside(this.root, scopeDirectory))
      throw new Error('Managed temporary path escaped its root.');
    await mkdir(this.root, { recursive: true });
    await mkdir(scopeDirectory, { recursive: true });
    await this.assertCanonicalDirectory(scopeDirectory);
    const finalPath = resolve(scopeDirectory, `source${safeExtension(extension)}`);
    this.assertManaged(finalPath);
    return { finalPath, partialPath: `${finalPath}.partial` };
  }

  public async isUsableFile(path: string): Promise<boolean> {
    this.assertManaged(path);
    try {
      await this.assertCanonicalDirectory(dirname(path));
      const details = await lstat(path);
      return details.isFile() && !details.isSymbolicLink() && details.size > 0;
    } catch (error) {
      if (isMissingFileError(error)) return false;
      throw error;
    }
  }

  public async finalize(paths: ManagedTemporaryPath): Promise<string> {
    this.assertManaged(paths.partialPath);
    this.assertManaged(paths.finalPath);
    await this.assertCanonicalDirectory(dirname(paths.partialPath));
    const details = await lstat(paths.partialPath);
    if (!details.isFile() || details.isSymbolicLink() || details.size <= 0)
      throw new Error('Resolver output must be a non-empty regular file.');
    await rename(paths.partialPath, paths.finalPath);
    return paths.finalPath;
  }

  public async discard(paths: ManagedTemporaryPath): Promise<void> {
    this.assertManaged(paths.partialPath);
    this.assertManaged(paths.finalPath);
    await Promise.all([
      rm(paths.partialPath, { force: true, recursive: true }),
      rm(paths.finalPath, { force: true, recursive: true }),
    ]);
  }

  public async cleanup(path: string): Promise<'deleted' | 'missing'> {
    const managedPath = this.assertManaged(path);
    let details: Awaited<ReturnType<typeof lstat>>;
    try {
      details = await lstat(managedPath);
    } catch (error) {
      if (isMissingFileError(error)) return 'missing';
      throw error;
    }
    if (details.isSymbolicLink())
      throw new Error('Refusing to clean a symbolic link in managed temporary storage.');
    await this.assertCanonicalDirectory(dirname(managedPath));
    const canonicalPath = await realpath(managedPath);
    const canonicalRoot = await realpath(this.root);
    if (!isPathInside(canonicalRoot, canonicalPath))
      throw new Error('Refusing to access a path outside managed temporary storage.');
    await rm(managedPath, { recursive: true, force: true });
    return 'deleted';
  }

  /** Removes only inactive, direct child scopes old enough to be considered abandoned. */
  public async reconcileStale(input: {
    readonly activeScopeIds: readonly string[];
    readonly staleBefore: Date;
  }): Promise<{
    readonly deletedScopeIds: readonly string[];
    readonly skippedScopeIds: readonly string[];
  }> {
    if (!Number.isFinite(input.staleBefore.getTime()))
      throw new Error('A valid stale managed temporary cutoff is required.');
    const active = new Set(input.activeScopeIds.map(safeScopeId));
    await mkdir(this.root, { recursive: true });
    const deletedScopeIds: string[] = [];
    const skippedScopeIds: string[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      const scopeId = entry.name;
      if (!entry.isDirectory() || active.has(scopeId)) {
        skippedScopeIds.push(scopeId);
        continue;
      }
      const scopePath = resolve(this.root, safeScopeId(scopeId));
      const details = await lstat(scopePath);
      if (details.isSymbolicLink() || details.mtime.getTime() > input.staleBefore.getTime()) {
        skippedScopeIds.push(scopeId);
        continue;
      }
      await this.cleanup(scopePath);
      deletedScopeIds.push(scopeId);
    }
    return { deletedScopeIds, skippedScopeIds };
  }

  private assertManaged(path: string): string {
    const candidate = resolve(path);
    if (!isPathInside(this.root, candidate))
      throw new Error('Refusing to access a path outside managed temporary storage.');
    return candidate;
  }

  private async assertCanonicalDirectory(path: string): Promise<void> {
    const details = await lstat(path);
    if (!details.isDirectory() || details.isSymbolicLink())
      throw new Error('Managed temporary scope must be a real directory.');
    const canonicalRoot = await realpath(this.root);
    const canonicalDirectory = await realpath(path);
    if (canonicalDirectory !== canonicalRoot && !isPathInside(canonicalRoot, canonicalDirectory))
      throw new Error('Refusing to access a path outside managed temporary storage.');
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

export interface ExecutableDiscoveryOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

export interface MediaExecutables {
  readonly ffmpeg: string | undefined;
  readonly ffprobe: string | undefined;
}

function executableNames(name: 'ffmpeg' | 'ffprobe', platform: NodeJS.Platform): readonly string[] {
  return platform === 'win32' ? [`${name}.exe`, name] : [name];
}

async function executableWorks(executable: string): Promise<boolean> {
  return new Promise((resolveCheck) => {
    const child = spawn(executable, ['-version'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      child.kill();
      resolveCheck(false);
    }, 2_000);
    child.once('error', () => {
      clearTimeout(timeout);
      resolveCheck(false);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolveCheck(code === 0);
    });
  });
}

/** Locates executables through explicit configuration first, then PATH without shell interpretation. */
export async function discoverMediaExecutables(
  options: ExecutableDiscoveryOptions = {},
): Promise<MediaExecutables> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const locate = async (
    name: 'ffmpeg' | 'ffprobe',
    configured: string | undefined,
  ): Promise<string | undefined> => {
    const candidates = configured === undefined ? executableNames(name, platform) : [configured];
    for (const candidate of candidates) if (await executableWorks(candidate)) return candidate;
    const pathValue = environment.PATH ?? environment.Path ?? '';
    for (const directory of pathValue.split(delimiter).filter(Boolean))
      for (const namePart of executableNames(name, platform)) {
        const candidate = join(directory, namePart);
        if (await executableWorks(candidate)) return candidate;
      }
    return undefined;
  };
  return {
    ffmpeg: await locate('ffmpeg', environment.FFMPEG_PATH),
    ffprobe: await locate('ffprobe', environment.FFPROBE_PATH),
  };
}

export class LocalMediaFileInspector implements LocalFileInspector {
  public async inspect(inputPath: string) {
    if (inputPath.trim().length === 0) throw new Error('A media path is required.');
    const resolvedPath = normalize(isAbsolute(inputPath) ? inputPath : resolve(inputPath));
    await access(resolvedPath, constants.R_OK);
    const stats = await lstat(resolvedPath);
    if (!stats.isFile()) throw new Error('Media import accepts a regular local file only.');
    const canonicalPath = await realpath(resolvedPath);
    return {
      path: canonicalPath,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime,
      fingerprint: await fingerprintFile(canonicalPath),
    };
  }
}

/** Streams the source file through SHA-256; it never buffers media contents in process memory. */
export async function fingerprintFile(path: string): Promise<string> {
  return new Promise((resolveFingerprint, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.once('error', reject);
    stream.once('end', () => resolveFingerprint(`sha256:${hash.digest('hex')}`));
  });
}

interface RawStream {
  readonly codec_name?: unknown;
  readonly codec_type?: unknown;
  readonly height?: unknown;
  readonly r_frame_rate?: unknown;
  readonly width?: unknown;
}
interface RawProbe {
  readonly format?: { readonly duration?: unknown };
  readonly streams?: unknown;
}

function numberValue(value: unknown): number | undefined {
  const numeric =
    typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}
function frameRate(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parts = value.split('/').map(Number);
  const numerator = parts[0];
  const denominator = parts[1];
  return numerator !== undefined &&
    denominator !== undefined &&
    Number.isFinite(numerator) &&
    Number.isFinite(denominator) &&
    denominator > 0
    ? numerator / denominator
    : undefined;
}
function streamList(value: unknown): readonly RawStream[] {
  return Array.isArray(value)
    ? value.filter((stream): stream is RawStream => typeof stream === 'object' && stream !== null)
    : [];
}

/** ffprobe adapter using JSON and argument arrays only. */
export class FfprobeMediaProbe implements MediaProbe {
  public constructor(
    private readonly executable: string,
    private readonly argsPrefix: readonly string[] = [],
  ) {}
  public async probe(path: string): Promise<MediaProbeMetadata> {
    const output = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn(
        this.executable,
        [
          ...this.argsPrefix,
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          path,
        ],
        { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', () => reject(new Error('ffprobe could not be started.')));
      child.once('exit', (code) =>
        code === 0
          ? resolveOutput(stdout)
          : reject(new Error(`ffprobe failed (${code ?? 'unknown'}): ${stderr.slice(0, 500)}`)),
      );
    });
    let parsed: RawProbe;
    try {
      parsed = JSON.parse(output) as RawProbe;
    } catch {
      throw new Error('ffprobe returned invalid JSON.');
    }
    const streams = streamList(parsed.streams);
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    const durationSeconds = numberValue(parsed.format?.duration);
    const width = numberValue(video?.width);
    const height = numberValue(video?.height);
    const rate = frameRate(video?.r_frame_rate);
    const videoCodec = typeof video?.codec_name === 'string' ? video.codec_name : undefined;
    const audioCodec = typeof audio?.codec_name === 'string' ? audio.codec_name : undefined;
    return {
      hasAudio: audio !== undefined,
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
      ...(videoCodec === undefined ? {} : { videoCodec }),
      ...(audioCodec === undefined ? {} : { audioCodec }),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(rate === undefined ? {} : { frameRate: rate }),
    };
  }
}

const supportedWatchExtensions = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm']);
function extension(path: string): string {
  const index = path.lastIndexOf('.');
  return index < 0 ? '' : path.slice(index).toLowerCase();
}

export interface WatchedFolderRunnerOptions {
  readonly now?: () => Date;
  readonly pollIntervalMs?: number;
  readonly settleMs?: number;
}

/**
 * Uses fs.watch only as an acceleration signal; periodic scans remain authoritative because
 * Windows/Linux watchers can coalesce or miss events. Cursor rows make restarts idempotent.
 */
export class WatchedFolderRunner {
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private readonly settleMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  public constructor(
    private readonly workflows: WorkflowService,
    private readonly cursors: SourceCursorRepository,
    private readonly media: MediaImportService,
    options: WatchedFolderRunnerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.settleMs = options.settleMs ?? 10_000;
    if (this.pollIntervalMs < 100 || this.settleMs < 0)
      throw new Error('Invalid folder watch timing.');
  }
  public start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.scan(), this.pollIntervalMs);
    void this.scan();
  }
  public stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
  /** Public deterministic scan hook for startup and tests. */
  public async scan(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const workflow of this.workflows.list(true))
        await this.scanWorkflow(workflow.id, workflow.sourceDirectory);
    } finally {
      this.running = false;
    }
  }
  private async scanWorkflow(workflowId: string, directory: string): Promise<void> {
    let files: string[];
    try {
      files = await this.listFiles(directory);
    } catch {
      return;
    }
    for (const path of files) {
      let details: Awaited<ReturnType<typeof stat>>;
      let canonical: string;
      try {
        details = await stat(path);
        canonical = await realpath(path);
      } catch {
        continue;
      }
      const sourceKey = canonical;
      const cursor = this.cursors.find(workflowId, sourceKey);
      const signatureChanged =
        cursor === undefined ||
        cursor.sizeBytes !== details.size ||
        cursor.modifiedAt.getTime() !== details.mtime.getTime();
      const now = this.now();
      if (signatureChanged) {
        this.cursors.save({
          workflowId,
          sourceKey,
          path: canonical,
          sizeBytes: details.size,
          modifiedAt: details.mtime,
          observedAt: now,
          state: 'pending',
        });
        continue;
      }
      if (
        cursor.state === 'processed' ||
        now.getTime() - cursor.observedAt.getTime() < this.settleMs
      )
        continue;
      try {
        const result = await this.media.import(canonical);
        this.workflows.executeWatchedMedia(workflowId, result.asset);
        this.cursors.save({
          ...cursor,
          path: canonical,
          state: 'processed',
          mediaId: result.asset.id,
        });
      } catch {
        // Leave pending state: a still-locked or invalid render can be retried after the next scan.
      }
    }
  }
  private async listFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const output: string[] = [];
    for (const entry of entries) {
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) output.push(...(await this.listFiles(candidate)));
      else if (entry.isFile() && supportedWatchExtensions.has(extension(entry.name)))
        output.push(candidate);
    }
    return output;
  }
}
