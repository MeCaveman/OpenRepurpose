import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { runDoctor } from '../../apps/cli/src/index.js';

const doctorDirectory = join(process.cwd(), 'test-results', 'doctor');

describe('openrepurpose doctor', () => {
  afterEach(() => rmSync(doctorDirectory, { recursive: true, force: true }));

  it('reports Packet 2 configuration and persistence checks', () => {
    const checks = runDoctor({
      APP_CONFIG_DIR: join(doctorDirectory, 'config'),
      APP_DATA_DIR: join(doctorDirectory, 'data'),
      APP_TEMP_DIR: join(doctorDirectory, 'temp'),
      DATABASE_URL: join(doctorDirectory, 'data', 'openrepurpose.sqlite'),
    });
    expect(checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        'config directory',
        'data directory',
        'database migrations',
        'configured bind host',
      ]),
    );
  });
});
