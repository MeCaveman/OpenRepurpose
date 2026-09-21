import { spawnSync } from 'node:child_process';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JobService,
  TransformService,
  createTransformCacheIdentity,
  type JobHandlerContext,
  type MediaAsset,
  type MediaProbeMetadata,
  type TransformPlanInput,
} from '@openrepurpose/core';
import {
  SqliteJobRepository,
  SqliteMediaRepository,
  SqliteTransformDerivativeRepository,
} from '@openrepurpose/db';
import {
  FfmpegProcessRunner,
  FfprobeMediaProbe,
  LocalTransformOutputStorage,
  TransformJobHandler,
  TransformProcessError,
  TransformRecoveryService,
  type TransformOutputStorage,
  type TransformProcessRunner,
} from '@openrepurpose/media';
import { createTemporaryDatabase } from '@openrepurpose/testkit';

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { shell: false }).status === 0;
const ffmpegTest = ffmpegAvailable ? it : it.skip;

const fastOutput = { crf: 32, preset: 'ultrafast' as const };

function jobContext(signal: AbortSignal = new AbortController().signal): JobHandlerContext {
  return { attemptNumber: 1, jobId: 'stress-transform-job', signal };
}

function cacheIdentity(sourceFingerprint: string, plan: TransformPlanInput) {
  return createTransformCacheIdentity({
    sourceFingerprint,
    plan,
    outputProfileVersion: 'common-mp4-v1',
    tool: { encoder: 'libx264', ffmpegVersion: 'stress-test' },
  });
}

function mediaAsset(input: {
  readonly fingerprint: string;
  readonly id: string;
  readonly metadata: MediaProbeMetadata;
  readonly path: string;
  readonly sizeBytes: number;
}): MediaAsset {
  return {
    ...input,
    createdAt: new Date(1),
    modifiedAt: new Date(1),
    state: 'available',
  };
}

function runFfmpeg(args: readonly string[]): void {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], {
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) throw new Error(result.stderr || 'FFmpeg fixture generation failed.');
}

function createSource(
  path: string,
  input: {
    readonly audio: boolean;
    readonly height: number;
    readonly rate?: number;
    readonly width: number;
  },
): void {
  const rate = input.rate ?? 24;
  runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${input.width}x${input.height}:rate=${rate}:duration=0.8`,
    ...(input.audio
      ? ['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=0.8']
      : []),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    ...(input.audio ? ['-c:a', 'aac', '-shortest'] : ['-an']),
    path,
  ]);
}

async function executeRealTransform(input: {
  readonly derivativeId: string;
  readonly mediaId: string;
  readonly plan: TransformPlanInput;
  readonly sourcePath: string;
  readonly storageDirectory: string;
}) {
  const fixture = createTemporaryDatabase();
  const processes = new FfmpegProcessRunner({
    killGraceMs: 500,
    stallTimeoutMs: 20_000,
    timeoutMs: 60_000,
  });
  try {
    const probe = new FfprobeMediaProbe('ffprobe');
    const sourceMetadata = await probe.probe(input.sourcePath);
    const sourceDetails = await stat(input.sourcePath);
    const fingerprint = `sha256:${input.mediaId}`;
    const media = new SqliteMediaRepository(fixture.database);
    media.create(
      mediaAsset({
        fingerprint,
        id: input.mediaId,
        metadata: sourceMetadata,
        path: input.sourcePath,
        sizeBytes: sourceDetails.size,
      }),
    );
    const derivatives = new SqliteTransformDerivativeRepository(fixture.database);
    derivatives.reserve({
      id: input.derivativeId,
      identity: cacheIdentity(fingerprint, input.plan),
      sourceMediaId: input.mediaId,
      now: new Date(2),
    });
    const handler = new TransformJobHandler(
      derivatives,
      media,
      new LocalTransformOutputStorage(input.storageDirectory),
      processes,
      probe,
      'ffmpeg',
    );
    await handler.execute({ derivativeId: input.derivativeId }, jobContext());
    const derivative = derivatives.findById(input.derivativeId);
    if (derivative?.output === undefined) throw new Error('Transform output was not persisted.');
    return { derivative, outputMetadata: await probe.probe(derivative.output.path) };
  } finally {
    await processes.stop();
    fixture.dispose();
  }
}

describe('transform stress and correctness', () => {
  ffmpegTest(
    'handles shell-looking spaces and Unicode paths for portrait and landscape sources',
    async () => {
      const fixture = createTemporaryDatabase();
      try {
        const sourceDirectory = join(fixture.directory, 'source folder – مسار 测试');
        const storageDirectory = join(fixture.directory, 'output folder – نتائج 输出');
        await Promise.all([
          mkdir(sourceDirectory, { recursive: true }),
          mkdir(storageDirectory, { recursive: true }),
        ]);
        const cases = [
          {
            derivativeId: 'landscape-to-portrait',
            dimensions: { height: 120, width: 200 },
            expected: { height: 160, width: 120 },
            file: 'clip ; $(echo nope) – أفقي 横向.mp4',
          },
          {
            derivativeId: 'portrait-to-landscape',
            dimensions: { height: 200, width: 120 },
            expected: { height: 120, width: 160 },
            file: 'clip & whoami – عمودي 纵向.mp4',
          },
        ] as const;

        for (const testCase of cases) {
          const sourcePath = join(sourceDirectory, testCase.file);
          createSource(sourcePath, { ...testCase.dimensions, audio: true });
          const result = await executeRealTransform({
            derivativeId: testCase.derivativeId,
            mediaId: `media-${testCase.derivativeId}`,
            plan: {
              user: {
                steps: [{ type: 'fit', mode: 'crop', ...testCase.expected }],
                output: fastOutput,
              },
            },
            sourcePath,
            storageDirectory,
          });
          expect(result.derivative.status).toBe('succeeded');
          expect(result.outputMetadata).toMatchObject({
            ...testCase.expected,
            audioCodec: 'aac',
            hasAudio: true,
            videoCodec: 'h264',
          });
        }
      } finally {
        fixture.dispose();
      }
    },
    120_000,
  );

  ffmpegTest('transforms a no-audio source without inventing an audio stream', async () => {
    const fixture = createTemporaryDatabase();
    try {
      const sourcePath = join(fixture.directory, 'silent portrait.mp4');
      createSource(sourcePath, { audio: false, height: 180, width: 100 });
      const result = await executeRealTransform({
        derivativeId: 'silent-derivative',
        mediaId: 'silent-source',
        plan: {
          user: {
            steps: [{ type: 'fit', mode: 'contain', width: 160, height: 120 }],
            output: fastOutput,
          },
        },
        sourcePath,
        storageDirectory: fixture.directory,
      });
      expect(result.outputMetadata).toMatchObject({
        hasAudio: false,
        height: 120,
        videoCodec: 'h264',
        width: 160,
      });
      expect(result.outputMetadata.audioCodec).toBeUndefined();
    } finally {
      fixture.dispose();
    }
  });

  ffmpegTest(
    'accepts variable-frame-rate input and enforces the output frame-rate cap',
    async () => {
      const fixture = createTemporaryDatabase();
      try {
        const sourcePath = join(fixture.directory, 'variable frame rate.mp4');
        runFfmpeg([
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=160x120:rate=12:duration=0.6',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=160x120:rate=24:duration=0.6',
          '-filter_complex',
          '[0:v][1:v]concat=n=2:v=1:a=0[v]',
          '-map',
          '[v]',
          '-fps_mode',
          'vfr',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          sourcePath,
        ]);
        const result = await executeRealTransform({
          derivativeId: 'vfr-derivative',
          mediaId: 'vfr-source',
          plan: {
            user: {
              steps: [],
              output: { ...fastOutput, maxFrameRate: 15 },
            },
          },
          sourcePath,
          storageDirectory: fixture.directory,
        });
        expect(result.outputMetadata).toMatchObject({
          hasAudio: false,
          height: 120,
          videoCodec: 'h264',
          width: 160,
        });
        expect(result.outputMetadata.frameRate).toBeLessThanOrEqual(15.01);
      } finally {
        fixture.dispose();
      }
    },
  );

  ffmpegTest('fails corrupted input without publishing a partial derivative', async () => {
    const fixture = createTemporaryDatabase();
    const processes = new FfmpegProcessRunner({
      killGraceMs: 500,
      stallTimeoutMs: 10_000,
      timeoutMs: 30_000,
    });
    try {
      const sourcePath = join(fixture.directory, 'corrupt input.mp4');
      await writeFile(sourcePath, 'this is not an MP4');
      const media = new SqliteMediaRepository(fixture.database);
      media.create(
        mediaAsset({
          fingerprint: 'sha256:corrupt',
          id: 'corrupt-source',
          metadata: {
            durationSeconds: 1,
            frameRate: 24,
            hasAudio: false,
            height: 120,
            videoCodec: 'h264',
            width: 160,
          },
          path: sourcePath,
          sizeBytes: (await stat(sourcePath)).size,
        }),
      );
      const plan: TransformPlanInput = { user: { steps: [], output: fastOutput } };
      const derivatives = new SqliteTransformDerivativeRepository(fixture.database);
      derivatives.reserve({
        id: 'corrupt-derivative',
        identity: cacheIdentity('sha256:corrupt', plan),
        sourceMediaId: 'corrupt-source',
        now: new Date(1),
      });
      const storage = new LocalTransformOutputStorage(fixture.directory);
      const handler = new TransformJobHandler(
        derivatives,
        media,
        storage,
        processes,
        new FfprobeMediaProbe('ffprobe'),
        'ffmpeg',
      );

      await expect(
        handler.execute({ derivativeId: 'corrupt-derivative' }, jobContext()),
      ).rejects.toMatchObject({ code: 'TRANSFORM_PROCESS_EXIT' });
      const failed = derivatives.findById('corrupt-derivative');
      expect(failed).toMatchObject({
        errorCode: 'TRANSFORM_PROCESS_EXIT',
        status: 'failed',
      });
      expect(failed?.output).toBeUndefined();
      await expect(access(join(storage.root, 'corrupt-derivative'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await processes.stop();
      fixture.dispose();
    }
  });

  it('coalesces concurrent identical requests into one derivative and one durable job', async () => {
    const fixture = createTemporaryDatabase();
    try {
      const media = new SqliteMediaRepository(fixture.database);
      media.create(
        mediaAsset({
          fingerprint: 'sha256:shared',
          id: 'shared-source',
          metadata: { hasAudio: true },
          path: join(fixture.directory, 'shared.mp4'),
          sizeBytes: 100,
        }),
      );
      const derivatives = new SqliteTransformDerivativeRepository(fixture.database);
      const jobs = new JobService(new SqliteJobRepository(fixture.database), () => new Date(10));
      const transforms = new TransformService(
        media,
        derivatives,
        jobs,
        { encoder: 'libx264', ffmpegVersion: 'stress-test' },
        () => new Date(10),
      );
      const plan: TransformPlanInput = {
        user: { steps: [{ type: 'fit', mode: 'crop', width: 1080, height: 1920 }] },
      };

      const requests = await Promise.all(
        Array.from({ length: 32 }, async () => transforms.run('shared-source', plan)),
      );

      expect(new Set(requests.map((request) => request.derivative.id))).toHaveLength(1);
      expect(new Set(requests.map((request) => request.job?.id))).toHaveLength(1);
      expect(requests.filter((request) => request.cached)).toHaveLength(31);
      expect(derivatives.list()).toHaveLength(1);
      expect(jobs.list().filter((job) => job.type === 'media.transform')).toHaveLength(1);
    } finally {
      fixture.dispose();
    }
  });

  it('cancels after partial output is written and never exposes that output as complete', async () => {
    const fixture = createTemporaryDatabase();
    try {
      const sourcePath = join(fixture.directory, 'source.mp4');
      await writeFile(sourcePath, 'source');
      const media = new SqliteMediaRepository(fixture.database);
      media.create(
        mediaAsset({
          fingerprint: 'sha256:cancel',
          id: 'cancel-source',
          metadata: { durationSeconds: 2, hasAudio: false, height: 120, width: 160 },
          path: sourcePath,
          sizeBytes: 6,
        }),
      );
      const plan: TransformPlanInput = { user: { steps: [] } };
      const derivatives = new SqliteTransformDerivativeRepository(fixture.database);
      derivatives.reserve({
        id: 'cancel-derivative',
        identity: cacheIdentity('sha256:cancel', plan),
        sourceMediaId: 'cancel-source',
        now: new Date(1),
      });
      let started!: () => void;
      const partialWritten = new Promise<void>((resolve) => {
        started = resolve;
      });
      const process: TransformProcessRunner = {
        run: async (command, options) => {
          const outputPath = command.args.at(-1);
          if (outputPath === undefined) throw new Error('Missing output path.');
          await writeFile(outputPath, 'partial output');
          started();
          await new Promise<void>((_resolve, reject) => {
            const cancel = () =>
              reject(
                new TransformProcessError('TRANSFORM_CANCELLED', 'Transform was cancelled.', false),
              );
            if (options.signal.aborted) cancel();
            else options.signal.addEventListener('abort', cancel, { once: true });
          });
        },
        stop: async () => undefined,
      };
      const storage = new LocalTransformOutputStorage(fixture.directory);
      const handler = new TransformJobHandler(
        derivatives,
        media,
        storage,
        process,
        { probe: async () => ({ hasAudio: false }) },
        'ffmpeg',
      );
      const controller = new AbortController();
      const execution = handler.execute(
        { derivativeId: 'cancel-derivative' },
        jobContext(controller.signal),
      );
      await partialWritten;
      controller.abort();

      await expect(execution).rejects.toMatchObject({ code: 'TRANSFORM_CANCELLED' });
      const cancelled = derivatives.findById('cancel-derivative');
      expect(cancelled).toMatchObject({ status: 'cancelled' });
      expect(cancelled?.output).toBeUndefined();
      await expect(access(join(storage.root, 'cancel-derivative'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      fixture.dispose();
    }
  });

  it('persists a disk preparation error and does not start the encoder', async () => {
    const fixture = createTemporaryDatabase();
    try {
      const sourcePath = join(fixture.directory, 'source.mp4');
      await writeFile(sourcePath, 'source');
      const media = new SqliteMediaRepository(fixture.database);
      media.create(
        mediaAsset({
          fingerprint: 'sha256:disk',
          id: 'disk-source',
          metadata: { hasAudio: false },
          path: sourcePath,
          sizeBytes: 6,
        }),
      );
      const derivatives = new SqliteTransformDerivativeRepository(fixture.database);
      derivatives.reserve({
        id: 'disk-derivative',
        identity: cacheIdentity('sha256:disk', { user: { steps: [] } }),
        sourceMediaId: 'disk-source',
        now: new Date(1),
      });
      let processCalls = 0;
      let discardCalls = 0;
      const storage: TransformOutputStorage = {
        discard: async () => {
          discardCalls += 1;
        },
        finalize: async () => {
          throw new Error('Unexpected finalize.');
        },
        isUsableFile: async () => false,
        prepare: async () => {
          throw Object.assign(new Error('No space left on device.'), { code: 'ENOSPC' });
        },
        reconcileStale: async () => [],
      };
      const process: TransformProcessRunner = {
        run: async () => {
          processCalls += 1;
        },
        stop: async () => undefined,
      };
      const handler = new TransformJobHandler(
        derivatives,
        media,
        storage,
        process,
        { probe: async () => ({ hasAudio: false }) },
        'ffmpeg',
      );

      await expect(
        handler.execute({ derivativeId: 'disk-derivative' }, jobContext()),
      ).rejects.toMatchObject({ code: 'TRANSFORM_EXECUTION_FAILED' });
      expect(processCalls).toBe(0);
      expect(discardCalls).toBe(1);
      const failed = derivatives.findById('disk-derivative');
      expect(failed).toMatchObject({
        errorCode: 'TRANSFORM_EXECUTION_FAILED',
        status: 'failed',
      });
      expect(failed?.output).toBeUndefined();
    } finally {
      fixture.dispose();
    }
  });

  it('recovers a partial output after restart and successfully retries the same derivative', async () => {
    const fixture = createTemporaryDatabase();
    try {
      const sourcePath = join(fixture.directory, 'source.mp4');
      await writeFile(sourcePath, 'source');
      const media = new SqliteMediaRepository(fixture.database);
      media.create(
        mediaAsset({
          fingerprint: 'sha256:restart',
          id: 'restart-source',
          metadata: {
            durationSeconds: 1,
            frameRate: 24,
            hasAudio: false,
            height: 120,
            videoCodec: 'h264',
            width: 160,
          },
          path: sourcePath,
          sizeBytes: 6,
        }),
      );
      const derivatives = new SqliteTransformDerivativeRepository(fixture.database);
      derivatives.reserve({
        id: 'restart-derivative',
        identity: cacheIdentity('sha256:restart', { user: { steps: [] } }),
        sourceMediaId: 'restart-source',
        now: new Date(1),
      });
      derivatives.markRunning('restart-derivative', new Date(2));
      const storage = new LocalTransformOutputStorage(fixture.directory);
      const partialDirectory = join(storage.root, 'restart-derivative');
      await mkdir(partialDirectory, { recursive: true });
      await writeFile(join(partialDirectory, 'output.partial.mp4'), 'crash partial');

      const recovered = await new TransformRecoveryService(
        derivatives,
        storage,
        () => new Date(3),
        0,
      ).recover();
      expect(recovered.interrupted).toBe(1);
      await expect(access(partialDirectory)).rejects.toMatchObject({ code: 'ENOENT' });

      let runs = 0;
      const process: TransformProcessRunner = {
        run: async (command) => {
          runs += 1;
          const outputPath = command.args.at(-1);
          if (outputPath === undefined) throw new Error('Missing output path.');
          await writeFile(outputPath, 'complete output');
        },
        stop: async () => undefined,
      };
      const handler = new TransformJobHandler(
        derivatives,
        media,
        storage,
        process,
        {
          probe: async () => ({
            durationSeconds: 1,
            frameRate: 24,
            hasAudio: false,
            height: 120,
            videoCodec: 'h264',
            width: 160,
          }),
        },
        'ffmpeg',
      );
      await handler.execute({ derivativeId: 'restart-derivative' }, jobContext());

      const completed = derivatives.findById('restart-derivative');
      expect(runs).toBe(1);
      expect(completed).toMatchObject({
        output: { sizeBytes: 15 },
        status: 'succeeded',
      });
      expect(completed?.errorCode).toBeUndefined();
      await expect(access(completed!.output!.path)).resolves.toBeUndefined();
    } finally {
      fixture.dispose();
    }
  });
});
