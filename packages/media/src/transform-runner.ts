import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import {
  JobExecutionError,
  type JobHandler,
  type JobHandlerContext,
  type JsonValue,
  type MediaProbe,
  type MediaProbeMetadata,
  type MediaRepository,
  type TransformDerivative,
  type TransformDerivativeOutput,
  type TransformDerivativeRepository,
  type TransformPlan,
  type TransformProgress,
} from '@openrepurpose/core';
import { compileTransformCommand, type FfmpegCommand } from './index.js';
import { isSafeManagedPathSegment } from './path-security.js';

export type TransformProcessErrorCode =
  | 'TRANSFORM_CANCELLED'
  | 'TRANSFORM_PROCESS_EXIT'
  | 'TRANSFORM_PROCESS_START_FAILED'
  | 'TRANSFORM_PROGRESS_FAILED'
  | 'TRANSFORM_SHUTDOWN'
  | 'TRANSFORM_STALLED'
  | 'TRANSFORM_TIMEOUT';

export class TransformProcessError extends Error {
  public constructor(
    public readonly code: TransformProcessErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TransformProcessError';
  }
}

function finiteNonnegative(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function timestampMillis(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value);
  if (match === null) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  return Number.isFinite(hours + minutes + seconds)
    ? Math.round((hours * 3600 + minutes * 60 + seconds) * 1000)
    : undefined;
}

/** Incremental parser for FFmpeg's `-progress pipe:1` key/value protocol. */
export class FfmpegProgressParser {
  private buffer = '';
  private readonly fields = new Map<string, string>();

  public constructor(
    private readonly expectedDurationMillis?: number,
    private readonly onProgress?: (progress: TransformProgress) => void,
  ) {}

  public push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.consume(line);
  }

  public finish(): void {
    if (this.buffer.length > 0) this.consume(this.buffer);
    this.buffer = '';
  }

  private consume(line: string): void {
    const separator = line.indexOf('=');
    if (separator <= 0) return;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    this.fields.set(key, value);
    if (key !== 'progress') return;
    const microseconds = finiteNonnegative(
      this.fields.get('out_time_us') ?? this.fields.get('out_time_ms'),
    );
    const outTimeMillis =
      microseconds === undefined
        ? (timestampMillis(this.fields.get('out_time')) ?? 0)
        : Math.round(microseconds / 1000);
    const frame = finiteNonnegative(this.fields.get('frame'));
    const framesPerSecond = finiteNonnegative(this.fields.get('fps'));
    const processedBytes = finiteNonnegative(this.fields.get('total_size'));
    const speedText = this.fields.get('speed');
    const speed =
      speedText === undefined ? undefined : finiteNonnegative(speedText.replace(/x$/, ''));
    const percent =
      this.expectedDurationMillis === undefined || this.expectedDurationMillis <= 0
        ? undefined
        : Math.min(100, Math.max(0, (outTimeMillis / this.expectedDurationMillis) * 100));
    this.onProgress?.({
      outTimeMillis,
      ...(frame === undefined ? {} : { frame: Math.floor(frame) }),
      ...(framesPerSecond === undefined ? {} : { framesPerSecond }),
      ...(processedBytes === undefined ? {} : { processedBytes: Math.floor(processedBytes) }),
      ...(speed === undefined ? {} : { speed }),
      ...(percent === undefined ? {} : { percent }),
    });
    this.fields.clear();
  }
}

export interface FfmpegProcessRunnerOptions {
  readonly killGraceMs?: number;
  readonly stallTimeoutMs?: number;
  readonly timeoutMs?: number;
}

export interface RunFfmpegOptions {
  readonly expectedDurationMillis?: number;
  readonly onProgress?: (progress: TransformProgress) => void;
  readonly signal: AbortSignal;
}

export interface TransformProcessRunner {
  run(command: FfmpegCommand, options: RunFfmpegOptions): Promise<void>;
  stop(): Promise<void>;
}

interface ActiveProcess {
  readonly completion: Promise<void>;
  shutdown(): void;
}

/** Owns FFmpeg child lifetimes, progress parsing, deadlines, cancellation, and forced cleanup. */
export class FfmpegProcessRunner implements TransformProcessRunner {
  private readonly active = new Set<ActiveProcess>();
  private readonly killGraceMs: number;
  private readonly stallTimeoutMs: number;
  private stopping = false;
  private readonly timeoutMs: number;

  public constructor(options: FfmpegProcessRunnerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 6 * 60 * 60 * 1000;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 5 * 60 * 1000;
    this.killGraceMs = options.killGraceMs ?? 5_000;
    if (this.timeoutMs < 1 || this.stallTimeoutMs < 1 || this.killGraceMs < 0)
      throw new Error('Transform process timeouts must be positive.');
  }

  public async run(command: FfmpegCommand, options: RunFfmpegOptions): Promise<void> {
    if (this.stopping)
      throw new TransformProcessError('TRANSFORM_SHUTDOWN', 'Transform worker is stopping.', true);
    if (options.signal.aborted)
      throw new TransformProcessError('TRANSFORM_CANCELLED', 'Transform was cancelled.', false);

    const child = spawn(command.executable, [...command.args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let requestStop: (error: TransformProcessError) => void = () => undefined;
    let shutdown: () => void = () => undefined;
    const completion = new Promise<void>((resolveRun, rejectRun) => {
      let settled = false;
      let requestedError: TransformProcessError | undefined;
      let stderr = '';
      let killTimer: NodeJS.Timeout | undefined;
      let stallTimer: NodeJS.Timeout | undefined;
      const parser = new FfmpegProgressParser(options.expectedDurationMillis, (progress) => {
        try {
          options.onProgress?.(progress);
        } catch {
          requestStop(
            new TransformProcessError(
              'TRANSFORM_PROGRESS_FAILED',
              'Transform progress could not be persisted.',
              true,
            ),
          );
        }
      });
      const clearTimers = () => {
        clearTimeout(timeoutTimer);
        if (stallTimer !== undefined) clearTimeout(stallTimer);
        if (killTimer !== undefined) clearTimeout(killTimer);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        options.signal.removeEventListener('abort', cancel);
        parser.finish();
        if (error === undefined) resolveRun();
        else rejectRun(error);
      };
      const forceKillLater = () => {
        if (killTimer !== undefined) return;
        killTimer = setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, this.killGraceMs);
      };
      requestStop = (error) => {
        if (settled || requestedError !== undefined) return;
        requestedError = error;
        child.kill('SIGTERM');
        forceKillLater();
      };
      shutdown = () =>
        requestStop(
          new TransformProcessError(
            'TRANSFORM_SHUTDOWN',
            'Transform stopped during application shutdown.',
            true,
          ),
        );
      const resetStallTimer = () => {
        if (stallTimer !== undefined) clearTimeout(stallTimer);
        stallTimer = setTimeout(
          () =>
            requestStop(
              new TransformProcessError(
                'TRANSFORM_STALLED',
                'FFmpeg stopped reporting progress.',
                true,
              ),
            ),
          this.stallTimeoutMs,
        );
      };
      const cancel = () =>
        requestStop(
          new TransformProcessError('TRANSFORM_CANCELLED', 'Transform was cancelled.', false),
        );
      const timeoutTimer = setTimeout(
        () =>
          requestStop(
            new TransformProcessError(
              'TRANSFORM_TIMEOUT',
              'FFmpeg exceeded the transform time limit.',
              true,
            ),
          ),
        this.timeoutMs,
      );
      resetStallTimer();
      options.signal.addEventListener('abort', cancel, { once: true });
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        resetStallTimer();
        parser.push(chunk);
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-8_192);
      });
      child.once('error', () =>
        finish(
          requestedError ??
            new TransformProcessError(
              'TRANSFORM_PROCESS_START_FAILED',
              'FFmpeg could not be started.',
              false,
            ),
        ),
      );
      child.once('close', (code, signal) => {
        if (requestedError !== undefined) finish(requestedError);
        else if (code === 0) finish();
        else
          finish(
            new TransformProcessError(
              'TRANSFORM_PROCESS_EXIT',
              `FFmpeg exited unsuccessfully (${code ?? signal ?? 'unknown'}): ${stderr.trim().slice(0, 500)}`,
              false,
            ),
          );
      });
    });
    const active: ActiveProcess = { completion, shutdown: () => shutdown() };
    this.active.add(active);
    try {
      await completion;
    } finally {
      this.active.delete(active);
    }
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    const active = [...this.active];
    for (const process of active) process.shutdown();
    await Promise.allSettled(active.map((process) => process.completion));
  }
}

function safeDerivativeId(value: string): string {
  if (!isSafeManagedPathSegment(value, 128))
    throw new Error('A derivative ID must be a safe identifier.');
  return value;
}

function pathInside(root: string, candidate: string): boolean {
  const nested = relative(root, candidate);
  return nested.length > 0 && !nested.startsWith('..') && !isAbsolute(nested);
}

export interface TransformOutputPaths {
  readonly finalPath: string;
  readonly partialPath: string;
  readonly sidecarFinalPath: string;
  readonly sidecarPartialPath: string;
}

export interface TransformOutputStorage {
  discard(derivativeId: string): Promise<void>;
  finalize(
    paths: TransformOutputPaths,
  ): Promise<{ readonly path: string; readonly sizeBytes: number }>;
  isUsableFile(path: string, expectedSizeBytes?: number): Promise<boolean>;
  prepare(derivativeId: string, requiredBytes: number): Promise<TransformOutputPaths>;
  reconcileStale(input: {
    readonly protectedDerivativeIds: readonly string[];
    readonly staleBefore: Date;
  }): Promise<readonly string[]>;
}

/** Same-filesystem partial/final paths make rename-based finalization atomic on Windows and Linux. */
export class LocalTransformOutputStorage implements TransformOutputStorage {
  public readonly root: string;

  public constructor(dataDirectory: string) {
    if (!isAbsolute(dataDirectory))
      throw new Error('The application data directory must be absolute.');
    this.root = resolve(dataDirectory, 'storage', 'derivatives');
  }

  public async prepare(derivativeId: string, requiredBytes: number): Promise<TransformOutputPaths> {
    const directory = this.directory(derivativeId);
    await mkdir(directory, { recursive: true });
    await this.assertCanonicalDirectory(directory);
    const paths = this.paths(derivativeId);
    await Promise.all([
      rm(paths.partialPath, { force: true }),
      rm(paths.finalPath, { force: true }),
      rm(paths.sidecarPartialPath, { force: true }),
      rm(paths.sidecarFinalPath, { force: true }),
    ]);
    try {
      const fileSystem = await statfs(directory);
      const availableBytes = fileSystem.bavail * fileSystem.bsize;
      if (Number.isFinite(availableBytes) && availableBytes < Math.max(1, requiredBytes))
        throw new Error('Insufficient disk space for transform output.');
    } catch (error) {
      if (error instanceof Error && error.message.includes('Insufficient disk space')) throw error;
      // Some filesystems/runtimes do not expose statfs; execution remains authoritative.
    }
    return paths;
  }

  public async finalize(
    paths: TransformOutputPaths,
  ): Promise<{ readonly path: string; readonly sizeBytes: number }> {
    this.assertManaged(paths.partialPath);
    this.assertManaged(paths.finalPath);
    await this.assertCanonicalDirectory(dirname(paths.partialPath));
    const details = await lstat(paths.partialPath);
    if (!details.isFile() || details.isSymbolicLink() || details.size <= 0)
      throw new Error('Transform output must be a non-empty regular file.');
    await rename(paths.partialPath, paths.finalPath);
    return { path: paths.finalPath, sizeBytes: details.size };
  }

  public async discard(derivativeId: string): Promise<void> {
    const directory = this.directory(derivativeId);
    await rm(directory, { recursive: true, force: true });
  }

  public async isUsableFile(path: string, expectedSizeBytes?: number): Promise<boolean> {
    try {
      this.assertManaged(path);
      await access(path, constants.R_OK);
      await this.assertCanonicalDirectory(dirname(path));
      const details = await lstat(path);
      const canonicalRoot = await realpath(this.root);
      const canonicalPath = await realpath(path);
      return (
        pathInside(canonicalRoot, canonicalPath) &&
        details.isFile() &&
        !details.isSymbolicLink() &&
        details.size > 0 &&
        (expectedSizeBytes === undefined || details.size === expectedSizeBytes)
      );
    } catch {
      return false;
    }
  }

  public async reconcileStale(input: {
    readonly protectedDerivativeIds: readonly string[];
    readonly staleBefore: Date;
  }): Promise<readonly string[]> {
    const protectedIds = new Set(input.protectedDerivativeIds.map(safeDerivativeId));
    await mkdir(this.root, { recursive: true });
    const deleted: string[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || protectedIds.has(entry.name)) continue;
      const id = safeDerivativeId(entry.name);
      const directory = this.directory(id);
      const details = await lstat(directory);
      if (details.isSymbolicLink() || details.mtime.getTime() > input.staleBefore.getTime())
        continue;
      await this.discard(id);
      deleted.push(id);
    }
    return deleted;
  }

  private directory(derivativeId: string): string {
    const directory = resolve(this.root, safeDerivativeId(derivativeId));
    if (!pathInside(this.root, directory)) throw new Error('Derivative path escaped its root.');
    return directory;
  }

  private paths(derivativeId: string): TransformOutputPaths {
    const directory = this.directory(derivativeId);
    return {
      finalPath: resolve(directory, 'output.mp4'),
      partialPath: resolve(directory, 'output.partial.mp4'),
      sidecarFinalPath: resolve(directory, 'captions.srt'),
      sidecarPartialPath: resolve(directory, 'captions.partial.srt'),
    };
  }

  private assertManaged(path: string): void {
    if (!pathInside(this.root, resolve(path)))
      throw new Error('Refusing to access a path outside derivative storage.');
  }

  private async assertCanonicalDirectory(path: string): Promise<void> {
    const root = await realpath(this.root);
    const directory = await realpath(path);
    if (directory !== root && !pathInside(root, directory))
      throw new Error('Refusing to access a path outside derivative storage.');
  }
}

function expectedDurationMillis(
  derivative: TransformDerivative,
  sourceSeconds?: number,
): number | undefined {
  let duration = sourceSeconds === undefined ? undefined : sourceSeconds * 1000;
  const plan: TransformPlan = derivative.provenance.normalizedPlan;
  for (const step of [...plan.user.steps, ...(plan.destination?.recipe.steps ?? [])]) {
    if (step.type !== 'trim') continue;
    if (step.durationMs !== undefined) duration = step.durationMs;
    else if (step.endMs !== undefined) duration = Math.max(0, step.endMs - step.startMs);
    else if (duration !== undefined) duration = Math.max(0, duration - step.startMs);
  }
  return duration === undefined ? undefined : Math.round(duration);
}

/**
 * Reject a probe result that cannot satisfy the v0.6 CPU output contract before it is
 * atomically published into the derivative cache. This deliberately checks only values
 * that the typed plan controls; source-derived dimensions remain source-derived.
 */
function assertCoreTransformOutput(
  plan: TransformPlan,
  sourceHasAudio: boolean,
  metadata: MediaProbeMetadata,
): void {
  const recipe = plan.destination?.recipe ?? plan.user;
  const steps = [...plan.user.steps, ...(plan.destination?.recipe.steps ?? [])];
  if (metadata.videoCodec?.toLowerCase() !== 'h264')
    throw new JobExecutionError(
      'TRANSFORM_OUTPUT_INVALID',
      false,
      'FFmpeg output must use the H.264 video codec.',
    );

  const lastFit = [...steps].reverse().find((step) => step.type === 'fit');
  if (
    lastFit !== undefined &&
    recipe.output.maxWidth === undefined &&
    recipe.output.maxHeight === undefined &&
    (metadata.width !== lastFit.width || metadata.height !== lastFit.height)
  )
    throw new JobExecutionError(
      'TRANSFORM_OUTPUT_INVALID',
      false,
      `FFmpeg output dimensions must be ${lastFit.width}x${lastFit.height}.`,
    );
  if (
    (recipe.output.maxWidth !== undefined &&
      metadata.width !== undefined &&
      metadata.width > recipe.output.maxWidth) ||
    (recipe.output.maxHeight !== undefined &&
      metadata.height !== undefined &&
      metadata.height > recipe.output.maxHeight)
  )
    throw new JobExecutionError(
      'TRANSFORM_OUTPUT_INVALID',
      false,
      'FFmpeg output exceeds the configured maximum dimensions.',
    );
  if (
    recipe.output.maxFrameRate !== undefined &&
    metadata.frameRate !== undefined &&
    metadata.frameRate > recipe.output.maxFrameRate + 0.01
  )
    throw new JobExecutionError(
      'TRANSFORM_OUTPUT_INVALID',
      false,
      'FFmpeg output exceeds the configured maximum frame rate.',
    );

  const audioRemoved = steps.some((step) => step.type === 'audio' && step.mode === 'remove');
  const expectAac = sourceHasAudio && !audioRemoved && recipe.output.audioCodec === 'aac';
  if (expectAac && (!metadata.hasAudio || metadata.audioCodec?.toLowerCase() !== 'aac'))
    throw new JobExecutionError(
      'TRANSFORM_OUTPUT_INVALID',
      false,
      'FFmpeg output must preserve audio as AAC.',
    );
  if (!expectAac && metadata.hasAudio)
    throw new JobExecutionError(
      'TRANSFORM_OUTPUT_INVALID',
      false,
      'FFmpeg output must not contain audio.',
    );
}

function derivativeIdFromInput(input: JsonValue): string {
  if (input === null || Array.isArray(input) || typeof input !== 'object')
    throw new JobExecutionError('INVALID_TRANSFORM_JOB', false, 'Transform job input is invalid.');
  const derivativeId = (input as Readonly<Record<string, JsonValue>>).derivativeId;
  if (typeof derivativeId !== 'string' || derivativeId.trim().length === 0)
    throw new JobExecutionError('INVALID_TRANSFORM_JOB', false, 'Transform job input is invalid.');
  return derivativeId;
}

const watermarkImageExtensions = new Set([
  '.bmp',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.tif',
  '.tiff',
  '.webp',
]);

/**
 * Resolves typed watermark asset references through the same local media repository used for
 * transform sources. Recipes retain stable asset IDs; paths are deliberately late-bound and are
 * never persisted in filter strings or treated as shell syntax.
 */
function resolveWatermarkPaths(
  plan: TransformPlan,
  media: MediaRepository,
): Readonly<Record<string, string>> {
  const paths: Record<string, string> = {};
  const steps = [...plan.user.steps, ...(plan.destination?.recipe.steps ?? [])];
  for (const step of steps) {
    if (step.type !== 'watermark' || paths[step.assetId] !== undefined) continue;
    const asset = media.findById(step.assetId);
    if (asset === undefined || asset.state !== 'available')
      throw new JobExecutionError(
        'WATERMARK_ASSET_UNAVAILABLE',
        false,
        `Watermark asset "${step.assetId}" is unavailable.`,
      );
    if (!watermarkImageExtensions.has(extname(asset.path).toLowerCase()))
      throw new JobExecutionError(
        'WATERMARK_ASSET_INVALID',
        false,
        `Watermark asset "${step.assetId}" must be a supported image file.`,
      );
    paths[step.assetId] = asset.path;
  }
  return paths;
}

/** Persistent job handler that executes one reserved derivative through atomic finalization. */
export class TransformJobHandler implements JobHandler {
  public readonly type = 'media.transform';

  public constructor(
    private readonly derivatives: TransformDerivativeRepository,
    private readonly media: MediaRepository,
    private readonly storage: TransformOutputStorage,
    private readonly processes: TransformProcessRunner,
    private readonly probe: MediaProbe,
    private readonly executable: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async execute(input: JsonValue, context: JobHandlerContext): Promise<void> {
    const derivativeId = derivativeIdFromInput(input);
    let derivative = this.derivatives.findById(derivativeId);
    if (derivative === undefined)
      throw new JobExecutionError(
        'TRANSFORM_NOT_FOUND',
        false,
        'Transform derivative was not found.',
      );
    if (derivative.status === 'succeeded' && derivative.output !== undefined) {
      const source = this.media.findById(derivative.provenance.sourceMediaId);
      const sourceMatches =
        source !== undefined &&
        source.state === 'available' &&
        source.fingerprint === derivative.provenance.sourceFingerprint;
      if (
        sourceMatches &&
        (await this.storage.isUsableFile(derivative.output.path, derivative.output.sizeBytes))
      )
        return;
      derivative = this.derivatives.invalidateSucceeded(
        derivative.id,
        sourceMatches
          ? {
              code: 'TRANSFORM_OUTPUT_INVALID',
              message: 'The finalized transform output is missing or has changed.',
            }
          : {
              code: 'TRANSFORM_SOURCE_CHANGED',
              message: 'The transform source is missing or has changed.',
            },
        this.now(),
      );
    }
    if (derivative.status === 'cancelled')
      throw new JobExecutionError('TRANSFORM_CANCELLED', false, 'Transform was cancelled.');
    derivative = this.derivatives.markRunning(derivative.id, this.now());
    try {
      const source = this.media.findById(derivative.provenance.sourceMediaId);
      if (
        source === undefined ||
        source.state !== 'available' ||
        source.fingerprint !== derivative.provenance.sourceFingerprint
      )
        throw new JobExecutionError(
          'TRANSFORM_SOURCE_UNAVAILABLE',
          false,
          'The transform source is missing or has changed.',
        );
      const paths = await this.storage.prepare(derivative.id, source.sizeBytes);
      const captionSteps = [
        ...derivative.provenance.normalizedPlan.user.steps,
        ...(derivative.provenance.normalizedPlan.destination?.recipe.steps ?? []),
      ].filter(
        (step): step is Extract<typeof step, { type: 'captions' }> => step.type === 'captions',
      );
      const captionPaths: Record<string, string> = {};
      if (captionSteps.length > 0) {
        const sourceIds = new Set(captionSteps.map((step) => step.source));
        if (sourceIds.size !== 1)
          throw new JobExecutionError(
            'CAPTION_SOURCE_INVALID',
            false,
            'A transform can render captions from only one transcript.',
          );
        const caption = captionSteps[0]!;
        await writeFile(paths.sidecarPartialPath, caption.subtitle, {
          encoding: 'utf8',
          flag: 'wx',
        });
        captionPaths[caption.source] = paths.sidecarPartialPath;
      }
      const command = compileTransformCommand({
        executable: this.executable,
        inputPath: source.path,
        outputPath: paths.partialPath,
        plan: derivative.provenance.normalizedPlan,
        sourceHasAudio: source.metadata.hasAudio,
        watermarkPaths: resolveWatermarkPaths(derivative.provenance.normalizedPlan, this.media),
        captionPaths,
      });
      const expectedDuration = expectedDurationMillis(derivative, source.metadata.durationSeconds);
      await this.processes.run(command, {
        signal: context.signal,
        ...(expectedDuration === undefined ? {} : { expectedDurationMillis: expectedDuration }),
        onProgress: (progress) => {
          this.derivatives.updateProgress(derivative.id, progress, this.now());
        },
      });
      if (context.signal.aborted)
        throw new TransformProcessError('TRANSFORM_CANCELLED', 'Transform was cancelled.', false);
      const metadata = await this.probe.probe(paths.partialPath);
      if (
        metadata.durationSeconds === undefined ||
        metadata.videoCodec === undefined ||
        metadata.width === undefined ||
        metadata.height === undefined
      )
        throw new JobExecutionError(
          'TRANSFORM_OUTPUT_INVALID',
          false,
          'FFmpeg produced output without required media metadata.',
        );
      assertCoreTransformOutput(
        derivative.provenance.normalizedPlan,
        source.metadata.hasAudio,
        metadata,
      );
      if (context.signal.aborted)
        throw new TransformProcessError('TRANSFORM_CANCELLED', 'Transform was cancelled.', false);
      const finalized = await this.storage.finalize(paths);
      const sidecar = captionSteps.find((step) => step.mode === 'sidecar');
      let sidecarCaptions:
        { readonly format: 'srt'; readonly path: string; readonly sizeBytes: number } | undefined;
      if (sidecar !== undefined) {
        const details = await lstat(paths.sidecarPartialPath);
        await rename(paths.sidecarPartialPath, paths.sidecarFinalPath);
        sidecarCaptions = { format: 'srt', path: paths.sidecarFinalPath, sizeBytes: details.size };
      } else await rm(paths.sidecarPartialPath, { force: true });
      const output: TransformDerivativeOutput = {
        path: finalized.path,
        sizeBytes: finalized.sizeBytes,
        metadata: {
          durationMillis: Math.round(metadata.durationSeconds * 1000),
          hasAudio: metadata.hasAudio,
          height: metadata.height,
          videoCodec: metadata.videoCodec,
          width: metadata.width,
          ...(metadata.audioCodec === undefined ? {} : { audioCodec: metadata.audioCodec }),
          ...(metadata.frameRate === undefined ? {} : { frameRate: metadata.frameRate }),
        },
        ...(sidecarCaptions === undefined ? {} : { sidecarCaptions }),
      };
      if (context.signal.aborted)
        throw new TransformProcessError('TRANSFORM_CANCELLED', 'Transform was cancelled.', false);
      this.derivatives.complete(derivative.id, output, this.now());
    } catch (error) {
      let cleanupFailed = false;
      try {
        await this.storage.discard(derivative.id);
      } catch {
        cleanupFailed = true;
      }
      if (
        context.signal.aborted ||
        (error instanceof TransformProcessError && error.code === 'TRANSFORM_CANCELLED')
      ) {
        this.derivatives.markCancelled(derivative.id, this.now());
        throw error;
      }
      const code =
        error instanceof TransformProcessError || error instanceof JobExecutionError
          ? error.code
          : 'TRANSFORM_EXECUTION_FAILED';
      const message =
        error instanceof TransformProcessError || error instanceof JobExecutionError
          ? error.message
          : 'Transform execution failed.';
      const persistedMessage = cleanupFailed
        ? `${message} Partial output cleanup will be retried during recovery.`
        : message;
      this.derivatives.fail(derivative.id, { code, message: persistedMessage }, this.now());
      if (error instanceof JobExecutionError) throw error;
      throw new JobExecutionError(
        code,
        error instanceof TransformProcessError ? error.retryable : false,
        message,
      );
    }
  }
}

/** Repairs interrupted rows and removes abandoned non-success output scopes on startup. */
export class TransformRecoveryService {
  public constructor(
    private readonly derivatives: TransformDerivativeRepository,
    private readonly storage: TransformOutputStorage,
    private readonly now: () => Date = () => new Date(),
    private readonly staleAgeMs = 24 * 60 * 60 * 1000,
  ) {}

  public async recover(): Promise<{ readonly interrupted: number; readonly staleDeleted: number }> {
    const now = this.now();
    const interrupted = this.derivatives.recoverRunning(now);
    await Promise.all(interrupted.map((derivative) => this.storage.discard(derivative.id)));
    const protectedDerivativeIds = this.derivatives
      .list('succeeded')
      .map((derivative) => derivative.id);
    const deleted = await this.storage.reconcileStale({
      protectedDerivativeIds,
      staleBefore: new Date(now.getTime() - this.staleAgeMs),
    });
    return { interrupted: interrupted.length, staleDeleted: deleted.length };
  }
}
