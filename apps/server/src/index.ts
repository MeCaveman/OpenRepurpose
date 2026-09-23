import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  JobRunner,
  JobService,
  ExternalDownloaderMediaResolver,
  ExternalDownloaderRegistry,
  MediaImportService,
  MediaResolutionService,
  RegisteredLocalOriginalMatcher,
  SourceCleanupJobHandler,
  SourceExecutionJobHandler,
  SourceItemObservedJobHandler,
  SourceMediaCleanupService,
  SourcePollingRunner,
  SchedulerLoop,
  ScheduleService,
  SourceService,
  SourceWorkflowCoordinator,
  DerivativeAwareMediaRepository,
  TransformService,
  TranscriptService,
  TranscriptionProviderRegistry,
  WorkflowTranscriptionJobHandler,
  WorkflowTranscriptionService,
  WorkflowTransformService,
  WorkflowService,
  WorkflowPresetService,
  type JobHandler,
} from '@openrepurpose/core';
import {
  openDatabase,
  runMigrations,
  SqliteAccountRepository,
  SqliteDestinationJobRepository,
  SqliteJobRepository,
  SqliteMediaRepository,
  SqliteMetaCredentialRepository,
  SqliteOAuthAuthorizationRequestRepository,
  SqliteSourceCursorRepository,
  SqliteSourceMediaResolutionRepository,
  SqliteSourcePollingRepository,
  SqliteSourceWorkflowExecutionRepository,
  SqliteTransformDerivativeRepository,
  SqliteTranscriptRepository,
  SqliteScheduleRepository,
  SqliteWorkflowRepository,
} from '@openrepurpose/db';
import {
  discoverMediaExecutables,
  readFfmpegVersion,
  FfprobeMediaProbe,
  LocalManagedTemporaryStorage,
  LocalMediaFileInspector,
  LocalWhisperModelManager,
  LocalTransformOutputStorage,
  FfmpegProcessRunner,
  ObsWebSocketFolderScanTrigger,
  TransformJobHandler,
  TransformRecoveryService,
  WatchedFolderRunner,
  WHISPER_CPP_MODEL_CATALOG,
  discoverWhisperCppExecutable,
  LocalWhisperCppModelLocator,
  WhisperCppTranscriptionProvider,
  resolveWhisperCppPaths,
} from '@openrepurpose/media';
import { loadApplicationConfig } from '@openrepurpose/shared';
import { createRedactingLogger, redactLogText, SourceRegistry } from '@openrepurpose/platform-sdk';
import { EncryptedFileSecretStore } from '@openrepurpose/local-secrets';
import {
  YouTubeOAuthService,
  YouTubeSourceAdapter,
  YouTubeUploadJobHandler,
} from '@openrepurpose/youtube';
import {
  TwitchClipMediaResolver,
  TwitchOAuthService,
  TwitchSourceAdapter,
} from '@openrepurpose/twitch';
import { KickOAuthService, KickSourceAdapter } from '@openrepurpose/kick';
import { TikTokDirectPostJobHandler, TikTokOAuthService } from '@openrepurpose/tiktok';
import {
  FacebookReelsJobHandler,
  InstagramReelsJobHandler,
  MetaOAuthService,
} from '@openrepurpose/meta';
import { assertLocalOnly, buildServer } from './app.js';
import { loadOrCreateSessionKey } from './session-key.js';

export async function startServer(): Promise<void> {
  const config = loadApplicationConfig();
  assertLocalOnly(config);
  const database = openDatabase(config.paths.databasePath);
  runMigrations(database);
  const executables = await discoverMediaExecutables();
  const mediaRepository = new SqliteMediaRepository(database);
  const modelManager = new LocalWhisperModelManager(
    WHISPER_CPP_MODEL_CATALOG,
    config.paths.transcriptionModelDirectory,
  );
  const transcriptRepository = new SqliteTranscriptRepository(database);
  const transcriptService = new TranscriptService(transcriptRepository);
  const jobRepository = new SqliteJobRepository(database);
  const secretStore = new EncryptedFileSecretStore(
    config.paths.secretVaultPath,
    config.paths.secretKeyPath,
  );
  const obsWebSocketPasswordReference = {
    name: 'password',
    ownerId: 'obs-websocket',
    scope: 'application',
  } as const;
  if (config.obsWebSocket?.password !== undefined)
    await secretStore.set(obsWebSocketPasswordReference, config.obsWebSocket.password);
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
  const twitchOAuthService = new TwitchOAuthService(
    accountRepository,
    authorizationRequestRepository,
    secretStore,
    config.appUrl,
  );
  const kickOAuthService = new KickOAuthService(
    accountRepository,
    authorizationRequestRepository,
    secretStore,
    config.appUrl,
  );
  const metaCredentialRepository = new SqliteMetaCredentialRepository(database);
  const metaOAuthService = new MetaOAuthService(
    metaCredentialRepository,
    authorizationRequestRepository,
    secretStore,
    config.appUrl,
  );
  const jobService = new JobService(jobRepository);
  const mediaImportService =
    executables.ffprobe === undefined
      ? undefined
      : new MediaImportService(
          new LocalMediaFileInspector(),
          new FfprobeMediaProbe(executables.ffprobe),
          mediaRepository,
        );
  const sourceExecutionRepository = new SqliteSourceWorkflowExecutionRepository(database);
  // External downloaders are optional infrastructure adapters. No implementation ships today;
  // future enabled/configured adapters register here without changing media-resolution logic.
  const externalDownloaders = new ExternalDownloaderRegistry();
  const managedTemporaryStorage = new LocalManagedTemporaryStorage(config.paths.dataDirectory);
  const transformDerivativeRepository = new SqliteTransformDerivativeRepository(database);
  const transformMediaRepository = new DerivativeAwareMediaRepository(
    mediaRepository,
    transformDerivativeRepository,
  );
  const transformTool =
    executables.ffmpeg === undefined
      ? undefined
      : { encoder: 'libx264', ffmpegVersion: await readFfmpegVersion(executables.ffmpeg) };
  const workflowTransformService =
    transformTool === undefined
      ? undefined
      : new WorkflowTransformService(transformDerivativeRepository, jobService, transformTool);
  const transformService = new TransformService(
    mediaRepository,
    transformDerivativeRepository,
    jobService,
    transformTool,
  );
  const whisperPaths = resolveWhisperCppPaths(config.paths.dataDirectory);
  const whisperExecutable = await discoverWhisperCppExecutable({
    managedInstallationRoot: whisperPaths.installationRoot,
  });
  const transcriptionProviders = new TranscriptionProviderRegistry(
    whisperExecutable === undefined
      ? []
      : [
          new WhisperCppTranscriptionProvider({
            executable: whisperExecutable,
            modelLocator: new LocalWhisperCppModelLocator(config.paths.transcriptionModelDirectory),
            temporaryDirectory: config.paths.dataDirectory,
          }),
        ],
  );
  const workflowTranscriptionService =
    transcriptionProviders.list().length === 0
      ? undefined
      : new WorkflowTranscriptionService(transcriptRepository, jobService);
  const workflowService = new WorkflowService(
    new SqliteWorkflowRepository(database),
    jobService,
    undefined,
    workflowTransformService,
    workflowTranscriptionService,
  );
  const transformOutputStorage = new LocalTransformOutputStorage(config.paths.dataDirectory);
  const transformProcessRunner = new FfmpegProcessRunner(config.transformRunner);
  await new TransformRecoveryService(
    transformDerivativeRepository,
    transformOutputStorage,
  ).recover();
  const sourceCoordinator =
    mediaImportService === undefined
      ? undefined
      : new SourceWorkflowCoordinator(
          new SqliteWorkflowRepository(database),
          sourceExecutionRepository,
          new MediaResolutionService(
            new SqliteSourceMediaResolutionRepository(database),
            new RegisteredLocalOriginalMatcher(mediaRepository),
            [
              new ExternalDownloaderMediaResolver(externalDownloaders),
              new TwitchClipMediaResolver(twitchOAuthService),
            ],
            managedTemporaryStorage,
            mediaImportService,
            mediaRepository,
          ),
          workflowService,
          jobService,
          new SourceMediaCleanupService(
            new SqliteSourceMediaResolutionRepository(database),
            managedTemporaryStorage,
          ),
        );
  // The durable loop is intentionally server-owned, so polling continues with no browser session
  // or web UI open. Twitch uses the same durable polling path; EventSub is not authoritative.
  const sourceRepository = new SqliteSourcePollingRepository(database);
  const workflowPresetService = new WorkflowPresetService(
    accountRepository,
    metaCredentialRepository,
    sourceRepository,
    { transformAvailable: workflowTransformService !== undefined },
  );
  const sourcePollingRunner = new SourcePollingRunner(
    sourceRepository,
    new SourceRegistry([
      new YouTubeSourceAdapter(youtubeOAuthService),
      new TwitchSourceAdapter(twitchOAuthService),
      new KickSourceAdapter(kickOAuthService),
    ]),
    jobService,
    {
      sourceContext: {
        logger: createRedactingLogger({
          subsystem: 'source-polling',
          write: (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`),
        }),
        secretStore,
      },
    },
  );
  const schedulerLoop = new SchedulerLoop(
    new ScheduleService(new SqliteScheduleRepository(database), sourceRepository),
  );
  const jobHandlers: JobHandler[] = [
    new YouTubeUploadJobHandler(
      transformMediaRepository,
      new SqliteDestinationJobRepository(database),
      youtubeOAuthService,
    ),
    new TikTokDirectPostJobHandler(
      transformMediaRepository,
      new SqliteDestinationJobRepository(database),
      tiktokOAuthService,
      secretStore,
    ),
    new InstagramReelsJobHandler(
      transformMediaRepository,
      new SqliteDestinationJobRepository(database),
      new SqliteMetaCredentialRepository(database),
      secretStore,
    ),
    new FacebookReelsJobHandler(
      transformMediaRepository,
      new SqliteDestinationJobRepository(database),
      new SqliteMetaCredentialRepository(database),
      secretStore,
    ),
  ];
  if (sourceCoordinator !== undefined)
    jobHandlers.push(
      new SourceItemObservedJobHandler(sourceCoordinator),
      new SourceExecutionJobHandler(sourceCoordinator),
      new SourceCleanupJobHandler(sourceCoordinator),
    );
  if (executables.ffmpeg !== undefined && executables.ffprobe !== undefined)
    jobHandlers.push(
      new TransformJobHandler(
        transformDerivativeRepository,
        mediaRepository,
        transformOutputStorage,
        transformProcessRunner,
        new FfprobeMediaProbe(executables.ffprobe),
        executables.ffmpeg,
      ),
    );
  if (transcriptionProviders.list().length > 0)
    jobHandlers.push(
      new WorkflowTranscriptionJobHandler(
        mediaRepository,
        transcriptRepository,
        transcriptionProviders,
        {
          onCompleted: (continuation) => {
            workflowService.resumeAfterTranscription(continuation);
          },
        },
      ),
    );
  const jobRunner = new JobRunner(jobRepository, jobHandlers, {
    ...config.jobRunner,
    ...(sourceCoordinator === undefined ? {} : { onJobSettled: () => sourceCoordinator.recover() }),
  });
  sourceCoordinator?.recover();
  jobRunner.start();
  sourcePollingRunner.start();
  schedulerLoop.start();
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
  const obsWebSocketPassword =
    config.obsWebSocket === undefined
      ? undefined
      : await secretStore.get(obsWebSocketPasswordReference);
  const obsWebSocketTrigger =
    config.obsWebSocket === undefined || watchedFolderRunner === undefined
      ? undefined
      : new ObsWebSocketFolderScanTrigger({
          endpoint: config.obsWebSocket.url,
          onConnectionFailure: () =>
            process.stderr.write(
              `${JSON.stringify({
                level: 'warn',
                subsystem: 'obs-websocket',
                event: 'connection.failed',
              })}\n`,
            ),
          onScan: () => watchedFolderRunner.scan(),
          ...(obsWebSocketPassword === undefined ? {} : { password: obsWebSocketPassword }),
          reconnectDelayMs: config.obsWebSocket.reconnectDelayMs,
        });
  obsWebSocketTrigger?.start();
  const server = buildServer({
    config,
    jobService,
    jobRunner,
    destinationJobRepository: new SqliteDestinationJobRepository(database),
    logger: true,
    sessionKey: loadOrCreateSessionKey(config.paths.sessionKeyPath),
    mediaRepository,
    modelManager,
    workflowService,
    workflowPresetService,
    sourceService: new SourceService(sourceRepository),
    ...(sourceCoordinator === undefined ? {} : { sourceWorkflowCoordinator: sourceCoordinator }),
    tiktokOAuthService,
    twitchOAuthService,
    kickOAuthService,
    transformService,
    transcriptService,
    metaOAuthService,
    youtubeOAuthService,
    ...(mediaImportService === undefined ? {} : { mediaImportService }),
  });
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      await transformProcessRunner.stop();
      await jobRunner.stop();
      await sourcePollingRunner.stop();
      schedulerLoop.stop();
      await obsWebSocketTrigger?.stop();
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
    await transformProcessRunner.stop();
    await jobRunner.stop();
    await sourcePollingRunner.stop();
    schedulerLoop.stop();
    await obsWebSocketTrigger?.stop();
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
