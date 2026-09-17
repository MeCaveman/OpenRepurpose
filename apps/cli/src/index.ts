import { accessSync, constants, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Command } from 'commander';
import { MediaImportService } from '@openrepurpose/core';
import { openDatabase, runMigrations, SqliteMediaRepository } from '@openrepurpose/db';
import {
  discoverMediaExecutables,
  FfprobeMediaProbe,
  LocalMediaFileInspector,
} from '@openrepurpose/media';
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

async function mediaContext() {
  const config = loadApplicationConfig();
  const database = openDatabase(config.paths.databasePath);
  runMigrations(database);
  const executables = await discoverMediaExecutables();
  if (executables.ffprobe === undefined) {
    database.close();
    throw new Error('ffprobe was not found. Set FFPROBE_PATH or add ffprobe to PATH.');
  }
  const repository = new SqliteMediaRepository(database);
  return {
    database,
    repository,
    service: new MediaImportService(
      new LocalMediaFileInspector(),
      new FfprobeMediaProbe(executables.ffprobe),
      repository,
    ),
  };
}

export function createCli(): Command {
  const program = new Command().name('openrepurpose').description('Local media automation');
  program.command('doctor').action(() => {
    const checks = runDoctor();
    for (const check of checks)
      process.stdout.write(`${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.detail}\n`);
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
  });
  const media = program.command('media').description('Manage local media');
  media.command('import <path>').action(async (path: string) => {
    const context = await mediaContext();
    try {
      const result = await context.service.import(path);
      process.stdout.write(
        `${result.duplicate ? 'Already imported' : 'Imported'} ${result.asset.id}: ${result.asset.path}\n`,
      );
    } finally {
      context.database.close();
    }
  });
  media
    .command('list')
    .option('--json', 'write JSON')
    .action(async (options: { json?: boolean }) => {
      const context = await mediaContext();
      try {
        const assets = context.repository.list();
        process.stdout.write(
          options.json
            ? `${JSON.stringify(assets)}\n`
            : assets.map((asset) => `${asset.id}\t${asset.state}\t${asset.path}`).join('\n') +
                (assets.length > 0 ? '\n' : ''),
        );
      } finally {
        context.database.close();
      }
    });
  return program;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file:${process.argv[1]}`).href)
  createCli()
    .parseAsync(process.argv)
    .catch((error: unknown) => {
      process.stderr.write(
        `OpenRepurpose failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`,
      );
      process.exitCode = 1;
    });
