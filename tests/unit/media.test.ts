import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MediaImportService } from '@openrepurpose/core';
import { SqliteMediaRepository } from '@openrepurpose/db';
import { FfprobeMediaProbe, LocalMediaFileInspector } from '@openrepurpose/media';
import { createTemporaryDatabase } from '@openrepurpose/testkit';
import type { TemporaryDatabase } from '@openrepurpose/testkit';

describe('media import', () => {
  let temporary: TemporaryDatabase | undefined;
  afterEach(() => temporary?.dispose());
  it('streams a Unicode path with spaces, persists probe data, and deduplicates by fingerprint', async () => {
    temporary = createTemporaryDatabase();
    const directory = join(temporary.directory, 'media files', 'مقاطع');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'video sample.mp4');
    writeFileSync(path, 'not a real video');
    const files = new LocalMediaFileInspector();
    const probe = {
      probe: async () => ({
        durationSeconds: 12.5,
        videoCodec: 'h264',
        width: 1920,
        height: 1080,
        frameRate: 30,
        hasAudio: true,
      }),
    };
    const service = new MediaImportService(
      files,
      probe,
      new SqliteMediaRepository(temporary.database),
    );
    const first = await service.import(path);
    const duplicate = await service.import(path);
    expect(first.duplicate).toBe(false);
    expect(first.asset.path).toContain('media files');
    expect(first.asset.metadata.width).toBe(1920);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.asset.id).toBe(first.asset.id);
  });

  it('passes a Windows-style path fixture as one argument to ffprobe without shell interpolation', async () => {
    temporary = createTemporaryDatabase();
    const script = join(temporary.directory, 'fake-probe.mjs');
    writeFileSync(
      script,
      "process.stdout.write(JSON.stringify({format:{duration:'1.5'},streams:[{codec_type:'video',codec_name:'h264',width:1280,height:720,r_frame_rate:'30000/1001'},{codec_type:'audio',codec_name:'aac'}]}));",
    );
    const probe = new FfprobeMediaProbe(process.execPath, [script]);
    const metadata = await probe.probe(`C:\\Media Files\\مقطع;not-a-command.mp4`);
    expect(metadata).toMatchObject({
      durationSeconds: 1.5,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1280,
      height: 720,
      hasAudio: true,
    });
  });
});
