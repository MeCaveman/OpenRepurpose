import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileTransformCommand, FfprobeMediaProbe } from '@openrepurpose/media';

describe('FFmpeg transform command builder', () => {
  it('compiles normalized trim, crop, audio, and encode intent to a stable argument vector', () => {
    const command = compileTransformCommand({
      executable: 'ffmpeg-custom',
      inputPath: 'C:\\Media Files\\مقطع;not-a-command.mp4',
      outputPath: 'C:\\Output Files\\vertical.mp4',
      plan: {
        user: {
          steps: [
            { type: 'trim', startMs: 1_000, durationMs: 2_000 },
            { type: 'fit', mode: 'crop', width: 1_080, height: 1_920, anchor: 'top' },
            { type: 'audio', mode: 'gain', gainDb: -3 },
          ],
          output: { crf: 20, preset: 'fast', maxFrameRate: 30 },
        },
      },
    });

    expect(command).toMatchInlineSnapshot(`
      {
        "args": [
          "-hide_banner",
          "-nostdin",
          "-nostats",
          "-progress",
          "pipe:1",
          "-y",
          "-i",
          "C:\\Media Files\\مقطع;not-a-command.mp4",
          "-filter_complex",
          "[0:v:0]trim=start=1:duration=2,setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(in_w-out_w)/2:0[vout];[0:a:0]atrim=start=1:duration=2,asetpts=PTS-STARTPTS,volume=-3dB[aout]",
          "-map",
          "[vout]",
          "-map",
          "[aout]",
          "-c:v",
          "libx264",
          "-profile:v",
          "baseline",
          "-preset",
          "fast",
          "-crf",
          "20",
          "-pix_fmt",
          "yuv420p",
          "-r",
          "30",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-ar",
          "48000",
          "-movflags",
          "+faststart",
          "C:\\Output Files\\vertical.mp4",
        ],
        "executable": "ffmpeg-custom",
      }
    `);
  });

  it('keeps watermark paths and command-looking input text as individual arguments', () => {
    const command = compileTransformCommand({
      inputPath: 'source; echo unsafe.mp4',
      outputPath: 'output.mp4',
      watermarkPaths: { mark: 'C:\\Images\\brand mark;still-safe.png' },
      plan: { user: { steps: [{ type: 'watermark', assetId: 'mark', scalePercent: 25 }] } },
    });
    expect(command.args).toContain('source; echo unsafe.mp4');
    expect(command.args).toContain('C:\\Images\\brand mark;still-safe.png');
    expect(command.args).not.toContain('source; echo unsafe.mp4 -i');
    expect(command.args).toContain('-loop');
    expect(command.args).toContain('1');
    const filterComplex = command.args[command.args.indexOf('-filter_complex') + 1];
    expect(filterComplex).toContain('overlay=main_w-overlay_w-24:24:format=auto:shortest=1');
    expect(() =>
      compileTransformCommand({
        inputPath: 'source.mp4',
        outputPath: 'output.mp4',
        plan: { user: { steps: [{ type: 'watermark', assetId: 'missing' }] } },
      }),
    ).toThrow('No local path');
  });

  it('omits audio mapping and encoding for a probe-confirmed silent source', () => {
    const command = compileTransformCommand({
      inputPath: 'silent.mp4',
      outputPath: 'silent-output.mp4',
      sourceHasAudio: false,
      plan: { user: { steps: [{ type: 'audio', mode: 'normalize' }] } },
    });
    expect(command.args).toContain('-an');
    expect(command.args).not.toContain('-c:a');
    expect(command.args).not.toContain('0:a:0?');
  });

  it('maps an unfiltered input video as a stream specifier rather than a filter label', () => {
    const command = compileTransformCommand({
      inputPath: 'variable-rate.mp4',
      outputPath: 'capped.mp4',
      sourceHasAudio: false,
      plan: { user: { steps: [], output: { maxFrameRate: 30 } } },
    });
    const mapIndex = command.args.indexOf('-map');
    expect(command.args[mapIndex + 1]).toBe('0:v:0');
    expect(command.args).not.toContain('[0:v:0]');
  });

  it('keeps preserve, normalize, gain, and remove-audio semantics deterministic', () => {
    const normalized = compileTransformCommand({
      inputPath: 'source.mp4',
      outputPath: 'normalized.mp4',
      plan: {
        user: {
          steps: [
            { type: 'audio', mode: 'preserve' },
            { type: 'audio', mode: 'normalize' },
            { type: 'audio', mode: 'gain', gainDb: 2.5 },
          ],
        },
      },
    });
    const normalizedGraph = normalized.args[normalized.args.indexOf('-filter_complex') + 1];
    expect(normalizedGraph).toContain('loudnorm=I=-14:TP=-1.5:LRA=11,volume=2.5dB');
    expect(normalized.args).toContain('[aout]');
    expect(normalized.args).toContain('aac');

    const removed = compileTransformCommand({
      inputPath: 'source.mp4',
      outputPath: 'muted.mp4',
      plan: { user: { steps: [{ type: 'audio', mode: 'remove' }] } },
    });
    expect(removed.args).toContain('-an');
    expect(removed.args).not.toContain('0:a:0?');
    expect(removed.args).not.toContain('-c:a');
  });

  it.each([
    [
      'center crop',
      { type: 'fit' as const, mode: 'crop' as const, width: 1080, height: 1920 },
      'crop=1080:1920:(in_w-out_w)/2:(in_h-out_h)/2',
    ],
    [
      'top crop',
      {
        type: 'fit' as const,
        mode: 'crop' as const,
        width: 1080,
        height: 1920,
        anchor: 'top' as const,
      },
      'crop=1080:1920:(in_w-out_w)/2:0',
    ],
    [
      'bottom crop',
      {
        type: 'fit' as const,
        mode: 'crop' as const,
        width: 1080,
        height: 1920,
        anchor: 'bottom' as const,
      },
      'crop=1080:1920:(in_w-out_w)/2:in_h-out_h',
    ],
    [
      'left crop',
      {
        type: 'fit' as const,
        mode: 'crop' as const,
        width: 1080,
        height: 1920,
        anchor: 'left' as const,
      },
      'crop=1080:1920:0:(in_h-out_h)/2',
    ],
    [
      'right crop',
      {
        type: 'fit' as const,
        mode: 'crop' as const,
        width: 1080,
        height: 1920,
        anchor: 'right' as const,
      },
      'crop=1080:1920:in_w-out_w:(in_h-out_h)/2',
    ],
    [
      'contain',
      {
        type: 'fit' as const,
        mode: 'contain' as const,
        width: 1080,
        height: 1920,
        backgroundColor: '#112233',
      },
      'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=#112233',
    ],
    [
      'stretch',
      { type: 'fit' as const, mode: 'stretch' as const, width: 1080, height: 1920 },
      'scale=1080:1920',
    ],
  ])('compiles %s fitting deterministically', (_name, step, expectedFilter) => {
    const command = compileTransformCommand({
      inputPath: 'source.mp4',
      outputPath: 'output.mp4',
      plan: { user: { steps: [step] } },
    });
    const filterComplex = command.args[command.args.indexOf('-filter_complex') + 1];
    expect(filterComplex).toContain(expectedFilter);
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { shell: false }).status === 0;
const integration = hasFfmpeg ? it : it.skip;

describe('FFmpeg transform command integration', () => {
  const directories: string[] = [];
  afterEach(async () =>
    Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    ),
  );

  integration('produces a tiny cropped MP4 that ffprobe confirms', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openrepurpose-ffmpeg-'));
    directories.push(directory);
    const source = join(directory, 'tiny source.mp4');
    const outputDirectory = join(directory, 'output folder');
    mkdirSync(outputDirectory);
    const output = join(outputDirectory, 'vertical.mp4');
    runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880',
      '-t',
      '1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      source,
    ]);
    const command = compileTransformCommand({
      inputPath: source,
      outputPath: output,
      sourceHasAudio: true,
      plan: {
        user: {
          steps: [
            { type: 'trim', startMs: 100, durationMs: 500 },
            { type: 'fit', mode: 'crop', width: 120, height: 160 },
          ],
          output: { crf: 28, preset: 'ultrafast' },
        },
      },
    });
    runFfmpeg(command.args);
    const metadata = await new FfprobeMediaProbe('ffprobe').probe(output);
    expect(metadata).toMatchObject({
      width: 120,
      height: 160,
      videoCodec: 'h264',
      audioCodec: 'aac',
      hasAudio: true,
    });
    expect(metadata.durationSeconds).toBeGreaterThan(0.35);
    expect(metadata.durationSeconds).toBeLessThan(0.7);
  });

  integration('applies a looped image watermark while normalizing and gaining audio', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openrepurpose-ffmpeg-'));
    directories.push(directory);
    const source = join(directory, 'source.mp4');
    const watermark = join(directory, 'brand mark.bmp');
    const output = join(directory, 'watermarked.mp4');
    runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x120:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880',
      '-t',
      '1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      source,
    ]);
    runFfmpeg(['-f', 'lavfi', '-i', 'color=c=white:size=40x20', '-frames:v', '1', watermark]);
    const command = compileTransformCommand({
      inputPath: source,
      outputPath: output,
      sourceHasAudio: true,
      watermarkPaths: { watermark },
      plan: {
        user: {
          steps: [
            { type: 'audio', mode: 'normalize' },
            { type: 'audio', mode: 'gain', gainDb: -2 },
            { type: 'watermark', assetId: 'watermark', position: 'bottom-right' },
          ],
          output: { crf: 28, preset: 'ultrafast' },
        },
      },
    });
    runFfmpeg(command.args);
    await expect(new FfprobeMediaProbe('ffprobe').probe(output)).resolves.toMatchObject({
      audioCodec: 'aac',
      hasAudio: true,
      height: 120,
      videoCodec: 'h264',
      width: 160,
    });
  });
});

function runFfmpeg(args: readonly string[]): void {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], {
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) throw new Error(result.stderr || 'FFmpeg failed.');
}
