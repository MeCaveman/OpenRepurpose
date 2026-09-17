import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { MediaImportService } from '@openrepurpose/core';
import { openDatabase, runMigrations, SqliteMediaRepository } from '@openrepurpose/db';
import {
  discoverMediaExecutables,
  FfprobeMediaProbe,
  LocalMediaFileInspector,
} from '@openrepurpose/media';
import { loadApplicationConfig } from '@openrepurpose/shared';
import { assertLocalOnly, buildServer } from './app.js';
import { loadOrCreateSessionKey } from './session-key.js';

export async function startServer(): Promise<void> {
  const config = loadApplicationConfig();
  assertLocalOnly(config);
  const database = openDatabase(config.paths.databasePath);
  runMigrations(database);
  const executables = await discoverMediaExecutables();
  const repository = new SqliteMediaRepository(database);
  const mediaImportService =
    executables.ffprobe === undefined
      ? undefined
      : new MediaImportService(
          new LocalMediaFileInspector(),
          new FfprobeMediaProbe(executables.ffprobe),
          repository,
        );
  const server = buildServer({
    config,
    logger: true,
    sessionKey: loadOrCreateSessionKey(config.paths.sessionKeyPath),
    mediaRepository: repository,
    ...(mediaImportService === undefined ? {} : { mediaImportService }),
  });
  const close = async () => {
    await server.close();
    database.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  await server.listen({ host: config.bindHost, port: config.port });
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
      `OpenRepurpose server failed to start: ${error instanceof Error ? error.message : 'Server startup failed.'}\n`,
    );
    process.exitCode = 1;
  });
export { assertLocalOnly, buildServer } from './app.js';
export { loadOrCreateSessionKey } from './session-key.js';
