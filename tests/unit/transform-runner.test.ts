import { spawnSync } from 'node:child_process';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createTransformCacheIdentity,
  type JobHandlerContext,
  type MediaAsset,
  type TransformProgress,
} from '@openrepurpose/core';
import { SqliteMediaRepository, SqliteTransformDerivativeRepository } from '@openrepurpose/db';
import {
  FfmpegProcessRunner,
  FfmpegProgressParser,
  FfprobeMediaProbe,
  LocalTransformOutputStorage,
  TransformJobHandler,
  TransformProcessError,
  TransformRecoveryService,
  type RunFfmpegOptions,
  type TransformProcessRunner,
} from '@openrepurpose/media';
import { createTemporaryDatabase } from '@openrepurpose/testkit';

function sourceAsset(path: string): MediaAsset {
  return {
    id: 'source-media',
    path,
    fingerprint: 'sha256:source',
    sizeBytes: 128,
    modifiedAt: new Date(1),
    createdAt: new Date(1),
    state: 'available',
    metadata: {
      durationSeconds: 2,
      frameRate: 24,
      hasAudio: true,
      height: 240,
      videoCodec: 'h264',
      width: 320,
    },
  };
}

function watermarkAsset(path: string, state: MediaAsset['state'] = 'available'): MediaAsset {
  return {
    id: 'watermark-media',
    path,
    fingerprint: 'sha256:watermark',
    sizeBytes: 64,
    modifiedAt: new Date(1),
    createdAt: new Date(1),
    state,
    metadata: { hasAudio: false },
  };
}

function identity() {
  return createTransformCacheIdentity({
    sourceFingerprint: 'sha256:source',
    plan: { user: { steps: [{ type: 'trim', startMs: 0, durationMs: 1_000 }] } },
    outputProfileVersion: 'common-mp4-v1',
    tool: { encoder: 'libx264', ffmpegVersion: '8.0.1' },
  });
}

function context(signal: AbortSignal = new AbortController().signal): JobHandlerContext {
  return { attemptNumber: 1, jobId: 'job-transform', signal };
}

describe('transform derivative repository', () => {
  it('atomically reserves one cache identity and persists progress and a completed output', () => {
    const fixture = createTemporaryDatabase();
    try {
      const media = new SqliteMediaRepository(fixture.database);
      media.create(sourceAsset(join(fixture.directory, 'source.mp4')));
      const repository = new SqliteTransformDerivativeRepository(fixture.database);
      const first = repository.reserve({
        id: 'derivative-a',
        identity: identity(),
        sourceMediaId: 'source-media',
        now: new Date(10),
      });
      const second = repository.reserve({
        id: 'derivative-b',
        identity: identity(),
        sourceMediaId: 'source-media',
        now: new Date(11),
      });

      expect(first.created).toBe(true);
      expect(second).toMatchObject({ created: false, derivative: { id: 'derivative-a' } });
      repository.markRunning('derivative-a', new Date(20));
      expect(
        repository.updateProgress(
          'derivative-a',
          { frame: 12, outTimeMillis: 500, percent: 50, speed: 1.2 },
          new Date(30),
        ),
      ).toBe(true);
      expect(repository.findById('derivative-a')?.progress).toEqual({
        frame: 12,
        outTimeMillis: 500,
        percent: 50,
        speed: 1.2,
      });
      repository.complete(
        'derivative-a',
        {
          path: join(fixture.directory, 'output.mp4'),
          sizeBytes: 99,
          metadata: {
            audioCodec: 'aac',
            durationMillis: 1_000,
            frameRate: 24,
            hasAudio: true,
            height: 160,
            videoCodec: 'h264',
            width: 120,
          },
        },
        new Date(40),
      );
      expect(repository.findById('derivative-a')).toMatchObject({
        status: 'succeeded',
        output: { sizeBytes: 99, metadata: { width: 120, height: 160 } },
      });
      expect(repository.findById('derivative-a')?.progress).toBeUndefined();
    } finally {
      fixture.dispose();
    }
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { shell: false }).status === 0;
const ffmpegIntegration = hasFfmpeg ? it : it.skip;

describe('transform worker FFmpeg integration', () => {
  ffmpegIntegration(
    'executes, reports progress, probes, and finalizes a tiny derivative',
    async () => {
      const fixture = createTemporaryDatabase();
      try {
        const sourcePath = join(fixture.directory, 'tiny source.mp4');
        const generated = spawnSync(
          'ffmpeg',
          [
            '-hide_banner',
            '-nostdin',
            '-y',
            '-f',
            'lavfi',
            '-i',
            'testsrc=size=160x120:rate=12',
            '-t',
            '0.5',
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            sourcePath,
          ],
          { encoding: 'utf8', shell: false },
        );
        if (generated.status !== 0)
          throw new Error(generated.stderr || 'Fixture generation failed.');
        const details = await stat(sourcePath);
        const media = new SqliteMediaRepository(fixture.database);
        media.create({
          ...sourceAsset(sourcePath),
          sizeBytes: details.size,
          metadata: {
            durationSeconds: 0.5,
            frameRate: 12,
            hasAudio: false,
            height: 120,
            videoCodec: 'h264',
            width: 160,
          },
        });
        const derivatives = new SqliteTransformDerivativeRepository(fixture.database);
        derivatives.reserve({
          id: 'derivative-real',
          identity: identity(),
          sourceMediaId: 'source-media',
          now: new Date(),
        });
        const processes = new FfmpegProcessRunner({
          killGraceMs: 500,
          stallTimeoutMs: 10_000,
          timeoutMs: 30_000,
        });
        const handler = new TransformJobHandler(
          derivatives,
          media,
          new LocalTransformOutputStorage(fixture.directory),
          processes,
          new FfprobeMediaProbe('ffprobe'),
          'ffmpeg',
        );
        await handler.execute({ derivativeId: 'derivative-real' }, context());
        expect(derivatives.findById('derivative-real')).toMatchObject({
          status: 'succeeded',
          output: { metadata: { hasAudio: false, videoCodec: 'h264' } },
        });
        await processes.stop();
      } finally {
        fixture.dispose();
      }
    },
  );
});

describe('FFmpeg progress and process lifecycle', () => {
  it('parses structured progress without relying on human stderr output', () => {
    const snapshots: TransformProgress[] = [];
    const parser = new FfmpegProgressParser(2_000, (progress) => snapshots.push(progress));
    parser.push('frame=24\nfps=48.0\ntotal_size=4096\nout_time_us=1000000\n');
    parser.push('speed=2.0x\nprogress=continue\n');
    expect(snapshots).toEqual([
      {
        frame: 24,
        framesPerSecond: 48,
        outTimeMillis: 1_000,
        percent: 50,
        processedBytes: 4_096,
        speed: 2,
      },
    ]);
  });

  it('runs without a shell, emits progress, and terminates a stalled child', async () => {
    const progress: TransformProgress[] = [];
    const runner = new FfmpegProcessRunner({
      killGraceMs: 20,
      stallTimeoutMs: 500,
      timeoutMs: 2_000,
    });
    await runner.run(
      {
        executable: process.execPath,
        args: ['-e', "process.stdout.write('frame=1\\nout_time_us=250000\\nprogress=end\\n')"],
      },
      {
        signal: new AbortController().signal,
        expectedDurationMillis: 500,
        onProgress: (snapshot) => progress.push(snapshot),
      },
    );
    expect(progress[0]).toMatchObject({ frame: 1, outTimeMillis: 250, percent: 50 });

    const stalled = new FfmpegProcessRunner({
      killGraceMs: 20,
      stallTimeoutMs: 40,
      timeoutMs: 2_000,
    });
    await expect(
      stalled.run(
        { executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: 'TRANSFORM_STALLED' });
    await stalled.stop();
  });

  it('cooperatively cancels and cleans up a live child', async () => {
    const runner = new FfmpegProcessRunner({
      killGraceMs: 20,
      stallTimeoutMs: 2_000,
      timeoutMs: 2_000,
    });
    const controller = new AbortController();
    const running = runner.run(
      { executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 30);
    await expect(running).rejects.toMatchObject({ code: 'TRANSFORM_CANCELLED' });
    await runner.stop();
  });

  it('enforces an absolute timeout and cleans children during shutdown', async () => {
    const timed = new FfmpegProcessRunner({
      killGraceMs: 20,
      stallTimeoutMs: 500,
      timeoutMs: 60,
    });
    await expect(
      timed.run(
        {
          executable: process.execPath,
          args: [
            '-e',
            "setInterval(() => process.stdout.write('out_time_us=1\\nprogress=continue\\n'), 10)",
          ],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: 'TRANSFORM_TIMEOUT' });

    const stopping = new FfmpegProcessRunner({
      killGraceMs: 20,
      stallTimeoutMs: 2_000,
      timeoutMs: 2_000,
    });
    const running = stopping.run(
      { executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
      { signal: new AbortController().signal },
    );
    const shutdownResult = expect(running).rejects.toMatchObject({
      code: 'TRANSFORM_SHUTDOWN',
    });
    await stopping.stop();
    await shutdownResult;
  });
});

class WritingProcessRunner implements TransformProcessRunner {
  public calls = 0;
  public command?: { readonly args: readonly string[] };
  public async run(command: { readonly args: readonly string[] }, options: RunFfmpegOptions) {
    this.calls += 1;
    this.command = command;
    const outputPath = command.args.at(-1);
    if (outputPath === undefined) throw new Error('Missing output path.');
    options.onProgress?.({ outTimeMillis: 500, percent: 50 });
    await writeFile(outputPath, 'transformed');
  }
  public async stop(): Promise<void> {}
}

describe('transform job execution and recovery', () => {
  it('resolves a managed image watermark to looped FFmpeg input arguments', async () => {
    const fixture = createTemporaryDatabase();
    try {
      const sourcePath = join(fixture.directory, 'source.mp4');
      const watermarkPath = join(fixture.directory, 'brand mark.png');
      await Promise.all([writeFile(sourcePath, 'source'), writeFile(watermarkPath, 'watermark')]);
      const media = new SqliteMediaRepository(fixture.database);
      media.create(sourceAsset(sourcePath));
      media.create(watermarkAsset(watermarkPath));
      const derivatives = new SqliteTransformDerivativeRepository(fixture.database);
      const watermarkIdentity = createTransformCacheIdentity({
        sourceFingerprint: 'sha256:source',
        plan: { user: { steps: [{ type: 'watermark', assetId: 'watermark-media' }] } },
        outputProfileVersion: 'common-mp4-v1',
        tool: { encoder: 'libx264', ffmpegVersion: '8.0.1' },
      });
      derivatives.reserve({
        id: 'derivative-watermark',
        identity: watermarkIdentity,
        sourceMediaId: 'source-media',
        now: new Date(),
      });
      const processes = new WritingProcessRunner();
      const handler = new TransformJobHandler(
        derivatives,
        media,
        new LocalTransformOutputStorage(fixture.directory),
        processes,
        {
          probe: async () => ({
            audioCodec: 'aac',
            durationSeconds: 1,
            hasAudio: true,
            height: 240,
            videoCodec: 'h264',
            width: 320,
          }),
        },
        'ffmpeg',
      );

      await handler.execute({ derivativeId: 'derivative-watermark' }, context());
      expect(processes.command?.args).toContain(watermarkPath);
      expect(processes.command?.args).toContain('-loop');
      expect(processes.command?.args).toContain('1');
    } finally {
      fixture.dispose();
    }
  });

  it('rejects unavailable or non-image watermark assets before spawning FFmpeg', async () => {
    const fixture = createTemporaryDatabase();
    try {
      const sourcePath = join(fixture.directory, 'source.mp4');
      await writeFile(sourcePath, 'source');
      const media = new SqliteMediaRepository(fixture.database);
      media.create(sourceAsset(sourcePath));
      media.create(watermarkAsset(join(fixture.directory, 'brand.mp4')));
      const derivatives = new SqliteTransformDerivativeRepository(fixture.database);
      const watermarkIdentity = createTransformCacheIdentity({
        sourceFingerprint: 'sha256:source',
        plan: { user: { steps: [{ type: 'watermark', assetId: 'watermark-media' }] } },
        outputProfileVersion: 'common-mp4-v1',
        tool: { encoder: 'libx264', ffmpegVersion: '8.0.1' },
      });
      derivatives.reserve({
        id: 'derivative-bad-watermark',
        identity: watermarkIdentity,
        sourceMediaId: 'source-media',
        now: new Date(),
      });
      const processes = new WritingProcessRunner();
      const handler = new TransformJobHandler(
        derivatives,
        media,
        new LocalTransformOutputStorage(fixture.directory),
        processes,
        { probe: async () => ({ hasAudio: false }) },
        'ffmpeg',
      );

      await expect(
        handler.execute({ derivativeId: 'derivative-bad-watermark' }, context()),
      ).rejects.toMatchObject({ code: 'WATERMARK_ASSET_INVALID' });
      expect(processes.calls).toBe(0);
      expect(derivatives.findById('derivative-bad-watermark')).toMatchObject({
        errorCode: 'WATERMARK_ASSET_INVALID',
        status: 'failed',
      });
    } finally {
      fixture.dispose();
    }
  });

  it('writes a partial file, probes it, atomically finalizes it, and reuses valid success', async () => {
    const fixture = createTemporaryDatabase();
    try {
      const sourcePath = join(fixture.directory, 'source.mp4');
      await writeFile(sourcePath, 'source');
      const media = new SqliteMediaRepository(fixture.database);
      media.create(sourceAsset(sourcePath));
      const derivatives = new SqliteTransformDerivativeRepository(fixture.database);
      derivatives.reserve({
        id: 'derivative-run',
        identity: identity(),
        sourceMediaId: 'source-media',
        now: new Date(),
      });
      const storage = new LocalTransformOutputStorage(fixture.directory);
      const processes = new WritingProcessRunner();
      const handler = new TransformJobHandler(
        derivatives,
        media,
        storage,
        processes,
        {
          probe: async () => ({
            audioCodec: 'aac',
            durationSeconds: 1,
            frameRate: 24,
            hasAudio: true,
            height: 240,
            videoCodec: 'h264',
            width: 320,
          }),
        },
        'ffmpeg',
      );

      await handler.execute({ derivativeId: 'derivative-run' }, context());
      const completed = derivatives.findById('derivative-run');
      expect(completed).toMatchObject({
        status: 'succeeded',
        output: { metadata: { durationMillis: 1_000 }, sizeBytes: 11 },
      });
      await expect(access(completed!.output!.path)).resolves.toBeUndefined();
      await handler.execute({ derivativeId: 'derivative-run' }, context());
      expect(processes.calls).toBe(1);
      await writeFile(completed!.output!.path, 'changed-size');
      await handler.execute({ derivativeId: 'derivative-run' }, context());
      expect(processes.calls).toBe(2);
    } finally {
      fixture.dispose();
    }
  });

  it('rejects a probe result that does not meet the H.264/AAC output contract', async () => {
    const fixture = createTemporaryDatabase();
    try {
      const sourcePath = join(fixture.directory, 'source.mp4');
      await writeFile(sourcePath, 'source');
      const media = new SqliteMediaRepository(fixture.database);
      media.create(sourceAsset(sourcePath));
      const derivatives = new SqliteTransformDerivativeRepository(fixture.database);
      derivatives.reserve({
        id: 'derivative-wrong-codec',
        identity: identity(),
        sourceMediaId: 'source-media',
        now: new Date(),
      });
      const handler = new TransformJobHandler(
        derivatives,
        media,
        new LocalTransformOutputStorage(fixture.directory),
        new WritingProcessRunner(),
        {
          probe: async () => ({
            audioCodec: 'aac',
            durationSeconds: 1,
            hasAudio: true,
            height: 240,
            videoCodec: 'vp9',
            width: 320,
          }),
        },
        'ffmpeg',
      );

      await expect(
        handler.execute({ derivativeId: 'derivative-wrong-codec' }, context()),
      ).rejects.toMatchObject({ code: 'TRANSFORM_OUTPUT_INVALID' });
      expect(derivatives.findById('derivative-wrong-codec')).toMatchObject({
        errorCode: 'TRANSFORM_OUTPUT_INVALID',
        status: 'failed',
      });
    } finally {
      fixture.dispose();
    }
  });

  it('marks interrupted work failed and removes its partial output during recovery', async () => {
    const fixture = createTemporaryDatabase();
    try {
      const media = new SqliteMediaRepository(fixture.database);
      media.create(sourceAsset(join(fixture.directory, 'source.mp4')));
      const derivatives = new SqliteTransformDerivativeRepository(fixture.database);
      derivatives.reserve({
        id: 'derivative-crashed',
        identity: identity(),
        sourceMediaId: 'source-media',
        now: new Date(1),
      });
      derivatives.markRunning('derivative-crashed', new Date(2));
      const storage = new LocalTransformOutputStorage(fixture.directory);
      const outputDirectory = join(storage.root, 'derivative-crashed');
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(join(outputDirectory, 'output.partial.mp4'), 'partial');

      const result = await new TransformRecoveryService(
        derivatives,
        storage,
        () => new Date(10),
        0,
      ).recover();
      expect(result.interrupted).toBe(1);
      expect(derivatives.findById('derivative-crashed')).toMatchObject({
        errorCode: 'TRANSFORM_INTERRUPTED',
        status: 'failed',
      });
      await expect(access(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      fixture.dispose();
    }
  });

  it('persists cancellation and discards partial output', async () => {
    const fixture = createTemporaryDatabase();
    try {
      const sourcePath = join(fixture.directory, 'source.mp4');
      await writeFile(sourcePath, 'source');
      const media = new SqliteMediaRepository(fixture.database);
      media.create(sourceAsset(sourcePath));
      const derivatives = new SqliteTransformDerivativeRepository(fixture.database);
      derivatives.reserve({
        id: 'derivative-cancel',
        identity: identity(),
        sourceMediaId: 'source-media',
        now: new Date(),
      });
      const storage = new LocalTransformOutputStorage(fixture.directory);
      const cancelling: TransformProcessRunner = {
        run: async () => {
          throw new TransformProcessError('TRANSFORM_CANCELLED', 'Transform was cancelled.', false);
        },
        stop: async () => undefined,
      };
      const handler = new TransformJobHandler(
        derivatives,
        media,
        storage,
        cancelling,
        { probe: async () => ({ hasAudio: false }) },
        'ffmpeg',
      );
      await expect(
        handler.execute({ derivativeId: 'derivative-cancel' }, context()),
      ).rejects.toMatchObject({ code: 'TRANSFORM_CANCELLED' });
      expect(derivatives.findById('derivative-cancel')?.status).toBe('cancelled');
    } finally {
      fixture.dispose();
    }
  });
});
