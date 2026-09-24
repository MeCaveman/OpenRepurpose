import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import {
  JobService,
  ApiTokenService,
  MediaImportService,
  ScheduleService,
  SourceService,
  TransformService,
  TranscriptService,
  WorkflowService,
} from '@openrepurpose/core';
import type {
  JobStatus,
  MediaProbe,
  TransformPlanInput,
  TransformToolIdentity,
} from '@openrepurpose/core';
import {
  openDatabase,
  runMigrations,
  createPortableBackup,
  restorePortableBackup,
  invalidateSecretDependentState,
  SqliteAccountRepository,
  SqliteApiTokenRepository,
  SqliteJobRepository,
  SqliteMediaRepository,
  SqliteOAuthAuthorizationRequestRepository,
  SqliteScheduleRepository,
  SqliteSourcePollingRepository,
  SqliteTransformDerivativeRepository,
  SqliteTranscriptRepository,
  SqliteWorkflowRepository,
} from '@openrepurpose/db';
import {
  discoverMediaExecutables,
  discoverWhisperCppExecutable,
  FfprobeMediaProbe,
  LocalMediaFileInspector,
  LocalWhisperModelManager,
  readFfmpegVersion,
  resolveWhisperCppPaths,
  WHISPER_CPP_MODEL_CATALOG,
  type TranscriptionModelManager,
} from '@openrepurpose/media';
import { loadApplicationConfig } from '@openrepurpose/shared';
import type { Environment } from '@openrepurpose/shared';
import { EncryptedFileSecretStore } from '@openrepurpose/local-secrets';
import { YouTubeOAuthService } from '@openrepurpose/youtube';
import { TikTokOAuthService } from '@openrepurpose/tiktok';

export interface DoctorCheck {
  readonly detail: string;
  readonly name: string;
  readonly ok: boolean;
  /** Optional dependencies are reported without making doctor exit unsuccessfully. */
  readonly optional?: boolean;
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

export async function runDoctor(
  environment: Environment = process.env,
): Promise<readonly DoctorCheck[]> {
  try {
    const config = loadApplicationConfig(environment);
    const checks: DoctorCheck[] = [
      writableDirectoryCheck('config directory', config.paths.configDirectory),
      writableDirectoryCheck('data directory', config.paths.dataDirectory),
      writableDirectoryCheck('temporary directory', config.paths.temporaryDirectory),
      writableDirectoryCheck('database directory', dirname(config.paths.databasePath)),
      writableDirectoryCheck(
        'transcription model directory',
        config.paths.transcriptionModelDirectory,
      ),
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
    checks.push({ name: 'Node.js runtime', ok: true, detail: process.version });

    const executables = await discoverMediaExecutables({ environment });
    for (const dependency of [
      {
        configured: environment.FFMPEG_PATH,
        name: 'FFmpeg executable',
        path: executables.ffmpeg,
      },
      {
        configured: environment.FFPROBE_PATH,
        name: 'ffprobe executable',
        path: executables.ffprobe,
      },
    ]) {
      if (dependency.path !== undefined) {
        checks.push({ name: dependency.name, ok: true, detail: dependency.path });
      } else {
        const explicitlyConfigured = dependency.configured !== undefined;
        checks.push({
          name: dependency.name,
          ok: false,
          optional: !explicitlyConfigured,
          detail: explicitlyConfigured
            ? `Configured executable is unavailable or broken: ${dependency.configured}`
            : 'Not installed; media probing/transforms that require it are unavailable.',
        });
      }
    }

    const whisperPaths = resolveWhisperCppPaths(config.paths.dataDirectory);
    const whisper = await discoverWhisperCppExecutable({
      environment,
      managedInstallationRoot: whisperPaths.installationRoot,
    });
    checks.push(
      whisper === undefined
        ? {
            name: 'whisper.cpp executable',
            ok: false,
            optional: true,
            detail: 'Not installed; local transcription is unavailable.',
          }
        : {
            name: 'whisper.cpp executable',
            ok: true,
            detail: `${whisper.path}${whisper.version === undefined ? '' : ` (${whisper.version})`}`,
          },
    );
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

function mediaReadContext(environment: Environment) {
  const config = loadApplicationConfig(environment);
  const database = openDatabase(config.paths.databasePath);
  runMigrations(database);
  return { database, repository: new SqliteMediaRepository(database) };
}

async function mediaImportContext(environment: Environment) {
  const context = mediaReadContext(environment);
  const executables = await discoverMediaExecutables();
  if (executables.ffprobe === undefined) {
    context.database.close();
    throw new Error('ffprobe was not found. Set FFPROBE_PATH or add ffprobe to PATH.');
  }
  return {
    ...context,
    service: new MediaImportService(
      new LocalMediaFileInspector(),
      new FfprobeMediaProbe(executables.ffprobe),
      context.repository,
    ),
  };
}

function derivativeContext(environment: Environment) {
  const config = loadApplicationConfig(environment);
  const database = openDatabase(config.paths.databasePath);
  runMigrations(database);
  return {
    database,
    derivatives: new SqliteTransformDerivativeRepository(database),
  };
}

function transcriptContext(environment: Environment) {
  const config = loadApplicationConfig(environment);
  const database = openDatabase(config.paths.databasePath);
  runMigrations(database);
  return {
    database,
    service: new TranscriptService(new SqliteTranscriptRepository(database)),
  };
}

async function transformContext(environment: Environment, toolOverride?: TransformToolIdentity) {
  const config = loadApplicationConfig(environment);
  const database = openDatabase(config.paths.databasePath);
  runMigrations(database);
  try {
    const tool =
      toolOverride ??
      (await (async () => {
        const executables = await discoverMediaExecutables();
        if (executables.ffmpeg === undefined)
          throw new Error('ffmpeg was not found. Set FFMPEG_PATH or add ffmpeg to PATH.');
        return {
          encoder: 'libx264',
          ffmpegVersion: await readFfmpegVersion(executables.ffmpeg),
        };
      })());
    const derivatives = new SqliteTransformDerivativeRepository(database);
    const jobs = new JobService(new SqliteJobRepository(database));
    return {
      database,
      service: new TransformService(new SqliteMediaRepository(database), derivatives, jobs, tool),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

function jobContext(environment: Environment) {
  const config = loadApplicationConfig(environment);
  const database = openDatabase(config.paths.databasePath);
  runMigrations(database);
  const service = new JobService(new SqliteJobRepository(database));
  return {
    database,
    service,
    transforms: new TransformService(
      new SqliteMediaRepository(database),
      new SqliteTransformDerivativeRepository(database),
      service,
    ),
  };
}

function apiTokenContext(environment: Environment) {
  const config = loadApplicationConfig(environment);
  const database = openDatabase(config.paths.databasePath);
  runMigrations(database);
  return { database, service: new ApiTokenService(new SqliteApiTokenRepository(database)) };
}

function mcpContext(environment: Environment) {
  const config = loadApplicationConfig(environment);
  const database = openDatabase(config.paths.databasePath);
  runMigrations(database);
  const secrets = new EncryptedFileSecretStore(
    config.paths.secretVaultPath,
    config.paths.secretKeyPath,
  );
  return {
    accountService: new YouTubeOAuthService(
      new SqliteAccountRepository(database),
      new SqliteOAuthAuthorizationRequestRepository(database),
      secrets,
      config.appUrl,
    ),
    database,
    jobService: new JobService(new SqliteJobRepository(database)),
    mediaRepository: new SqliteMediaRepository(database),
    scheduleService: new ScheduleService(
      new SqliteScheduleRepository(database),
      new SqliteSourcePollingRepository(database),
    ),
    workflowService: new WorkflowService(
      new SqliteWorkflowRepository(database),
      new JobService(new SqliteJobRepository(database)),
    ),
  };
}
function workflowContext(environment: Environment) {
  const config = loadApplicationConfig(environment);
  const database = openDatabase(config.paths.databasePath);
  runMigrations(database);
  const jobs = new JobService(new SqliteJobRepository(database));
  return { database, service: new WorkflowService(new SqliteWorkflowRepository(database), jobs) };
}
function sourceContext(environment: Environment) {
  const config = loadApplicationConfig(environment);
  const database = openDatabase(config.paths.databasePath);
  runMigrations(database);
  return { database, service: new SourceService(new SqliteSourcePollingRepository(database)) };
}

function scheduleContext(environment: Environment) {
  const config = loadApplicationConfig(environment);
  const database = openDatabase(config.paths.databasePath);
  runMigrations(database);
  const sources = new SqliteSourcePollingRepository(database);
  return {
    database,
    schedules: new ScheduleService(new SqliteScheduleRepository(database), sources),
  };
}

function accountContext(environment: Environment) {
  const config = loadApplicationConfig(environment);
  const database = openDatabase(config.paths.databasePath);
  runMigrations(database);
  const secrets = new EncryptedFileSecretStore(
    config.paths.secretVaultPath,
    config.paths.secretKeyPath,
  );
  return {
    database,
    youtube: new YouTubeOAuthService(
      new SqliteAccountRepository(database),
      new SqliteOAuthAuthorizationRequestRepository(database),
      secrets,
      config.appUrl,
    ),
    tiktok: new TikTokOAuthService(
      new SqliteAccountRepository(database),
      new SqliteOAuthAuthorizationRequestRepository(database),
      secrets,
      config.appUrl,
    ),
  };
}

function publishContext(environment: Environment) {
  const config = loadApplicationConfig(environment);
  const database = openDatabase(config.paths.databasePath);
  runMigrations(database);
  const secrets = new EncryptedFileSecretStore(
    config.paths.secretVaultPath,
    config.paths.secretKeyPath,
  );
  const accounts = new SqliteAccountRepository(database);
  const tiktok = new TikTokOAuthService(
    accounts,
    new SqliteOAuthAuthorizationRequestRepository(database),
    secrets,
    config.appUrl,
  );
  return {
    database,
    media: new SqliteMediaRepository(database),
    jobs: new JobService(new SqliteJobRepository(database)),
    tiktok,
  };
}

function readGoogleCredentials(path: string): { clientId: string; clientSecret?: string } {
  const document = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (typeof document !== 'object' || document === null)
    throw new Error('The Google OAuth credentials file is invalid.');
  const container =
    'installed' in document && typeof document.installed === 'object' && document.installed !== null
      ? document.installed
      : 'web' in document && typeof document.web === 'object' && document.web !== null
        ? document.web
        : undefined;
  if (
    container === undefined ||
    !('client_id' in container) ||
    typeof container.client_id !== 'string'
  )
    throw new Error('The Google OAuth credentials file does not contain a client ID.');
  return {
    clientId: container.client_id,
    ...('client_secret' in container && typeof container.client_secret === 'string'
      ? { clientSecret: container.client_secret }
      : {}),
  };
}

export interface CreateCliOptions {
  readonly environment?: Environment;
  /** Test/runtime composition hook; normal CLI use discovers local ffprobe. */
  readonly mediaProbe?: MediaProbe;
  /** Test/runtime composition hook; normal CLI use manages models below the configured local root. */
  readonly modelManager?: TranscriptionModelManager;
  /** Test/runtime composition hook; normal CLI use discovers the concrete local FFmpeg build. */
  readonly transformTool?: TransformToolIdentity;
  readonly write?: (value: string) => void;
}

function createModelManager(environment: Environment): TranscriptionModelManager {
  const config = loadApplicationConfig(environment);
  return new LocalWhisperModelManager(
    WHISPER_CPP_MODEL_CATALOG,
    config.paths.transcriptionModelDirectory,
  );
}

function formatModelBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unitIndex = value === 0 ? 0 : Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  const amount = value / 1024 ** unitIndex;
  return `${amount.toFixed(unitIndex === 0 ? 0 : amount >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

type TransformPresetName = 'landscape' | 'square' | 'vertical';
type TransformFitMode = 'contain' | 'crop' | 'stretch';
type TransformAnchor = 'bottom' | 'center' | 'left' | 'right' | 'top';

const transformPresets: Readonly<Record<TransformPresetName, readonly [number, number]>> = {
  vertical: [1080, 1920],
  square: [1080, 1080],
  landscape: [1920, 1080],
};

function positiveEvenDimension(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 2 || parsed > 16_384 || parsed % 2 !== 0)
    throw new Error(`${name} must be an even integer from 2 to 16384.`);
  return parsed;
}

function transformPlanFromOptions(options: {
  readonly anchor?: string;
  readonly fit?: string;
  readonly height?: string;
  readonly preset?: string;
  readonly width?: string;
}): TransformPlanInput {
  const width = positiveEvenDimension(options.width, 'Width');
  const height = positiveEvenDimension(options.height, 'Height');
  const preset = options.preset as TransformPresetName | undefined;
  if (preset !== undefined && !(preset in transformPresets))
    throw new Error(`Unknown transform preset: ${options.preset}`);
  if ((width === undefined) !== (height === undefined))
    throw new Error('Custom transforms require both --width and --height.');
  if (preset !== undefined && width !== undefined)
    throw new Error('Choose either --preset or custom --width and --height dimensions.');
  if (preset === undefined && width === undefined)
    throw new Error('Choose --preset vertical|square|landscape or provide --width and --height.');
  const [targetWidth, targetHeight] =
    width === undefined || height === undefined ? transformPresets[preset!] : [width, height];
  const fit = (options.fit ?? 'crop') as TransformFitMode;
  if (!new Set<TransformFitMode>(['contain', 'crop', 'stretch']).has(fit))
    throw new Error(`Unknown fit mode: ${options.fit}`);
  const anchor = (options.anchor ?? 'center') as TransformAnchor;
  if (!new Set<TransformAnchor>(['bottom', 'center', 'left', 'right', 'top']).has(anchor))
    throw new Error(`Unknown crop anchor: ${options.anchor}`);
  const step =
    fit === 'stretch'
      ? { type: 'fit' as const, mode: fit, width: targetWidth, height: targetHeight }
      : fit === 'contain'
        ? {
            type: 'fit' as const,
            mode: fit,
            width: targetWidth,
            height: targetHeight,
            anchor,
          }
        : {
            type: 'fit' as const,
            mode: fit,
            width: targetWidth,
            height: targetHeight,
            anchor,
          };
  return { schemaVersion: 1, user: { schemaVersion: 1, steps: [step], output: {} } };
}

export function createCli(options: CreateCliOptions = {}): Command {
  const environment = options.environment ?? process.env;
  const write = options.write ?? ((value: string) => process.stdout.write(value));
  const program = new Command().name('openrepurpose').description('Local media automation');
  program.command('doctor').action(async () => {
    const checks = await runDoctor(environment);
    for (const check of checks)
      write(
        `${check.ok ? 'OK' : check.optional === true ? 'WARN' : 'FAIL'} ${check.name}: ${check.detail}\n`,
      );
    if (checks.some((check) => !check.ok && check.optional !== true)) process.exitCode = 1;
  });
  program
    .command('start')
    .description(
      'Start the local server; --headless suppresses no behavior because the server never opens a browser',
    )
    .option('--headless', 'declare non-interactive service operation')
    .action(async () => {
      const { startServer } = await import('@openrepurpose/server');
      await startServer();
    });

  const api = program.command('api').description('Administer local REST API credentials');
  const tokens = api.command('token').description('Create, list, and revoke API bearer tokens');
  tokens
    .command('create <name>')
    .option('--read-only', 'issue read permission only')
    .option('--json', 'write JSON')
    .action((name: string, commandOptions: { json?: boolean; readOnly?: boolean }) => {
      const context = apiTokenContext(environment);
      try {
        const created = context.service.create(
          name,
          commandOptions.readOnly ? ['read'] : ['control'],
        );
        write(commandOptions.json ? `${JSON.stringify(created)}\n` : `${created.token}\n`);
      } finally {
        context.database.close();
      }
    });
  tokens
    .command('revoke <token-id>')
    .option('--json', 'write JSON')
    .action((id: string, commandOptions: { json?: boolean }) => {
      const context = apiTokenContext(environment);
      try {
        const revoked = context.service.revoke(id);
        if (revoked === undefined) throw new Error(`API token not found: ${id}`);
        write(commandOptions.json ? `${JSON.stringify(revoked)}\n` : `${revoked.id}\trevoked\n`);
      } finally {
        context.database.close();
      }
    });
  tokens
    .command('list')
    .option('--json', 'write JSON')
    .action((commandOptions: { json?: boolean }) => {
      const context = apiTokenContext(environment);
      try {
        const listed = context.service.list();
        write(
          commandOptions.json
            ? `${JSON.stringify(listed)}\n`
            : listed
                .map(
                  (token) =>
                    `${token.id}\t${token.name}\t${token.permissions.join(',')}\t${token.revokedAt === undefined ? 'active' : 'revoked'}`,
                )
                .join('\n') + (listed.length === 0 ? '' : '\n'),
        );
      } finally {
        context.database.close();
      }
    });

  const configCommand = program
    .command('config')
    .description('Inspect effective local configuration');
  configCommand
    .command('show')
    .description('Show effective hosting configuration without secret values')
    .option('--json', 'write JSON')
    .action((commandOptions: { json?: boolean }) => {
      const config = loadApplicationConfig(environment);
      const safe = {
        appUrl: config.appUrl.toString(),
        bindHost: config.bindHost,
        lanEnabled: config.network?.lanEnabled ?? false,
        lanAccessTokenConfigured: config.network?.lanAccessToken !== undefined,
        port: config.port,
        tlsConfigured: config.network?.tls !== undefined,
        trustedProxy: config.network?.trustedProxy ?? false,
      };
      write(
        commandOptions.json
          ? `${JSON.stringify(safe)}\n`
          : Object.entries(safe)
              .map(([key, value]) => `${key}\t${value}`)
              .join('\n') + '\n',
      );
    });

  const secretsCommand = program
    .command('secrets')
    .description('Inspect or recover the encrypted local secret vault');
  secretsCommand
    .command('status')
    .option('--json', 'write JSON')
    .action(async (commandOptions: { json?: boolean }) => {
      const config = loadApplicationConfig(environment);
      const status = await new EncryptedFileSecretStore(
        config.paths.secretVaultPath,
        config.paths.secretKeyPath,
      ).inspect();
      write(
        commandOptions.json
          ? `${JSON.stringify(status)}\n`
          : `${status.kind}${'reason' in status ? `\t${status.reason}` : ''}${'secretCount' in status ? `\t${status.secretCount} secrets` : ''}\n`,
      );
      if (status.kind === 'reconnect_required') process.exitCode = 1;
    });
  secretsCommand
    .command('migrate')
    .description('Validate and migrate the v0.x encrypted vault without exposing secret values')
    .option('--json', 'write JSON')
    .action(async (commandOptions: { json?: boolean }) => {
      const config = loadApplicationConfig(environment);
      const result = await new EncryptedFileSecretStore(
        config.paths.secretVaultPath,
        config.paths.secretKeyPath,
      ).initialize();
      write(
        commandOptions.json
          ? `${JSON.stringify(result)}\n`
          : `${result.migrated ? 'migrated' : 'ready'}\t${result.secretCount} secrets${result.backupPath === undefined ? '' : `\tlegacy backup: ${result.backupPath}`}\n`,
      );
    });
  secretsCommand
    .command('recover')
    .description('Archive an unreadable key/vault pair and mark connected accounts for reconnect')
    .option('--confirm-reconnect', 'confirm that secret-backed accounts must be reconnected')
    .option('--json', 'write JSON')
    .action(async (commandOptions: { confirmReconnect?: boolean; json?: boolean }) => {
      if (commandOptions.confirmReconnect !== true)
        throw new Error(
          'Recovery requires --confirm-reconnect. Existing files will be archived, not deleted.',
        );
      const config = loadApplicationConfig(environment);
      const database = openDatabase(config.paths.databasePath);
      try {
        runMigrations(database);
        const result = await new EncryptedFileSecretStore(
          config.paths.secretVaultPath,
          config.paths.secretKeyPath,
        ).recoverForReconnect('archive-and-reconnect');
        invalidateSecretDependentState(database);
        write(
          commandOptions.json
            ? `${JSON.stringify(result)}\n`
            : `reconnect required\n${result.archivedVaultPath === undefined ? '' : `vault archived\t${result.archivedVaultPath}\n`}${result.archivedKeyPath === undefined ? '' : `key archived\t${result.archivedKeyPath}\n`}`,
        );
      } finally {
        database.close();
      }
    });

  const backupCommand = program
    .command('backup')
    .description('Create and restore validated, secret-free portable backups');
  backupCommand
    .command('create')
    .option('--output <file>', 'backup output path')
    .option('--include-metadata', 'include external media and workflow-source path references')
    .option('--json', 'write JSON')
    .action(
      async (commandOptions: { includeMetadata?: boolean; json?: boolean; output?: string }) => {
        const config = loadApplicationConfig(environment);
        const timestamp = new Date().toISOString().replaceAll(':', '-');
        const outputPath = resolve(
          commandOptions.output ??
            join(config.paths.dataDirectory, 'backups', `openrepurpose-${timestamp}.orpbackup`),
        );
        const database = openDatabase(config.paths.databasePath);
        try {
          runMigrations(database);
          const result = await createPortableBackup({
            database,
            includeMetadata: commandOptions.includeMetadata === true,
            outputPath,
            temporaryDirectory: config.paths.temporaryDirectory,
          });
          write(
            commandOptions.json
              ? `${JSON.stringify(result)}\n`
              : `backup created\t${result.path}\nschema\t${result.manifest.database.schemaVersion}\nsecrets\texcluded\n`,
          );
        } finally {
          database.close();
        }
      },
    );
  backupCommand
    .command('restore <file>')
    .description('Validate a backup completely, preserve the current database, then restore it')
    .option('--json', 'write JSON')
    .action(async (file: string, commandOptions: { json?: boolean }) => {
      const config = loadApplicationConfig(environment);
      const result = await restorePortableBackup({
        backupDirectory: join(config.paths.dataDirectory, 'backups'),
        backupPath: resolve(file),
        databasePath: config.paths.databasePath,
      });
      write(
        commandOptions.json
          ? `${JSON.stringify(result)}\n`
          : `backup restored\t${result.path}\nschema\t${result.manifest.database.schemaVersion}\n${result.preRestoreBackupPath === undefined ? '' : `previous database\t${result.preRestoreBackupPath}\n`}accounts\treconnect required (secrets are excluded)\n`,
      );
    });

  const mcp = program.command('mcp').description('Run the local stdio MCP server');
  mcp.command('start').action(async () => {
    const context = mcpContext(environment);
    try {
      const { createMcpServer, serveMcpStdio } = await import('@openrepurpose/server');
      await serveMcpStdio(createMcpServer(context));
    } finally {
      context.database.close();
    }
  });

  const models = program
    .command('models')
    .description('Manage local whisper.cpp transcription models');
  models
    .command('list')
    .option('--json', 'write JSON')
    .action(async (commandOptions: { json?: boolean }) => {
      const manager = options.modelManager ?? createModelManager(environment);
      const snapshot = await manager.list();
      write(
        commandOptions.json
          ? `${JSON.stringify(snapshot)}\n`
          : [
              `storage\t${snapshot.storagePath}`,
              `free\t${formatModelBytes(snapshot.availableBytes)}`,
              ...snapshot.models.map(
                (model) =>
                  `${model.id}\t${model.status}\t${model.languageSupport}\t${formatModelBytes(model.sizeBytes)}\t${model.performance}\t${model.integrity}`,
              ),
            ].join('\n') + '\n',
      );
    });
  models
    .command('download <id>')
    .description('Download and verify one model after an explicit user request')
    .option('--json', 'write JSON')
    .action(async (id: string, commandOptions: { json?: boolean }) => {
      const manager = options.modelManager ?? createModelManager(environment);
      let lastReported = -1;
      const model = await manager.download(id, {
        ...(commandOptions.json
          ? {}
          : {
              onProgress: (progress) => {
                const percent = Math.floor(progress.percent ?? 0);
                if (percent < 100 && percent - lastReported < 5) return;
                lastReported = percent;
                write(
                  `${id}\tdownloading\t${percent}%\t${formatModelBytes(progress.downloadedBytes)}/${formatModelBytes(progress.totalBytes)}\n`,
                );
              },
            }),
      });
      write(
        commandOptions.json
          ? `${JSON.stringify(model)}\n`
          : `${model.id}\t${model.status}\t${model.integrity}\n`,
      );
    });
  models
    .command('verify <id>')
    .description('Recompute and compare the published model checksum')
    .option('--json', 'write JSON')
    .action(async (id: string, commandOptions: { json?: boolean }) => {
      const manager = options.modelManager ?? createModelManager(environment);
      const model = await manager.verify(id);
      write(
        commandOptions.json
          ? `${JSON.stringify(model)}\n`
          : `${model.id}\t${model.status}\t${model.integrity}\n`,
      );
    });
  models
    .command('delete <id>')
    .description('Delete one locally installed transcription model')
    .option('--json', 'write JSON')
    .action(async (id: string, commandOptions: { json?: boolean }) => {
      const manager = options.modelManager ?? createModelManager(environment);
      const model = await manager.delete(id);
      write(commandOptions.json ? `${JSON.stringify(model)}\n` : `${model.id}\t${model.status}\n`);
    });

  const transcript = program.command('transcript').description('Inspect and export transcripts');
  transcript
    .command('show <id>')
    .option('--json', 'write JSON')
    .action((id: string, commandOptions: { json?: boolean }) => {
      const context = transcriptContext(environment);
      try {
        const result = context.service.show(id);
        if (result === undefined) throw new Error(`Transcript not found: ${id}`);
        write(
          commandOptions.json
            ? `${JSON.stringify(result)}\n`
            : [
                `${result.id}\t${result.language ?? 'auto'}\t${result.providerId}/${result.model.id}`,
                ...result.cues.map(
                  (cue, index) =>
                    `${index + 1}\t${cue.startMs}-${cue.endMs}\t${cue.text.replace(/\r?\n/g, ' ')}`,
                ),
              ].join('\n') + '\n',
        );
      } finally {
        context.database.close();
      }
    });
  transcript
    .command('export <id>')
    .requiredOption('--format <format>', 'srt or vtt')
    .action((id: string, commandOptions: { format: string }) => {
      if (commandOptions.format !== 'srt' && commandOptions.format !== 'vtt')
        throw new Error('Subtitle format must be srt or vtt.');
      const context = transcriptContext(environment);
      try {
        write(context.service.export(id, commandOptions.format).content);
      } finally {
        context.database.close();
      }
    });

  const media = program.command('media').description('Manage local media');
  media.command('import <path>').action(async (path: string) => {
    const context = await mediaImportContext(environment);
    try {
      const result = await context.service.import(path);
      write(
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
      const context = mediaReadContext(environment);
      try {
        const assets = context.repository.list();
        write(
          options.json
            ? `${JSON.stringify(assets)}\n`
            : assets.map((asset) => `${asset.id}\t${asset.state}\t${asset.path}`).join('\n') +
                (assets.length > 0 ? '\n' : ''),
        );
      } finally {
        context.database.close();
      }
    });
  media
    .command('probe <id>')
    .description('Probe current local media metadata')
    .option('--json', 'write JSON')
    .action(async (id: string, commandOptions: { json?: boolean }) => {
      const context = mediaReadContext(environment);
      try {
        const asset = context.repository.findById(id);
        if (asset === undefined) throw new Error(`Media not found: ${id}`);
        const probe =
          options.mediaProbe ??
          (await (async () => {
            const executables = await discoverMediaExecutables();
            if (executables.ffprobe === undefined)
              throw new Error('ffprobe was not found. Set FFPROBE_PATH or add ffprobe to PATH.');
            return new FfprobeMediaProbe(executables.ffprobe);
          })());
        const result = { ...asset, metadata: await probe.probe(asset.path) };
        write(
          commandOptions.json
            ? `${JSON.stringify(result)}\n`
            : [
                `${result.id}\t${result.state}\t${result.path}`,
                `size: ${result.sizeBytes}`,
                `video: ${result.metadata.videoCodec ?? 'unknown'}\t${result.metadata.width ?? '?'}x${result.metadata.height ?? '?'}`,
                `audio: ${result.metadata.hasAudio ? (result.metadata.audioCodec ?? 'present') : 'none'}`,
                `duration: ${result.metadata.durationSeconds ?? 'unknown'} seconds`,
              ].join('\n') + '\n',
        );
      } finally {
        context.database.close();
      }
    });

  const transforms = program.command('transform').description('Run and inspect media transforms');
  transforms
    .command('run <media-id>')
    .option('--preset <preset>', 'vertical, square, or landscape')
    .option('--width <pixels>', 'custom output width')
    .option('--height <pixels>', 'custom output height')
    .option('--fit <mode>', 'crop, contain, or stretch', 'crop')
    .option('--anchor <anchor>', 'center, top, bottom, left, or right', 'center')
    .option('--json', 'write JSON')
    .action(
      async (
        mediaId: string,
        commandOptions: {
          anchor?: string;
          fit?: string;
          height?: string;
          json?: boolean;
          preset?: string;
          width?: string;
        },
      ) => {
        const plan = transformPlanFromOptions(commandOptions);
        const context = await transformContext(environment, options.transformTool);
        try {
          const result = context.service.run(mediaId, plan);
          write(
            commandOptions.json
              ? `${JSON.stringify(result)}\n`
              : result.job === undefined
                ? `Reused derivative ${result.derivative.id}\t${result.derivative.status}\n`
                : [
                    `Queued derivative ${result.derivative.id}\t${result.derivative.status}`,
                    `job: ${result.job.id}\t${result.job.status}`,
                    `inspect: openrepurpose transform inspect ${result.derivative.id}`,
                    `cancel: openrepurpose jobs cancel ${result.job.id}`,
                  ].join('\n') + '\n',
          );
        } finally {
          context.database.close();
        }
      },
    );
  transforms
    .command('inspect <derivative-id>')
    .option('--json', 'write JSON')
    .action((id: string, commandOptions: { json?: boolean }) => {
      const context = derivativeContext(environment);
      try {
        const derivative = context.derivatives.findById(id);
        if (derivative === undefined) throw new Error(`Transform derivative not found: ${id}`);
        const progress =
          derivative.progress?.percent === undefined
            ? derivative.status
            : `${derivative.progress.percent.toFixed(1)}%`;
        write(
          commandOptions.json
            ? `${JSON.stringify(derivative)}\n`
            : [
                `${derivative.id}\t${derivative.status}\t${progress}`,
                `source: ${derivative.provenance.sourceMediaId}`,
                `recipe: ${derivative.provenance.recipeHash}`,
                `encoder: ${derivative.provenance.encoder}\t${derivative.provenance.ffmpegVersion}`,
                ...(derivative.output === undefined
                  ? []
                  : [
                      `output: ${derivative.output.path}`,
                      `video: ${derivative.output.metadata.videoCodec}\t${derivative.output.metadata.width}x${derivative.output.metadata.height}`,
                      `audio: ${derivative.output.metadata.hasAudio ? (derivative.output.metadata.audioCodec ?? 'present') : 'none'}`,
                      `size: ${derivative.output.sizeBytes}`,
                    ]),
                ...(derivative.errorMessage === undefined
                  ? []
                  : [
                      `error: ${derivative.errorCode ?? 'TRANSFORM_FAILED'}\t${derivative.errorMessage}`,
                    ]),
              ].join('\n') + '\n',
        );
      } finally {
        context.database.close();
      }
    });

  const accounts = program.command('accounts').description('Manage publishing accounts');
  accounts
    .command('list')
    .option('--json', 'write JSON')
    .action(async (options: { json?: boolean }) => {
      const context = accountContext(environment);
      try {
        const results = context.youtube.listAccounts();
        write(
          options.json
            ? `${JSON.stringify(results)}\n`
            : results
                .map(
                  (account) =>
                    `${account.id}\t${account.provider}\t${account.status}\t${account.displayName}`,
                )
                .join('\n') + (results.length > 0 ? '\n' : ''),
        );
      } finally {
        context.database.close();
      }
    });
  const addAccount = accounts.command('add').description('Configure and connect an account');
  addAccount
    .command('youtube')
    .requiredOption('--credentials <path>', 'Google OAuth desktop-client JSON file')
    .action(async (options: { credentials: string }) => {
      const context = accountContext(environment);
      try {
        await context.youtube.configureCredentials(readGoogleCredentials(options.credentials));
        const accountsUrl = new URL('/accounts', loadApplicationConfig(environment).appUrl);
        write(`Google OAuth credentials saved. Connect YouTube in ${accountsUrl.toString()}\n`);
      } finally {
        context.database.close();
      }
    });
  accounts.command('remove <id>').action(async (id: string) => {
    const context = accountContext(environment);
    try {
      const removed =
        (await context.youtube.removeAccount(id)) ?? (await context.tiktok.removeAccount(id));
      if (removed === undefined) throw new Error(`Account not found: ${id}`);
      write(`Removed ${removed.provider} account ${removed.displayName}.\n`);
    } finally {
      context.database.close();
    }
  });

  addAccount
    .command('tiktok')
    .requiredOption('--client-key <key>', 'TikTok Login Kit client key')
    .requiredOption('--client-secret <secret>', 'TikTok Login Kit client secret')
    .action(async (options: { clientKey: string; clientSecret: string }) => {
      const context = accountContext(environment);
      try {
        await context.tiktok.configureCredentials(options);
        const accountsUrl = new URL('/accounts', loadApplicationConfig(environment).appUrl);
        write(`TikTok credentials saved. Connect TikTok in ${accountsUrl.toString()}\n`);
      } finally {
        context.database.close();
      }
    });

  const publish = program.command('publish').description('Queue destination publishes');
  publish
    .command('tiktok <media-id>')
    .requiredOption('--account <account-id>', 'Connected TikTok account ID')
    .option('--caption <caption>', 'TikTok caption')
    .option('--privacy <privacy-level>', 'TikTok privacy level', 'SELF_ONLY')
    .option('--disable-comment', 'Disable comments')
    .option('--disable-duet', 'Disable duet')
    .option('--disable-stitch', 'Disable stitch')
    .option('--json', 'write JSON')
    .action(
      async (
        mediaId: string,
        options: {
          account: string;
          caption?: string;
          privacy: string;
          disableComment?: boolean;
          disableDuet?: boolean;
          disableStitch?: boolean;
          json?: boolean;
        },
      ) => {
        const context = publishContext(environment);
        try {
          if (context.media.list().every((asset) => asset.id !== mediaId))
            throw new Error(`Media not found: ${mediaId}`);
          const capabilities = await context.tiktok.getAccountCapabilities(options.account);
          if (!capabilities.directPostAvailable)
            throw new Error('TikTok Direct Post is not available for this account.');
          if (
            !capabilities.privacyLevelOptions.includes(
              options.privacy as (typeof capabilities.privacyLevelOptions)[number],
            )
          )
            throw new Error(`Privacy level is unavailable for this creator: ${options.privacy}`);
          const result = context.jobs.create({
            type: 'tiktok.direct-post',
            idempotencyKey: `manual:tiktok:${mediaId}:${options.account}`,
            input: {
              mediaId,
              accountId: options.account,
              metadata: {
                privacyLevel: options.privacy,
                ...(options.caption === undefined ? {} : { caption: options.caption }),
                ...(options.disableComment === undefined
                  ? {}
                  : { disableComment: options.disableComment }),
                ...(options.disableDuet === undefined ? {} : { disableDuet: options.disableDuet }),
                ...(options.disableStitch === undefined
                  ? {}
                  : { disableStitch: options.disableStitch }),
              },
            },
          });
          write(
            options.json
              ? `${JSON.stringify(result)}\n`
              : `${result.job.id}\t${result.job.status}\ttiktok\n`,
          );
        } finally {
          context.database.close();
        }
      },
    );

  const workflows = program
    .command('workflows')
    .description('Manage local and remote-source workflows');
  workflows
    .command('list')
    .option('--json', 'write JSON')
    .action((options: { json?: boolean }) => {
      const context = workflowContext(environment);
      try {
        const results = context.service.list();
        write(
          options.json
            ? `${JSON.stringify(results)}\n`
            : results
                .map(
                  (workflow) =>
                    `${workflow.id}\t${workflow.enabled ? 'enabled' : 'disabled'}\t${workflow.name}\t${workflow.sourceDirectory}`,
                )
                .join('\n') + (results.length > 0 ? '\n' : ''),
        );
      } finally {
        context.database.close();
      }
    });

  const sources = program.command('sources').description('Manage remote media sources');
  sources
    .command('list')
    .option('--json', 'write JSON')
    .action((options: { json?: boolean }) => {
      const context = sourceContext(environment);
      try {
        const results = context.service.list();
        write(
          options.json
            ? `${JSON.stringify(results)}\n`
            : results
                .map(
                  (source) =>
                    `${source.id}\t${source.status}\t${source.adapterId}\t${source.displayName}`,
                )
                .join('\n') + (results.length > 0 ? '\n' : ''),
        );
      } finally {
        context.database.close();
      }
    });
  const addSource = sources.command('add').description('Add a remote source');
  addSource
    .command('youtube')
    .requiredOption('--account <account-id>', 'Connected YouTube account ID')
    .requiredOption('--channel <channel-id>', 'YouTube channel ID to poll')
    .option('--name <display-name>', 'Local display name')
    .option('--json', 'write JSON')
    .action((options: { account: string; channel: string; name?: string; json?: boolean }) => {
      const context = sourceContext(environment);
      try {
        const source = context.service.addYouTube({
          accountId: options.account,
          channelId: options.channel,
          ...(options.name === undefined ? {} : { displayName: options.name }),
        });
        write(
          options.json ? `${JSON.stringify(source)}\n` : `${source.id}\t${source.displayName}\n`,
        );
      } finally {
        context.database.close();
      }
    });
  addSource
    .command('twitch')
    .requiredOption('--account <account-id>', 'Connected Twitch account ID')
    .requiredOption('--broadcaster <broadcaster-id>', 'Twitch broadcaster ID to poll')
    .requiredOption('--kind <clips|vods>', 'Source type')
    .option('--editor <editor-id>', 'Connected editor ID for official clip download')
    .option('--name <display-name>', 'Local display name')
    .option('--json', 'write JSON')
    .action(
      (options: {
        account: string;
        broadcaster: string;
        editor?: string;
        kind: string;
        name?: string;
        json?: boolean;
      }) => {
        if (options.kind !== 'clips' && options.kind !== 'vods')
          throw new Error('Twitch source kind must be clips or vods.');
        const context = sourceContext(environment);
        try {
          const source = context.service.addTwitch({
            accountId: options.account,
            broadcasterId: options.broadcaster,
            kind: options.kind,
            ...(options.editor === undefined ? {} : { editorId: options.editor }),
            ...(options.name === undefined ? {} : { displayName: options.name }),
          });
          write(
            options.json ? `${JSON.stringify(source)}\n` : `${source.id}\t${source.displayName}\n`,
          );
        } finally {
          context.database.close();
        }
      },
    );
  addSource
    .command('kick')
    .requiredOption('--account <account-id>', 'Connected Kick account ID')
    .requiredOption('--broadcaster <broadcaster-id>', 'Kick broadcaster ID to poll')
    .option('--name <display-name>', 'Local display name')
    .option('--json', 'write JSON')
    .action((options: { account: string; broadcaster: string; name?: string; json?: boolean }) => {
      const context = sourceContext(environment);
      try {
        const source = context.service.addKick({
          accountId: options.account,
          broadcasterId: options.broadcaster,
          ...(options.name === undefined ? {} : { displayName: options.name }),
        });
        write(
          options.json ? `${JSON.stringify(source)}\n` : `${source.id}\t${source.displayName}\n`,
        );
      } finally {
        context.database.close();
      }
    });
  for (const action of ['poll', 'pause', 'resume'] as const)
    sources
      .command(`${action} <id>`)
      .option('--json', 'write JSON')
      .action((id: string, options: { json?: boolean }) => {
        const context = sourceContext(environment);
        try {
          const source = context.service[action](id);
          if (source === undefined) throw new Error(`Source not found: ${id}`);
          write(options.json ? `${JSON.stringify(source)}\n` : `${source.id}\t${source.status}\n`);
        } finally {
          context.database.close();
        }
      });

  const jobs = program.command('jobs').description('Inspect and control persistent jobs');
  jobs
    .command('list')
    .option('--status <status>', 'filter by job status')
    .option('--json', 'write JSON')
    .action((options: { json?: boolean; status?: string }) => {
      const statuses = new Set<JobStatus>([
        'pending',
        'running',
        'retrying',
        'succeeded',
        'failed',
        'cancelled',
      ]);
      if (options.status !== undefined && !statuses.has(options.status as JobStatus))
        throw new Error(`Unknown job status: ${options.status}`);
      const context = jobContext(environment);
      try {
        const results = context.service.list(options.status as JobStatus | undefined);
        write(
          options.json
            ? `${JSON.stringify(results)}\n`
            : results
                .map(
                  (job) =>
                    `${job.id}\t${job.status}\t${job.type}\t${job.attemptCount}/${job.maxAttempts}`,
                )
                .join('\n') + (results.length > 0 ? '\n' : ''),
        );
      } finally {
        context.database.close();
      }
    });
  jobs
    .command('show <job-id>')
    .option('--json', 'write JSON')
    .action((id: string, options: { json?: boolean }) => {
      const context = jobContext(environment);
      try {
        const details = context.service.show(id);
        if (details === undefined) throw new Error(`Job not found: ${id}`);
        write(
          options.json
            ? `${JSON.stringify(details)}\n`
            : [
                `${details.job.id}\t${details.job.status}\t${details.job.type}`,
                `attempts: ${details.attempts.length}/${details.job.maxAttempts}`,
                ...details.attempts.map(
                  (attempt) =>
                    `#${attempt.attemptNumber}\t${attempt.status}${attempt.errorCode === undefined ? '' : `\t${attempt.errorCode}`}`,
                ),
              ].join('\n') + '\n',
        );
      } finally {
        context.database.close();
      }
    });
  jobs
    .command('retry <job-id>')
    .option('--json', 'write JSON')
    .action((id: string, options: { json?: boolean }) => {
      const context = jobContext(environment);
      try {
        const job = context.service.retry(id);
        if (job === undefined) throw new Error(`Job not found or not failed: ${id}`);
        write(options.json ? `${JSON.stringify(job)}\n` : `${job.id}\t${job.status}\n`);
      } finally {
        context.database.close();
      }
    });
  jobs
    .command('cancel <job-id>')
    .option('--json', 'write JSON')
    .action((id: string, options: { json?: boolean }) => {
      const context = jobContext(environment);
      try {
        const existing = context.service.show(id)?.job;
        const job =
          existing?.type === 'media.transform'
            ? context.transforms.cancelJob(id)
            : context.service.cancel(id);
        if (job === undefined) throw new Error(`Job not found: ${id}`);
        write(options.json ? `${JSON.stringify(job)}\n` : `${job.id}\t${job.status}\n`);
      } finally {
        context.database.close();
      }
    });
  for (const action of ['pause', 'resume'] as const)
    jobs
      .command(action)
      .option('--json', 'write JSON')
      .action((options: { json?: boolean }) => {
        const context = jobContext(environment);
        try {
          const queue =
            action === 'pause' ? context.service.pauseQueue() : context.service.resumeQueue();
          write(options.json ? `${JSON.stringify(queue)}\n` : `${queue.mode}\n`);
        } finally {
          context.database.close();
        }
      });

  const schedules = program.command('schedule').description('Inspect durable schedules');
  schedules
    .command('list')
    .option('--json', 'write JSON')
    .action((options: { json?: boolean }) => {
      const context = scheduleContext(environment);
      try {
        const results = context.schedules.list();
        write(
          options.json
            ? `${JSON.stringify(results)}\n`
            : results
                .map(
                  (schedule) =>
                    `${schedule.id}\t${schedule.status}\t${schedule.timeZone}\t${schedule.nextOccurrenceAt?.toISOString() ?? '-'}\t${schedule.target.kind}`,
                )
                .join('\n') + (results.length > 0 ? '\n' : ''),
        );
      } finally {
        context.database.close();
      }
    });
  schedules
    .command('show <schedule-id>')
    .option('--json', 'write JSON')
    .action((id: string, options: { json?: boolean }) => {
      const context = scheduleContext(environment);
      try {
        const schedule = context.schedules.show(id);
        if (schedule === undefined) throw new Error(`Schedule not found: ${id}`);
        write(
          options.json
            ? `${JSON.stringify(schedule)}\n`
            : [
                `${schedule.id}\t${schedule.status}\t${schedule.timeZone}`,
                `target: ${schedule.target.kind}\t${schedule.target.sourceConnectionId}`,
                `next: ${schedule.nextOccurrenceAt?.toISOString() ?? '-'}`,
                `last: ${schedule.lastOccurrenceAt?.toISOString() ?? '-'}`,
                `definition: ${JSON.stringify(schedule.definition)}`,
              ].join('\n') + '\n',
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
