import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { JobRunner, JobService, MediaImportService, WorkflowService } from '@openrepurpose/core';
import {
  openDatabase,
  runMigrations,
  SqliteAccountRepository,
  SqliteDestinationJobRepository,
  SqliteJobRepository,
  SqliteMediaRepository,
  SqliteOAuthAuthorizationRequestRepository,
  SqliteSourceCursorRepository,
  SqliteWorkflowRepository,
} from '@openrepurpose/db';
import {
  discoverMediaExecutables,
  FfprobeMediaProbe,
  LocalMediaFileInspector,
  WatchedFolderRunner,
} from '@openrepurpose/media';
import { loadApplicationConfig } from '@openrepurpose/shared';
import { redactLogText } from '@openrepurpose/platform-sdk';
import { EncryptedFileSecretStore } from '@openrepurpose/local-secrets';
import { YouTubeOAuthService, YouTubeUploadJobHandler } from '@openrepurpose/youtube';
import { TikTokDirectPostJobHandler, TikTokOAuthService } from '@openrepurpose/tiktok';
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
  const secretStore = new EncryptedFileSecretStore(
    config.paths.secretVaultPath,
    config.paths.secretKeyPath,
  );
  const accountRepository = new SqliteAccountRepository(database);
  const authorizationRequestRepository = new SqliteOAuthAuthorizationRequestRepository(database);
  const youtubeOAuthService = new YouTubeOAuthService(
    accountRepository,
    authorizationRequestRepository,
    secretStore,
    config.appUrl,
  );
  const tiktokOAuthService = new TikTokOAuthService(
    accountRepository,
    authorizationRequestRepository,
    secretStore,
    config.appUrl,
  );
  const jobService = new JobService(jobRepository);
  const workflowService = new WorkflowService(new SqliteWorkflowRepository(database), jobService);
  const jobRunner = new JobRunner(
    jobRepository,
    [
      new YouTubeUploadJobHandler(
        mediaRepository,
        new SqliteDestinationJobRepository(database),
        youtubeOAuthService,
      ),
      new TikTokDirectPostJobHandler(
        mediaRepository,
        new SqliteDestinationJobRepository(database),
        tiktokOAuthService,
        secretStore,
      ),
    ],
    config.jobRunner,
  );
  jobRunner.start();
  const mediaImportService =
    executables.ffprobe === undefined
      ? undefined
      : new MediaImportService(
          new LocalMediaFileInspector(),
          new FfprobeMediaProbe(executables.ffprobe),
          mediaRepository,
        );
  const watchedFolderRunner =
    mediaImportService === undefined
      ? undefined
      : new WatchedFolderRunner(
          workflowService,
          new SqliteSourceCursorRepository(database),
          mediaImportService,
          config.watchedFolder,
        );
  watchedFolderRunner?.start();
  const server = buildServer({
    config,
    jobService,
    destinationJobRepository: new SqliteDestinationJobRepository(database),
    logger: true,
    sessionKey: loadOrCreateSessionKey(config.paths.sessionKeyPath),
    mediaRepository,
    workflowService,
    tiktokOAuthService,
    youtubeOAuthService,
    ...(mediaImportService === undefined ? {} : { mediaImportService }),
  });
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      await jobRunner.stop();
      watchedFolderRunner?.stop();
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
    watchedFolderRunner?.stop();
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
