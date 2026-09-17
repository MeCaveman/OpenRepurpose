import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { JobRunner, JobService, MediaImportService } from '@openrepurpose/core';
import {
  openDatabase,
  runMigrations,
  SqliteJobRepository,
  SqliteMediaRepository,
} from '@openrepurpose/db';
import {
  discoverMediaExecutables,
  FfprobeMediaProbe,
  LocalMediaFileInspector,
} from '@openrepurpose/media';
import { loadApplicationConfig } from '@openrepurpose/shared';
import { redactLogText } from '@openrepurpose/platform-sdk';
import { assertLocalOnly, buildServer } from './app.js';
import { loadOrCreateSessionKey } from './session-key.js';

export async function startServer(): Promise<void> {
  const config = loadApplicationConfig();
  assertLocalOnly(config);
  const database = openDatabase(config.paths.databasePath);
  runMigrations(database);
  const executables = await discoverMediaExecutables();
  const mediaRepository = new SqliteMediaRepository(database);
  const jobRepository = new SqliteJobRepository(database);
  const jobService = new JobService(jobRepository);
  const jobRunner = new JobRunner(jobRepository, [], config.jobRunner);
  jobRunner.start();
  const mediaImportService =
    executables.ffprobe === undefined
      ? undefined
      : new MediaImportService(
          new LocalMediaFileInspector(),
          new FfprobeMediaProbe(executables.ffprobe),
          mediaRepository,
        );
  const server = buildServer({
    config,
    jobService,
    logger: true,
    sessionKey: loadOrCreateSessionKey(config.paths.sessionKeyPath),
    mediaRepository,
    ...(mediaImportService === undefined ? {} : { mediaImportService }),
  });
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      await jobRunner.stop();
      await server.close();
      database.close();
    })();
    return closing;
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  try {
    await server.listen({ host: config.bindHost, port: config.port });
  } catch (error) {
    await jobRunner.stop();
    database.close();
    throw error;
  }
}

function isExecutedDirectly(): boolean {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}
if (isExecutedDirectly())
  startServer().catch((error: unknown) => {
    process.stderr.write(
      `OpenRepurpose server failed to start: ${error instanceof Error ? redactLogText(error.message) : 'Server startup failed.'}\n`,
    );
    process.exitCode = 1;
  });
export { assertLocalOnly, buildServer } from './app.js';
export { loadOrCreateSessionKey } from './session-key.js';
