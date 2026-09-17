import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Command } from 'commander';
import { JobService, MediaImportService, WorkflowService } from '@openrepurpose/core';
import type { JobStatus } from '@openrepurpose/core';
import {
  openDatabase,
  runMigrations,
  SqliteAccountRepository,
  SqliteJobRepository,
  SqliteMediaRepository,
  SqliteOAuthAuthorizationRequestRepository,
  SqliteWorkflowRepository,
} from '@openrepurpose/db';
import {
  discoverMediaExecutables,
  FfprobeMediaProbe,
  LocalMediaFileInspector,
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

async function mediaContext(environment: Environment) {
  const config = loadApplicationConfig(environment);
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

function jobContext(environment: Environment) {
  const config = loadApplicationConfig(environment);
  const database = openDatabase(config.paths.databasePath);
  runMigrations(database);
  return { database, service: new JobService(new SqliteJobRepository(database)) };
}
function workflowContext(environment: Environment) {
  const config = loadApplicationConfig(environment);
  const database = openDatabase(config.paths.databasePath);
  runMigrations(database);
  const jobs = new JobService(new SqliteJobRepository(database));
  return { database, service: new WorkflowService(new SqliteWorkflowRepository(database), jobs) };
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
  readonly write?: (value: string) => void;
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
    const context = await mediaContext(environment);
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
      const context = await mediaContext(environment);
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

  const workflows = program.command('workflows').description('Manage watched-folder workflows');
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
    .command('cancel <job-id>')
    .option('--json', 'write JSON')
    .action((id: string, options: { json?: boolean }) => {
      const context = jobContext(environment);
      try {
        const job = context.service.cancel(id);
        if (job === undefined) throw new Error(`Job not found: ${id}`);
        write(options.json ? `${JSON.stringify(job)}\n` : `${job.id}\t${job.status}\n`);
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
