import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { LocalFileInspector, MediaProbe, MediaProbeMetadata } from '@openrepurpose/core';

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
