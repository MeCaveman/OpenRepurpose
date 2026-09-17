import { accessSync, constants, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabase, runMigrations } from '@openrepurpose/db';
import { loadApplicationConfig } from '@openrepurpose/shared';
import type { Environment } from '@openrepurpose/shared';

export interface DoctorCheck {
  readonly detail: string;
  readonly name: string;
  readonly ok: boolean;
}

function writableDirectoryCheck(name: string, directory: string): DoctorCheck {
  try {
    mkdirSync(directory, { recursive: true });
    accessSync(directory, constants.W_OK);
    return { name, ok: true, detail: directory };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : 'Directory is not writable.',
    };
  }
}

/** Packet 2 diagnostic composition. Future packets add server and media dependency probes here. */
export function runDoctor(environment: Environment = process.env): readonly DoctorCheck[] {
  try {
    const config = loadApplicationConfig(environment);
    const checks: DoctorCheck[] = [
      writableDirectoryCheck('config directory', config.paths.configDirectory),
      writableDirectoryCheck('data directory', config.paths.dataDirectory),
      writableDirectoryCheck('temporary directory', config.paths.temporaryDirectory),
      writableDirectoryCheck('database directory', dirname(config.paths.databasePath)),
    ];
    try {
      const database = openDatabase(config.paths.databasePath);
      runMigrations(database);
      database.close();
      checks.push({ name: 'database migrations', ok: true, detail: config.paths.databasePath });
    } catch (error) {
      checks.push({
        name: 'database migrations',
        ok: false,
        detail: error instanceof Error ? error.message : 'Database could not be opened.',
      });
    }
    checks.push({ name: 'configured bind host', ok: true, detail: config.bindHost });
    return checks;
  } catch (error) {
    return [
      {
        name: 'configuration',
        ok: false,
        detail: error instanceof Error ? error.message : 'Configuration is invalid.',
      },
    ];
  }
}

function isExecutedDirectly(): boolean {
  return (
    process.argv[1] !== undefined && import.meta.url === new URL(`file:${process.argv[1]}`).href
  );
}

if (isExecutedDirectly()) {
  if (process.argv[2] !== 'doctor') {
    process.stderr.write('Usage: openrepurpose doctor\n');
    process.exitCode = 1;
  } else {
    const checks = runDoctor();
    for (const check of checks) {
      process.stdout.write(`${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.detail}\n`);
    }
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
  }
}
