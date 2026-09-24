import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { runDoctor } from '../../apps/cli/src/index.js';

const doctorDirectory = join(process.cwd(), 'test-results', 'doctor');

describe('openrepurpose doctor', () => {
  afterEach(() => rmSync(doctorDirectory, { recursive: true, force: true }));

  it('reports release runtime, configuration, persistence, and media dependency checks', async () => {
    const checks = await runDoctor({
      APP_CONFIG_DIR: join(doctorDirectory, 'config'),
      APP_DATA_DIR: join(doctorDirectory, 'data'),
      APP_TEMP_DIR: join(doctorDirectory, 'temp'),
      DATABASE_URL: join(doctorDirectory, 'data', 'openrepurpose.sqlite'),
      PATH: process.env.PATH,
    });
    expect(checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        'config directory',
        'data directory',
        'database migrations',
        'configured bind host',
        'Node.js runtime',
        'FFmpeg executable',
        'ffprobe executable',
        'whisper.cpp executable',
      ]),
    );
  });

  it('fails explicitly configured media executables that cannot be started', async () => {
    const checks = await runDoctor({
      APP_CONFIG_DIR: join(doctorDirectory, 'config'),
      APP_DATA_DIR: join(doctorDirectory, 'data'),
      APP_TEMP_DIR: join(doctorDirectory, 'temp'),
      DATABASE_URL: join(doctorDirectory, 'data', 'openrepurpose.sqlite'),
      FFMPEG_PATH: join(doctorDirectory, 'missing-ffmpeg'),
      FFPROBE_PATH: join(doctorDirectory, 'missing-ffprobe'),
      PATH: '',
    });

    expect(checks.filter((check) => check.name.includes('executable')).slice(0, 2)).toEqual([
      expect.objectContaining({ name: 'FFmpeg executable', ok: false, optional: false }),
      expect.objectContaining({ name: 'ffprobe executable', ok: false, optional: false }),
    ]);
  });
});
