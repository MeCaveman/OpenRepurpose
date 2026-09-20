import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Command } from 'commander';
import {
  JobService,
  MediaImportService,
  ScheduleService,
  SourceService,
  TransformService,
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
  SqliteAccountRepository,
  SqliteJobRepository,
  SqliteMediaRepository,
  SqliteOAuthAuthorizationRequestRepository,
  SqliteScheduleRepository,
  SqliteSourcePollingRepository,
  SqliteTransformDerivativeRepository,
  SqliteWorkflowRepository,
} from '@openrepurpose/db';
import {
  discoverMediaExecutables,
  FfprobeMediaProbe,
  LocalMediaFileInspector,
  readFfmpegVersion,
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
  /** Test/runtime composition hook; normal CLI use discovers the concrete local FFmpeg build. */
  readonly transformTool?: TransformToolIdentity;
  readonly write?: (value: string) => void;
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
  program.command('doctor').action(() => {
    const checks = runDoctor(environment);
    for (const check of checks)
      write(`${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.detail}\n`);
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
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
