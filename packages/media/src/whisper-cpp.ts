import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  transcriptCueSchema,
  type TranscriptCue,
  type TranscriptionModel,
  type TranscriptionProgress,
  type TranscriptionProvider,
  type TranscriptionRequest,
  type TranscriptionResult,
} from '@openrepurpose/core';
import { isSafeManagedPathSegment } from './path-security.js';

const MAX_DIAGNOSTIC_LENGTH = 8_192;
const MAX_JSON_OUTPUT_BYTES = 64 * 1024 * 1024;

function safePathSegment(value: string, description: string): string {
  const normalized = value.trim();
  if (!isSafeManagedPathSegment(normalized, 200))
    throw new Error(`${description} must be a safe identifier.`);
  return normalized;
}

function assertAbsolute(path: string, description: string): string {
  if (!isAbsolute(path)) throw new Error(`${description} must be absolute.`);
  return resolve(path);
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot.length > 0 && !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
}

async function assertRegularFile(path: string, description: string): Promise<void> {
  try {
    await access(path, constants.R_OK);
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error();
  } catch {
    throw new WhisperCppError(
      'WHISPER_CPP_FILE_UNAVAILABLE',
      `${description} is unavailable.`,
      false,
    );
  }
}

export interface WhisperCppPaths {
  readonly installationRoot: string;
  readonly modelRoot: string;
}

/** Default managed locations; callers may inject different absolute roots without changing the provider. */
export function resolveWhisperCppPaths(dataDirectory: string): WhisperCppPaths {
  const root = assertAbsolute(dataDirectory, 'Application data directory');
  return {
    installationRoot: resolve(root, 'tools', 'whisper-cpp'),
    modelRoot: resolve(root, 'models', 'whisper-cpp'),
  };
}

function executableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
}

export interface WhisperCppExecutable {
  readonly argsPrefix: readonly string[];
  readonly path: string;
  readonly source: 'configured' | 'managed' | 'packaged' | 'path';
  readonly version?: string;
}

interface ManagedInstallManifest {
  readonly architecture: string;
  readonly executable: string;
  readonly platform: NodeJS.Platform;
  readonly version: string;
}

function parseManagedManifest(value: unknown): ManagedInstallManifest | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.architecture !== 'string' ||
    typeof record.executable !== 'string' ||
    typeof record.platform !== 'string' ||
    typeof record.version !== 'string'
  )
    return undefined;
  return {
    architecture: record.architecture,
    executable: record.executable,
    platform: record.platform as NodeJS.Platform,
    version: record.version,
  };
}

export type WhisperCppExecutableProbe = (path: string) => Promise<string | undefined>;

/** Reads `whisper-cli --version` directly, with no shell and a bounded output/time budget. */
export async function readWhisperCppVersion(executable: string): Promise<string> {
  return new Promise((resolveVersion, rejectVersion) => {
    const child = spawn(executable, ['--version'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error !== undefined) rejectVersion(error);
      else {
        const version = output
          .split(/\r?\n/)
          .find((line) => line.trim().length > 0)
          ?.trim();
        if (version === undefined) rejectVersion(new Error('whisper.cpp returned no version.'));
        else resolveVersion(version.slice(0, 500));
      }
    };
    const append = (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(-MAX_DIAGNOSTIC_LENGTH);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', () => finish(new Error('whisper.cpp could not be started.')));
    child.once('close', (code) =>
      code === 0 ? finish() : finish(new Error('whisper.cpp version check failed.')),
    );
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('whisper.cpp version check timed out.'));
    }, 5_000);
  });
}

const defaultExecutableProbe: WhisperCppExecutableProbe = async (path) => {
  try {
    return await readWhisperCppVersion(path);
  } catch {
    return undefined;
  }
};

export interface WhisperCppDiscoveryOptions {
  readonly architecture?: NodeJS.Architecture;
  readonly configuredExecutable?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly managedInstallationRoot?: string;
  readonly packagedExecutable?: string;
  readonly platform?: NodeJS.Platform;
  readonly probe?: WhisperCppExecutableProbe;
}

async function readManagedExecutable(
  root: string,
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): Promise<{ readonly path: string; readonly version: string } | undefined> {
  const absoluteRoot = assertAbsolute(root, 'Managed whisper.cpp installation root');
  let manifest: ManagedInstallManifest | undefined;
  try {
    manifest = parseManagedManifest(
      JSON.parse(await readFile(join(absoluteRoot, 'current.json'), 'utf8')),
    );
  } catch {
    return undefined;
  }
  if (
    manifest === undefined ||
    manifest.platform !== platform ||
    manifest.architecture !== architecture
  )
    return undefined;
  const path = resolve(absoluteRoot, manifest.executable);
  if (!isInside(absoluteRoot, path)) return undefined;
  return { path, version: manifest.version };
}

/** Discovery order is explicit configuration, managed install, packaged companion, then PATH. */
export async function discoverWhisperCppExecutable(
  options: WhisperCppDiscoveryOptions = {},
): Promise<WhisperCppExecutable | undefined> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const environment = options.environment ?? process.env;
  const probe = options.probe ?? defaultExecutableProbe;
  const candidates: Array<{
    readonly path: string;
    readonly source: WhisperCppExecutable['source'];
    readonly version?: string;
  }> = [];
  if (options.configuredExecutable !== undefined)
    candidates.push({ path: options.configuredExecutable, source: 'configured' });
  if (options.managedInstallationRoot !== undefined) {
    const managed = await readManagedExecutable(
      options.managedInstallationRoot,
      platform,
      architecture,
    );
    if (managed !== undefined)
      candidates.push({ path: managed.path, source: 'managed', version: managed.version });
  }
  if (options.packagedExecutable !== undefined)
    candidates.push({ path: options.packagedExecutable, source: 'packaged' });

  const name = executableName(platform);
  candidates.push({ path: name, source: 'path' });
  const pathValue = environment.PATH ?? environment.Path ?? '';
  for (const directory of pathValue.split(delimiter).filter(Boolean))
    candidates.push({ path: join(directory, name), source: 'path' });

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = platform === 'win32' ? candidate.path.toLowerCase() : candidate.path;
    if (seen.has(key)) continue;
    seen.add(key);
    const probedVersion = await probe(candidate.path);
    if (probedVersion !== undefined)
      return {
        argsPrefix: [],
        path: candidate.path,
        source: candidate.source,
        version: candidate.version ?? probedVersion,
      };
  }
  return undefined;
}

export interface InstallWhisperCppInput {
  /** Directory containing whisper-cli and all adjacent runtime libraries from one prepared build. */
  readonly sourceDirectory: string;
  readonly version: string;
}

export interface WhisperCppInstallationStoreOptions {
  readonly architecture?: NodeJS.Architecture;
  readonly platform?: NodeJS.Platform;
  readonly probe?: WhisperCppExecutableProbe;
}

/**
 * Adopts an extracted/built whisper.cpp distribution into an immutable versioned directory.
 * Download/archive policy stays outside this boundary; copying and activation require no Python.
 */
export class LocalWhisperCppInstallationStore {
  private readonly architecture: NodeJS.Architecture;
  private readonly platform: NodeJS.Platform;
  private readonly probe: WhisperCppExecutableProbe;
  public readonly root: string;

  public constructor(root: string, options: WhisperCppInstallationStoreOptions = {}) {
    this.root = assertAbsolute(root, 'Managed whisper.cpp installation root');
    this.platform = options.platform ?? process.platform;
    this.architecture = options.architecture ?? process.arch;
    this.probe = options.probe ?? defaultExecutableProbe;
  }

  public async install(input: InstallWhisperCppInput): Promise<WhisperCppExecutable> {
    const sourceDirectory = assertAbsolute(input.sourceDirectory, 'whisper.cpp source directory');
    const version = safePathSegment(input.version, 'whisper.cpp version');
    const sourceDetails = await lstat(sourceDirectory);
    if (!sourceDetails.isDirectory() || sourceDetails.isSymbolicLink())
      throw new Error('whisper.cpp source directory must be a real directory.');
    const sourceExecutable = join(sourceDirectory, executableName(this.platform));
    if ((await this.probe(sourceExecutable)) === undefined)
      throw new Error('Prepared whisper.cpp distribution does not contain a working whisper-cli.');

    const installationsRoot = resolve(this.root, 'installations');
    const target = resolve(installationsRoot, version, `${this.platform}-${this.architecture}`);
    if (!isInside(installationsRoot, target))
      throw new Error('Managed installation escaped its root.');
    await mkdir(dirname(target), { recursive: true });
    const targetExists = await lstat(target)
      .then((details) => details.isDirectory())
      .catch(() => false);
    if (!targetExists) {
      const stagingParent = await mkdtemp(join(installationsRoot, '.install-'));
      const staging = join(stagingParent, 'distribution');
      try {
        await cp(sourceDirectory, staging, { recursive: true, errorOnExist: true, force: false });
        const stagedExecutable = join(staging, executableName(this.platform));
        if (this.platform !== 'win32') await chmod(stagedExecutable, 0o755);
        if ((await this.probe(stagedExecutable)) === undefined)
          throw new Error('Copied whisper.cpp executable failed validation.');
        await rename(staging, target);
      } finally {
        await rm(stagingParent, { recursive: true, force: true });
      }
    }

    const installedExecutable = join(target, executableName(this.platform));
    const detectedVersion = await this.probe(installedExecutable);
    if (detectedVersion === undefined)
      throw new Error('Managed whisper.cpp installation is unavailable or corrupt.');
    await mkdir(this.root, { recursive: true });
    const manifest: ManagedInstallManifest = {
      architecture: this.architecture,
      executable: relative(this.root, installedExecutable),
      platform: this.platform,
      version,
    };
    const temporaryManifest = join(this.root, `.current-${randomUUID()}.json`);
    const currentManifest = join(this.root, 'current.json');
    try {
      await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      try {
        await rename(temporaryManifest, currentManifest);
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
        if (code !== 'EEXIST' && code !== 'EPERM') throw error;
        const previousManifest = join(this.root, `.previous-${randomUUID()}.json`);
        await rename(currentManifest, previousManifest);
        try {
          await rename(temporaryManifest, currentManifest);
        } catch (replacementError) {
          await rename(previousManifest, currentManifest);
          throw replacementError;
        }
        await rm(previousManifest, { force: true });
      }
    } finally {
      await rm(temporaryManifest, { force: true });
    }
    return {
      argsPrefix: [],
      path: installedExecutable,
      source: 'managed',
      version: detectedVersion,
    };
  }
}

export interface WhisperCppModelLocator {
  locate(model: TranscriptionModel): Promise<string>;
}

/** Versioned model layout: `<root>/<model id>/<model version>/ggml-model.bin`. */
export class LocalWhisperCppModelLocator implements WhisperCppModelLocator {
  public readonly root: string;

  public constructor(root: string) {
    this.root = assertAbsolute(root, 'whisper.cpp model root');
  }

  public pathFor(model: TranscriptionModel): string {
    const modelId = safePathSegment(model.id, 'Transcription model ID');
    const version = safePathSegment(model.version, 'Transcription model version');
    const path = resolve(this.root, modelId, version, 'ggml-model.bin');
    if (!isInside(this.root, path)) throw new Error('Managed model path escaped its root.');
    return path;
  }

  public async locate(model: TranscriptionModel): Promise<string> {
    const path = this.pathFor(model);
    try {
      await assertRegularFile(path, `whisper.cpp model ${model.id}@${model.version}`);
    } catch {
      throw new WhisperCppError(
        'WHISPER_CPP_MODEL_NOT_FOUND',
        `whisper.cpp model ${model.id}@${model.version} is not installed.`,
        false,
      );
    }
    return path;
  }
}

export interface WhisperCppCommand {
  readonly args: readonly string[];
  readonly executable: string;
  readonly outputJsonPath: string;
}

function optionRecord(request: TranscriptionRequest): {
  readonly bestOf?: number;
  readonly beamSize?: number;
  readonly maxSegmentLength?: number;
  readonly noGpu?: boolean;
  readonly splitOnWord?: boolean;
  readonly temperature?: number;
  readonly threads?: number;
  readonly translate?: boolean;
} {
  const allowed = new Set([
    'bestOf',
    'beamSize',
    'maxSegmentLength',
    'noGpu',
    'splitOnWord',
    'temperature',
    'threads',
    'translate',
  ]);
  for (const key of Object.keys(request.options))
    if (!allowed.has(key)) throw new Error(`Unsupported whisper.cpp option: ${key}`);
  const integer = (key: string, minimum: number, maximum: number): number | undefined => {
    const value = request.options[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum)
      throw new Error(
        `whisper.cpp option ${key} must be an integer from ${minimum} to ${maximum}.`,
      );
    return value;
  };
  const boolean = (key: string): boolean | undefined => {
    const value = request.options[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw new Error(`whisper.cpp option ${key} must be boolean.`);
    return value;
  };
  const temperature = request.options.temperature;
  if (
    temperature !== undefined &&
    (typeof temperature !== 'number' ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 1)
  )
    throw new Error('whisper.cpp option temperature must be a number from 0 to 1.');
  const bestOf = integer('bestOf', 1, 100);
  const beamSize = integer('beamSize', 1, 100);
  const maxSegmentLength = integer('maxSegmentLength', 1, 20_000);
  const noGpu = boolean('noGpu');
  const splitOnWord = boolean('splitOnWord');
  const threads = integer('threads', 1, 1_024);
  const translate = boolean('translate');
  return {
    ...(bestOf === undefined ? {} : { bestOf }),
    ...(beamSize === undefined ? {} : { beamSize }),
    ...(maxSegmentLength === undefined ? {} : { maxSegmentLength }),
    ...(noGpu === undefined ? {} : { noGpu }),
    ...(splitOnWord === undefined ? {} : { splitOnWord }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(threads === undefined ? {} : { threads }),
    ...(translate === undefined ? {} : { translate }),
  };
}

/** Compiles a fixed, validated argv vector for whisper-cli JSON sidecar output. */
export function compileWhisperCppCommand(input: {
  readonly argsPrefix?: readonly string[];
  readonly executable: string;
  readonly modelPath: string;
  readonly outputPrefix: string;
  readonly request: TranscriptionRequest;
}): WhisperCppCommand {
  if (input.executable.trim().length === 0) throw new Error('whisper.cpp executable is required.');
  const modelPath = assertAbsolute(input.modelPath, 'whisper.cpp model path');
  const audioPath = assertAbsolute(input.request.audioPath, 'Transcription audio path');
  const outputPrefix = assertAbsolute(input.outputPrefix, 'whisper.cpp output prefix');
  const language = input.request.language?.trim() || 'auto';
  if (!/^[a-zA-Z-]{2,20}$/.test(language) && language !== 'auto')
    throw new Error('Transcription language must be a language code or auto.');
  const options = optionRecord(input.request);
  const args = [
    ...(input.argsPrefix ?? []),
    '--model',
    modelPath,
    '--file',
    audioPath,
    '--language',
    language,
    '--output-json',
    '--output-file',
    outputPrefix,
    '--print-progress',
    '--no-prints',
  ];
  if (options.translate === true) args.push('--translate');
  if (options.threads !== undefined) args.push('--threads', String(options.threads));
  if (options.temperature !== undefined) args.push('--temperature', String(options.temperature));
  if (options.beamSize !== undefined) args.push('--beam-size', String(options.beamSize));
  if (options.bestOf !== undefined) args.push('--best-of', String(options.bestOf));
  if (options.maxSegmentLength !== undefined)
    args.push('--max-len', String(options.maxSegmentLength));
  if (options.splitOnWord === true) args.push('--split-on-word');
  if (options.noGpu === true) args.push('--no-gpu');
  return { args, executable: input.executable, outputJsonPath: `${outputPrefix}.json` };
}

export class WhisperCppProgressParser {
  private buffer = '';
  private lastPercent = -1;

  public constructor(private readonly onProgress?: (progress: TranscriptionProgress) => void) {}

  public push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/[\r\n]+/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.consume(line);
    if (this.buffer.length > 1_024) {
      this.consume(this.buffer);
      this.buffer = this.buffer.slice(-256);
    }
  }

  public finish(): void {
    if (this.buffer.length > 0) this.consume(this.buffer);
    this.buffer = '';
  }

  private consume(line: string): void {
    const matches = line.matchAll(/progress\s*=\s*(\d{1,3})%/gi);
    for (const match of matches) {
      const raw = Number(match[1]);
      if (!Number.isFinite(raw)) continue;
      const percent = Math.min(100, Math.max(0, raw));
      if (percent <= this.lastPercent) continue;
      this.lastPercent = percent;
      this.onProgress?.({ percent });
    }
  }
}

export type WhisperCppErrorCode =
  | 'WHISPER_CPP_CANCELLED'
  | 'WHISPER_CPP_FILE_UNAVAILABLE'
  | 'WHISPER_CPP_MODEL_NOT_FOUND'
  | 'WHISPER_CPP_OUTPUT_INVALID'
  | 'WHISPER_CPP_PROCESS_EXIT'
  | 'WHISPER_CPP_PROCESS_START_FAILED'
  | 'WHISPER_CPP_PROGRESS_FAILED'
  | 'WHISPER_CPP_SHUTDOWN'
  | 'WHISPER_CPP_TIMEOUT';

export class WhisperCppError extends Error {
  public constructor(
    public readonly code: WhisperCppErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'WhisperCppError';
  }
}

interface ActiveWhisperCppProcess {
  readonly completion: Promise<void>;
  shutdown(): void;
}

export interface WhisperCppProcessRunnerOptions {
  readonly killGraceMs?: number;
  readonly timeoutMs?: number;
}

export interface RunWhisperCppOptions {
  readonly onProgress?: (progress: TranscriptionProgress) => void;
  readonly signal: AbortSignal;
}

/** Owns whisper-cli child lifetimes, diagnostics, progress, cancellation, and shutdown. */
export class WhisperCppProcessRunner {
  private readonly active = new Set<ActiveWhisperCppProcess>();
  private readonly killGraceMs: number;
  private stopping = false;
  private readonly timeoutMs: number;

  public constructor(options: WhisperCppProcessRunnerOptions = {}) {
    this.killGraceMs = options.killGraceMs ?? 5_000;
    this.timeoutMs = options.timeoutMs ?? 6 * 60 * 60 * 1_000;
    if (this.killGraceMs < 0 || this.timeoutMs < 1)
      throw new Error('whisper.cpp process timeouts are invalid.');
  }

  public async run(command: WhisperCppCommand, options: RunWhisperCppOptions): Promise<void> {
    if (this.stopping)
      throw new WhisperCppError('WHISPER_CPP_SHUTDOWN', 'Transcription worker is stopping.', true);
    if (options.signal.aborted)
      throw new WhisperCppError('WHISPER_CPP_CANCELLED', 'Transcription was cancelled.', false);
    const child = spawn(command.executable, [...command.args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let requestStop: (error: WhisperCppError) => void = () => undefined;
    let shutdown: () => void = () => undefined;
    const completion = new Promise<void>((resolveRun, rejectRun) => {
      let settled = false;
      let requestedError: WhisperCppError | undefined;
      let diagnostic = '';
      let killTimer: NodeJS.Timeout | undefined;
      const parser = new WhisperCppProgressParser((progress) => {
        try {
          options.onProgress?.(progress);
        } catch {
          requestStop(
            new WhisperCppError(
              'WHISPER_CPP_PROGRESS_FAILED',
              'Transcription progress could not be persisted.',
              true,
            ),
          );
        }
      });
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        options.signal.removeEventListener('abort', cancel);
        parser.finish();
        if (error === undefined) resolveRun();
        else rejectRun(error);
      };
      requestStop = (error) => {
        if (settled || requestedError !== undefined) return;
        requestedError = error;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, this.killGraceMs);
      };
      shutdown = () =>
        requestStop(
          new WhisperCppError(
            'WHISPER_CPP_SHUTDOWN',
            'Transcription stopped during application shutdown.',
            true,
          ),
        );
      const cancel = () =>
        requestStop(
          new WhisperCppError('WHISPER_CPP_CANCELLED', 'Transcription was cancelled.', false),
        );
      const timeoutTimer = setTimeout(
        () =>
          requestStop(
            new WhisperCppError(
              'WHISPER_CPP_TIMEOUT',
              'whisper.cpp exceeded the transcription time limit.',
              true,
            ),
          ),
        this.timeoutMs,
      );
      options.signal.addEventListener('abort', cancel, { once: true });
      const consume = (chunk: string) => {
        diagnostic = `${diagnostic}${chunk}`.slice(-MAX_DIAGNOSTIC_LENGTH);
        parser.push(chunk);
      };
      child.stdout.setEncoding('utf8').on('data', consume);
      child.stderr.setEncoding('utf8').on('data', consume);
      child.once('error', () =>
        finish(
          requestedError ??
            new WhisperCppError(
              'WHISPER_CPP_PROCESS_START_FAILED',
              'whisper.cpp could not be started.',
              false,
            ),
        ),
      );
      child.once('close', (code, signal) => {
        if (requestedError !== undefined) finish(requestedError);
        else if (code === 0) finish();
        else
          finish(
            new WhisperCppError(
              'WHISPER_CPP_PROCESS_EXIT',
              `whisper.cpp exited unsuccessfully (${code ?? signal ?? 'unknown'}): ${diagnostic.trim().slice(-500)}`,
              false,
            ),
          );
      });
    });
    const active: ActiveWhisperCppProcess = { completion, shutdown };
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

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Parses whisper-cli `--output-json` output into provider-neutral cues. Offsets are milliseconds. */
export function parseWhisperCppOutput(json: string): TranscriptionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new WhisperCppError(
      'WHISPER_CPP_OUTPUT_INVALID',
      'whisper.cpp returned malformed JSON.',
      false,
    );
  }
  const root = record(parsed);
  const rawTranscription = root?.transcription;
  if (!Array.isArray(rawTranscription))
    throw new WhisperCppError(
      'WHISPER_CPP_OUTPUT_INVALID',
      'whisper.cpp JSON did not include a transcription array.',
      false,
    );
  const cues: TranscriptCue[] = [];
  try {
    for (const rawCue of rawTranscription) {
      const cue = record(rawCue);
      const offsets = record(cue?.offsets);
      const text = typeof cue?.text === 'string' ? cue.text.trim() : '';
      if (text.length === 0) continue;
      cues.push(
        transcriptCueSchema.parse({
          startMs: offsets?.from,
          endMs: offsets?.to,
          text,
        }),
      );
    }
  } catch {
    throw new WhisperCppError(
      'WHISPER_CPP_OUTPUT_INVALID',
      'whisper.cpp JSON contained an invalid transcript cue.',
      false,
    );
  }
  const result = record(root?.result);
  const detectedLanguage =
    typeof result?.language === 'string' && result.language.trim().length > 0
      ? result.language.trim()
      : undefined;
  return { cues, ...(detectedLanguage === undefined ? {} : { detectedLanguage }) };
}

export interface WhisperCppProviderOptions {
  readonly executable: WhisperCppExecutable;
  readonly modelLocator: WhisperCppModelLocator;
  readonly processRunner?: WhisperCppProcessRunner;
  readonly temporaryDirectory: string;
}

export class WhisperCppTranscriptionProvider implements TranscriptionProvider {
  public readonly displayName = 'whisper.cpp';
  public readonly id = 'whisper-cpp';
  private readonly processRunner: WhisperCppProcessRunner;
  private readonly temporaryDirectory: string;

  public constructor(private readonly options: WhisperCppProviderOptions) {
    this.temporaryDirectory = assertAbsolute(
      options.temporaryDirectory,
      'whisper.cpp temporary directory',
    );
    this.processRunner = options.processRunner ?? new WhisperCppProcessRunner();
  }

  public async capabilities() {
    return { cancellation: true, wordTimestamps: false } as const;
  }

  public async transcribe(
    request: TranscriptionRequest,
    context: Parameters<TranscriptionProvider['transcribe']>[1],
  ): Promise<TranscriptionResult> {
    if (context.signal.aborted)
      throw new WhisperCppError('WHISPER_CPP_CANCELLED', 'Transcription was cancelled.', false);
    const audioPath = assertAbsolute(request.audioPath, 'Transcription audio path');
    await assertRegularFile(audioPath, 'Transcription audio');
    const modelPath = await this.options.modelLocator.locate(request.model);
    await mkdir(this.temporaryDirectory, { recursive: true });
    const workspace = await mkdtemp(join(this.temporaryDirectory, 'whisper-cpp-'));
    try {
      const command = compileWhisperCppCommand({
        argsPrefix: this.options.executable.argsPrefix,
        executable: this.options.executable.path,
        modelPath,
        outputPrefix: join(workspace, 'transcript'),
        request: { ...request, audioPath },
      });
      await this.processRunner.run(command, {
        signal: context.signal,
        ...(context.onProgress === undefined ? {} : { onProgress: context.onProgress }),
      });
      let output: string;
      try {
        const details = await lstat(command.outputJsonPath);
        if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_JSON_OUTPUT_BYTES)
          throw new Error();
        output = await readFile(command.outputJsonPath, 'utf8');
      } catch {
        throw new WhisperCppError(
          'WHISPER_CPP_OUTPUT_INVALID',
          'whisper.cpp did not produce a usable JSON transcript.',
          false,
        );
      }
      return parseWhisperCppOutput(output);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  public async stop(): Promise<void> {
    await this.processRunner.stop();
  }
}
