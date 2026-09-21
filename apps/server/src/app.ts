import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fastifySecureSession from '@fastify/secure-session';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController } from 'fastify';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApplicationConfig } from '@openrepurpose/shared';
import { ModelManagerError, type TranscriptionModelManager } from '@openrepurpose/media';
import { isPlatformError, REDACTED_LOG_VALUE } from '@openrepurpose/platform-sdk';
import type { YouTubeOAuthService } from '@openrepurpose/youtube';
import type { TikTokOAuthService } from '@openrepurpose/tiktok';
import type { MetaOAuthService } from '@openrepurpose/meta';
import type {
  JobService,
  JobRunner,
  JobStatus,
  DestinationJobRepository,
  MediaImportService,
  MediaRepository,
  WorkflowInput,
  WorkflowService,
  SourceService,
  SourceWorkflowCoordinator,
  TransformService,
  TranscriptService,
} from '@openrepurpose/core';
import { TranscriptServiceError, transcriptEditRequestSchema } from '@openrepurpose/core';

declare module '@fastify/secure-session' {
  interface SessionData {
    csrfToken?: string;
  }
}

const stateChangingMethods = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);
const defaultStaticRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));

export interface LoggerDestination {
  write(chunk: string): void;
}

export interface BuildServerOptions {
  readonly config: ApplicationConfig;
  readonly jobService?: JobService;
  readonly jobRunner?: Pick<JobRunner, 'drain'>;
  readonly destinationJobRepository?: DestinationJobRepository;
  readonly logger?: boolean;
  readonly loggerDestination?: LoggerDestination;
  readonly mediaImportService?: MediaImportService;
  readonly mediaRepository?: MediaRepository;
  readonly metaOAuthService?: MetaOAuthService;
  readonly modelManager?: TranscriptionModelManager;
  readonly sessionKey: Buffer;
  readonly sourceService?: SourceService;
  readonly sourceWorkflowCoordinator?: Pick<SourceWorkflowCoordinator, 'retryFailedDestinations'>;
  readonly staticRoot?: false | string;
  readonly tiktokOAuthService?: TikTokOAuthService;
  readonly transformService?: TransformService;
  readonly transcriptService?: TranscriptService;
  readonly youtubeOAuthService?: YouTubeOAuthService;
  readonly workflowService?: WorkflowService;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function forbidden(reply: FastifyReply, code: string) {
  return reply.code(403).send({ error: 'Forbidden', code });
}

function csrfTokensMatch(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return (
    expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

function isApiMutation(request: FastifyRequest): boolean {
  return request.url.startsWith('/api/') && stateChangingMethods.has(request.method);
}

export function assertLocalOnly(config: ApplicationConfig): void {
  const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);
  if (!loopbackHosts.has(normalizeHostname(config.bindHost))) {
    throw new Error(
      `Public or LAN binding (${config.bindHost}) is not enabled in v0.1. Use a loopback BIND_HOST.`,
    );
  }
  if (!loopbackHosts.has(normalizeHostname(config.appUrl.hostname))) {
    throw new Error(
      `Public APP_URL hosts (${config.appUrl.hostname}) are not enabled in v0.1. Use a loopback URL.`,
    );
  }
}

const sensitiveLogPaths = [
  'authorization',
  'cookie',
  'password',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'clientSecret',
  'authorizationCode',
  '*.authorization',
  '*.cookie',
  '*.password',
  '*.secret',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.clientSecret',
  '*.authorizationCode',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
] as const;

export function buildServer(options: BuildServerOptions): FastifyInstance {
  if (options.sessionKey.length !== 32) {
    throw new Error('The secure session key must contain exactly 32 bytes.');
  }

  const server = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    logger:
      options.logger === true
        ? {
            redact: { paths: [...sensitiveLogPaths], censor: REDACTED_LOG_VALUE },
            serializers: {
              err: (error: FastifyError) => ({
                type: error.name,
                message: 'Request failed.',
                stack: REDACTED_LOG_VALUE,
              }),
            },
            ...(options.loggerDestination === undefined
              ? {}
              : { stream: options.loggerDestination }),
          }
        : false,
    trustProxy: false,
  });
  const allowedOrigins = new Set([options.config.appUrl.origin]);
  if (options.config.developmentServerUrl !== undefined) {
    allowedOrigins.add(options.config.developmentServerUrl.origin);
  }
  const allowedHosts = new Set(
    [
      options.config.appUrl.hostname,
      options.config.bindHost,
      options.config.developmentServerUrl?.hostname,
    ]
      .filter((hostname): hostname is string => hostname !== undefined)
      .map(normalizeHostname),
  );

  server.register(fastifySecureSession, {
    cookieName: 'openrepurpose_session',
    expiry: 12 * 60 * 60,
    key: options.sessionKey,
    cookie: {
      httpOnly: true,
      maxAge: 12 * 60 * 60,
      path: '/',
      // OAuth returns through a top-level cross-site GET; Lax carries this HTTP-only binding cookie.
      // Origin validation plus the per-session CSRF token still protects every API mutation.
      sameSite: 'lax',
      secure: options.config.appUrl.protocol === 'https:',
    },
  });

  server.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        path: request.url.split('?', 1)[0],
        statusCode: reply.statusCode,
      },
      'Request completed',
    );
  });
  server.addHook('onRequest', async (request, reply) => {
    if (!allowedHosts.has(normalizeHostname(request.hostname))) {
      return reply.code(421).send({ error: 'Misdirected Request', code: 'HOST_NOT_ALLOWED' });
    }

    reply
      .header(
        'Content-Security-Policy',
        "default-src 'self'; base-uri 'self'; frame-ancestors 'none'",
      )
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'DENY');

    if (!isApiMutation(request)) return;

    const origin = request.headers.origin;
    if (origin === undefined || !allowedOrigins.has(origin)) {
      return forbidden(reply, 'ORIGIN_NOT_ALLOWED');
    }

    const suppliedToken = request.headers['x-csrf-token'];
    const expectedToken = request.session.get('csrfToken');
    if (
      typeof suppliedToken !== 'string' ||
      typeof expectedToken !== 'string' ||
      !csrfTokensMatch(expectedToken, suppliedToken)
    ) {
      return forbidden(reply, 'CSRF_TOKEN_INVALID');
    }
  });

  server.get(
    '/api/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['service', 'status', 'version'],
            properties: {
              service: { type: 'string' },
              status: { type: 'string' },
              version: { type: 'string' },
            },
          },
        },
      },
    },
    async () => ({ service: 'openrepurpose', status: 'ok', version: '0.1.0' }),
  );

  if (options.modelManager !== undefined) {
    const models = options.modelManager;
    const modelFailure = (error: unknown, reply: FastifyReply) => {
      if (!(error instanceof ModelManagerError)) throw error;
      const statusCode =
        error.code === 'MODEL_NOT_FOUND' || error.code === 'MODEL_NOT_INSTALLED'
          ? 404
          : error.code === 'MODEL_ALREADY_DOWNLOADING'
            ? 409
            : error.code === 'MODEL_DISK_SPACE_LOW' ||
                error.code === 'MODEL_CHECKSUM_MISMATCH' ||
                error.code === 'MODEL_STORAGE_UNSAFE'
              ? 422
              : 502;
      return reply.code(statusCode).send({ error: error.message, code: error.code });
    };
    server.get('/api/transcription/models', async () => models.list());
    server.post<{ Params: { id: string } }>(
      '/api/transcription/models/:id/download',
      async (request, reply) => {
        try {
          return reply.code(202).send({ model: await models.startDownload(request.params.id) });
        } catch (error) {
          return modelFailure(error, reply);
        }
      },
    );
    server.post<{ Params: { id: string } }>(
      '/api/transcription/models/:id/verify',
      async (request, reply) => {
        try {
          return { model: await models.verify(request.params.id) };
        } catch (error) {
          return modelFailure(error, reply);
        }
      },
    );
    server.delete<{ Params: { id: string } }>(
      '/api/transcription/models/:id',
      async (request, reply) => {
        try {
          return { model: await models.delete(request.params.id) };
        } catch (error) {
          return modelFailure(error, reply);
        }
      },
    );
  }

  if (options.transcriptService !== undefined) {
    const transcripts = options.transcriptService;
    const transcriptFailure = (error: unknown, reply: FastifyReply) => {
      if (!(error instanceof TranscriptServiceError)) throw error;
      const statusCode =
        error.code === 'TRANSCRIPT_NOT_FOUND'
          ? 404
          : error.code === 'TRANSCRIPT_REVISION_CONFLICT'
            ? 409
            : 422;
      return reply.code(statusCode).send({ error: error.message, code: error.code });
    };

    server.get<{ Params: { id: string } }>('/api/media/:id/transcripts', async (request, reply) => {
      try {
        return { transcripts: transcripts.listForMedia(request.params.id) };
      } catch (error) {
        return transcriptFailure(error, reply);
      }
    });
    server.get<{ Params: { id: string } }>('/api/transcripts/:id', async (request, reply) => {
      try {
        const transcript = transcripts.show(request.params.id);
        return transcript === undefined
          ? reply.code(404).send({ error: 'Transcript not found.', code: 'TRANSCRIPT_NOT_FOUND' })
          : { transcript };
      } catch (error) {
        return transcriptFailure(error, reply);
      }
    });
    server.put<{ Params: { id: string }; Body: unknown }>(
      '/api/transcripts/:id',
      async (request, reply) => {
        const edit = transcriptEditRequestSchema.safeParse(request.body);
        if (!edit.success)
          return reply.code(400).send({
            error: edit.error.issues[0]?.message ?? 'The transcript edit is invalid.',
            code: 'TRANSCRIPT_INVALID',
          });
        try {
          return { transcript: transcripts.save(request.params.id, edit.data) };
        } catch (error) {
          return transcriptFailure(error, reply);
        }
      },
    );
    server.get<{ Params: { id: string }; Querystring: { format?: string } }>(
      '/api/transcripts/:id/export',
      async (request, reply) => {
        const format = request.query.format;
        if (format !== 'srt' && format !== 'vtt')
          return reply.code(400).send({
            error: 'Subtitle format must be srt or vtt.',
            code: 'TRANSCRIPT_EXPORT_FORMAT_INVALID',
          });
        try {
          const exported = transcripts.export(request.params.id, format);
          return reply
            .type(
              format === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/vtt; charset=utf-8',
            )
            .header('Content-Disposition', `attachment; filename="transcript.${format}"`)
            .send(exported.content);
        } catch (error) {
          return transcriptFailure(error, reply);
        }
      },
    );
  }

  if (
    options.youtubeOAuthService !== undefined ||
    options.tiktokOAuthService !== undefined ||
    options.metaOAuthService !== undefined
  ) {
    const youtube = options.youtubeOAuthService;
    const tiktok = options.tiktokOAuthService;
    const meta = options.metaOAuthService;
    const accounts = youtube ?? tiktok;
    const safePlatformFailure = (error: unknown, reply: FastifyReply) => {
      if (!isPlatformError(error)) throw error;
      return reply
        .code(error.category === 'configuration' || error.category === 'validation' ? 400 : 502)
        .send({
          error: error.publicMessage,
          code: error.code,
        });
    };
    server.get('/api/accounts', async () => ({
      accounts: accounts?.listAccounts() ?? [],
      youtube: await youtube?.credentialStatus(),
      tiktok: await tiktok?.credentialStatus(),
      meta: await meta?.credentialStatus(),
      metaCredentials: meta?.listCredentials() ?? [],
      metaTargets: meta?.listTargets() ?? [],
    }));
    server.get('/api/setup', async () => ({
      youtube: await youtube?.credentialStatus(),
      tiktok: await tiktok?.credentialStatus(),
      meta: await meta?.credentialStatus(),
    }));
    if (youtube !== undefined) {
      server.post<{
        Body: { clientId?: unknown; clientSecret?: unknown };
      }>('/api/accounts/youtube/credentials', async (request, reply) => {
        if (
          typeof request.body?.clientId !== 'string' ||
          (request.body.clientSecret !== undefined && typeof request.body.clientSecret !== 'string')
        ) {
          return reply.code(400).send({
            error: 'A client ID and optional client secret are required.',
            code: 'INVALID_YOUTUBE_CREDENTIALS',
          });
        }
        try {
          await youtube.configureCredentials({
            clientId: request.body.clientId,
            ...(request.body.clientSecret === undefined
              ? {}
              : { clientSecret: request.body.clientSecret }),
          });
          return { youtube: await youtube.credentialStatus() };
        } catch (error) {
          return safePlatformFailure(error, reply);
        }
      });
      server.post('/api/accounts/youtube/oauth/start', async (request, reply) => {
        try {
          const browserBinding = request.session.get('csrfToken');
          if (typeof browserBinding !== 'string')
            return reply.code(403).send({
              error: 'A local browser session is required.',
              code: 'YOUTUBE_OAUTH_SESSION_REQUIRED',
            });
          return await youtube.beginAuthorization(browserBinding);
        } catch (error) {
          return safePlatformFailure(error, reply);
        }
      });
      server.get<{
        Querystring: { code?: string; error?: string; state?: string };
      }>('/api/accounts/youtube/oauth/callback', async (request, reply) => {
        const destination = new URL('/accounts', options.config.appUrl);
        try {
          const browserBinding = request.session.get('csrfToken');
          await youtube.completeAuthorization({
            ...request.query,
            ...(typeof browserBinding === 'string' ? { browserBinding } : {}),
          });
          destination.searchParams.set('youtube', 'connected');
        } catch (error) {
          destination.searchParams.set('youtube', 'error');
          destination.searchParams.set(
            'code',
            isPlatformError(error) ? error.code : 'YOUTUBE_OAUTH_CALLBACK_FAILED',
          );
        }
        return reply.redirect(destination.toString());
      });
    }
    if (tiktok !== undefined) {
      server.post<{
        Body: { clientKey?: unknown; clientSecret?: unknown };
      }>('/api/accounts/tiktok/credentials', async (request, reply) => {
        if (
          typeof request.body?.clientKey !== 'string' ||
          typeof request.body.clientSecret !== 'string'
        ) {
          return reply.code(400).send({
            error: 'A client key and client secret are required.',
            code: 'INVALID_TIKTOK_CREDENTIALS',
          });
        }
        try {
          await tiktok.configureCredentials({
            clientKey: request.body.clientKey,
            clientSecret: request.body.clientSecret,
          });
          return { tiktok: await tiktok.credentialStatus() };
        } catch (error) {
          return safePlatformFailure(error, reply);
        }
      });
      server.post('/api/accounts/tiktok/oauth/start', async (request, reply) => {
        try {
          const browserBinding = request.session.get('csrfToken');
          if (typeof browserBinding !== 'string')
            return reply.code(403).send({
              error: 'A browser session is required.',
              code: 'TIKTOK_OAUTH_SESSION_REQUIRED',
            });
          return await tiktok.beginAuthorization(browserBinding);
        } catch (error) {
          return safePlatformFailure(error, reply);
        }
      });
      server.get<{
        Querystring: { code?: string; error?: string; state?: string };
      }>('/api/accounts/tiktok/oauth/callback', async (request, reply) => {
        const destination = new URL('/accounts', options.config.appUrl);
        try {
          const browserBinding = request.session.get('csrfToken');
          await tiktok.completeAuthorization({
            ...request.query,
            ...(typeof browserBinding === 'string' ? { browserBinding } : {}),
          });
          destination.searchParams.set('tiktok', 'connected');
        } catch (error) {
          destination.searchParams.set('tiktok', 'error');
          destination.searchParams.set(
            'code',
            isPlatformError(error) ? error.code : 'TIKTOK_OAUTH_CALLBACK_FAILED',
          );
        }
        return reply.redirect(destination.toString());
      });
      server.get<{ Params: { id: string } }>(
        '/api/accounts/tiktok/:id/capabilities',
        async (request, reply) => {
          try {
            return {
              capabilities: await tiktok.getAccountCapabilities(request.params.id),
            };
          } catch (error) {
            return safePlatformFailure(error, reply);
          }
        },
      );
    }
    if (meta !== undefined) {
      server.post<{ Body: { clientId?: unknown; clientSecret?: unknown } }>(
        '/api/accounts/meta/credentials',
        async (request, reply) => {
          if (
            typeof request.body?.clientId !== 'string' ||
            typeof request.body.clientSecret !== 'string'
          )
            return reply.code(400).send({
              error: 'A Meta app ID and app secret are required.',
              code: 'INVALID_META_CREDENTIALS',
            });
          try {
            await meta.configureCredentials({
              clientId: request.body.clientId,
              clientSecret: request.body.clientSecret,
            });
            return { meta: await meta.credentialStatus() };
          } catch (error) {
            return safePlatformFailure(error, reply);
          }
        },
      );
      server.post('/api/accounts/meta/oauth/start', async (request, reply) => {
        try {
          const binding = request.session.get('csrfToken');
          if (typeof binding !== 'string')
            return reply.code(403).send({
              error: 'A local browser session is required.',
              code: 'META_OAUTH_SESSION_REQUIRED',
            });
          return await meta.beginAuthorization(binding);
        } catch (error) {
          return safePlatformFailure(error, reply);
        }
      });
      server.get<{ Querystring: { code?: string; error?: string; state?: string } }>(
        '/api/accounts/meta/oauth/callback',
        async (request, reply) => {
          const destination = new URL('/accounts', options.config.appUrl);
          try {
            const binding = request.session.get('csrfToken');
            await meta.completeAuthorization({
              ...request.query,
              ...(typeof binding === 'string' ? { browserBinding: binding } : {}),
            });
            destination.searchParams.set('meta', 'connected');
          } catch (error) {
            destination.searchParams.set('meta', 'error');
            destination.searchParams.set(
              'code',
              isPlatformError(error) ? error.code : 'META_OAUTH_CALLBACK_FAILED',
            );
          }
          return reply.redirect(destination.toString());
        },
      );
      server.post<{ Params: { id: string } }>(
        '/api/accounts/meta/:id/discover',
        async (request, reply) => {
          try {
            return { targets: await meta.discoverTargets(request.params.id) };
          } catch (error) {
            return safePlatformFailure(error, reply);
          }
        },
      );
      server.patch<{ Params: { id: string }; Body: { enabled?: unknown } }>(
        '/api/accounts/meta/targets/:id',
        async (request, reply) => {
          if (typeof request.body?.enabled !== 'boolean')
            return reply
              .code(400)
              .send({ error: 'A target enabled state is required.', code: 'INVALID_META_TARGET' });
          return meta.setTargetEnabled(request.params.id, request.body.enabled)
            ? { updated: true }
            : reply
                .code(404)
                .send({ error: 'Meta target not found.', code: 'META_TARGET_NOT_FOUND' });
        },
      );
    }
    server.delete<{ Params: { id: string } }>('/api/accounts/:id', async (request, reply) => {
      const existing = accounts?.listAccounts().find((account) => account.id === request.params.id);
      const account =
        existing?.provider === 'youtube'
          ? await youtube?.removeAccount(request.params.id)
          : existing?.provider === 'tiktok'
            ? await tiktok?.removeAccount(request.params.id)
            : undefined;
      return account === undefined
        ? reply.code(404).send({ error: 'Account not found.', code: 'ACCOUNT_NOT_FOUND' })
        : { account };
    });
  }

  if (options.jobService !== undefined) {
    const jobStatuses = new Set<JobStatus>([
      'pending',
      'running',
      'retrying',
      'succeeded',
      'failed',
      'cancelled',
    ]);
    server.get<{ Querystring: { status?: string } }>('/api/jobs', async (request, reply) => {
      const status = request.query.status;
      if (status !== undefined && !jobStatuses.has(status as JobStatus))
        return reply.code(400).send({ error: 'Unknown job status.', code: 'INVALID_JOB_STATUS' });
      const jobs = options.jobService!.list(status as JobStatus | undefined);
      return {
        jobs: jobs.map((job) => ({
          ...job,
          ...(options.destinationJobRepository === undefined
            ? {}
            : { destination: options.destinationJobRepository.find(job.id) }),
          ...(options.transformService?.forJob(job) === undefined
            ? {}
            : { transform: options.transformService.forJob(job) }),
        })),
      };
    });
    server.get<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
      const details = options.jobService!.show(request.params.id);
      return details === undefined
        ? reply.code(404).send({ error: 'Job not found.', code: 'JOB_NOT_FOUND' })
        : {
            ...details,
            ...(options.destinationJobRepository === undefined
              ? {}
              : { destination: options.destinationJobRepository.find(request.params.id) }),
            ...(options.transformService?.forJob(details.job) === undefined
              ? {}
              : { transform: options.transformService.forJob(details.job) }),
          };
    });
    server.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (request, reply) => {
      const existing = options.jobService!.show(request.params.id)?.job;
      const job =
        existing?.type === 'media.transform' && options.transformService !== undefined
          ? options.transformService.cancelJob(request.params.id)
          : options.jobService!.cancel(request.params.id);
      return job === undefined
        ? reply.code(404).send({ error: 'Job not found.', code: 'JOB_NOT_FOUND' })
        : { job };
    });
    server.post<{ Params: { id: string } }>('/api/jobs/:id/retry', async (request, reply) => {
      const existing = options.jobService!.show(request.params.id)?.job;
      if (existing === undefined)
        return reply.code(404).send({ error: 'Job not found.', code: 'JOB_NOT_FOUND' });
      if (existing.status !== 'failed')
        return reply
          .code(409)
          .send({ error: 'Only failed jobs can be retried.', code: 'JOB_NOT_FAILED' });
      return { job: options.jobService!.retry(request.params.id)! };
    });
    server.get('/api/jobs/queue', async () => ({ queue: options.jobService!.queueState() }));
    server.post('/api/jobs/queue/pause', async () => ({
      queue: options.jobService!.pauseQueue(),
    }));
    server.post('/api/jobs/queue/resume', async () => ({
      queue: options.jobService!.resumeQueue(),
    }));
    server.post('/api/jobs/queue/drain', async () => ({
      queue:
        options.jobRunner === undefined
          ? options.jobService!.drainQueue()
          : await options.jobRunner.drain(),
    }));
    server.get<{ Params: { accountId: string; platformId: string } }>(
      '/api/jobs/accounts/:platformId/:accountId/control',
      async (request) => ({
        control: options.jobService!.accountControl(
          request.params.platformId,
          request.params.accountId,
        ),
      }),
    );
    server.post<{ Params: { accountId: string; platformId: string } }>(
      '/api/jobs/accounts/:platformId/:accountId/resume',
      async (request) => ({
        control: options.jobService!.resumeAccount(
          request.params.platformId,
          request.params.accountId,
        ),
      }),
    );
  }

  if (options.transformService !== undefined) {
    server.get('/api/transforms', async () => ({
      derivatives: options.transformService!.list(),
    }));
    server.get<{ Params: { id: string } }>('/api/transforms/:id', async (request, reply) => {
      const derivative = options.transformService!.inspect(request.params.id);
      return derivative === undefined
        ? reply
            .code(404)
            .send({ error: 'Transform derivative not found.', code: 'DERIVATIVE_NOT_FOUND' })
        : { derivative };
    });
  }

  if (options.sourceWorkflowCoordinator !== undefined)
    server.post<{ Params: { id: string } }>(
      '/api/source-executions/:id/retry-failed-destinations',
      async (request) => ({
        retried: options.sourceWorkflowCoordinator!.retryFailedDestinations(request.params.id),
      }),
    );

  if (options.mediaRepository !== undefined) {
    server.get('/api/media', async () => ({ media: options.mediaRepository!.list() }));
  }
  if (options.mediaImportService !== undefined) {
    server.post<{ Body: { path?: unknown } }>('/api/media/import', async (request, reply) => {
      if (typeof request.body?.path !== 'string')
        return reply
          .code(400)
          .send({ error: 'A string path is required.', code: 'INVALID_MEDIA_PATH' });
      const result = await options.mediaImportService!.import(request.body.path);
      return reply.code(result.duplicate ? 200 : 201).send(result);
    });
  }
  if (options.jobService !== undefined && options.mediaRepository !== undefined) {
    server.post<{ Body: unknown }>('/api/publish/youtube', async (request, reply) => {
      if (typeof request.body !== 'object' || request.body === null)
        return reply.code(400).send({ error: 'Invalid publish request.', code: 'INVALID_PUBLISH' });
      const body = request.body as Record<string, unknown>;
      const mediaId = body.mediaId;
      const accountId = body.accountId;
      const metadata = body.metadata;
      const titleCandidate =
        typeof metadata === 'object' && metadata !== null
          ? (metadata as Record<string, unknown>).title
          : undefined;
      if (
        typeof mediaId !== 'string' ||
        typeof accountId !== 'string' ||
        typeof titleCandidate !== 'string' ||
        titleCandidate.trim().length === 0
      )
        return reply
          .code(400)
          .send({ error: 'Media, account, and title are required.', code: 'INVALID_PUBLISH' });
      const mediaRepository = options.mediaRepository;
      const jobService = options.jobService;
      if (mediaRepository === undefined || jobService === undefined)
        return reply
          .code(404)
          .send({ error: 'Publishing is unavailable.', code: 'PUBLISH_UNAVAILABLE' });
      if (mediaRepository.list().every((asset) => asset.id !== mediaId))
        return reply.code(404).send({ error: 'Media not found.', code: 'MEDIA_NOT_FOUND' });
      const publishMetadata = metadata as Record<string, unknown>;
      const title = titleCandidate;
      try {
        const result = jobService.create({
          type: 'youtube.upload',
          idempotencyKey: `manual:youtube:${mediaId}:${accountId}`,
          input: {
            accountId,
            mediaId,
            metadata: {
              title,
              ...(typeof publishMetadata.description === 'string'
                ? { description: publishMetadata.description }
                : {}),
              ...(typeof publishMetadata.privacy === 'string'
                ? { privacy: publishMetadata.privacy }
                : { privacy: 'private' }),
            },
          },
        });
        return reply.code(result.created ? 201 : 200).send(result);
      } catch {
        return reply
          .code(400)
          .send({ error: 'The publish request is invalid.', code: 'INVALID_PUBLISH' });
      }
    });
    if (options.tiktokOAuthService !== undefined) {
      const tiktok = options.tiktokOAuthService;
      server.post<{ Body: unknown }>('/api/publish/tiktok', async (request, reply) => {
        if (typeof request.body !== 'object' || request.body === null)
          return reply
            .code(400)
            .send({ error: 'Invalid publish request.', code: 'INVALID_PUBLISH' });
        const body = request.body as Record<string, unknown>;
        const mediaId = body.mediaId;
        const accountId = body.accountId;
        const metadata = body.metadata;
        const values =
          typeof metadata === 'object' && metadata !== null
            ? (metadata as Record<string, unknown>)
            : {};
        const privacyLevel = values.privacyLevel;
        if (
          typeof mediaId !== 'string' ||
          typeof accountId !== 'string' ||
          typeof privacyLevel !== 'string'
        )
          return reply.code(400).send({
            error: 'Media, account, and privacy level are required.',
            code: 'INVALID_PUBLISH',
          });
        if (options.mediaRepository!.list().every((asset) => asset.id !== mediaId))
          return reply.code(404).send({ error: 'Media not found.', code: 'MEDIA_NOT_FOUND' });
        try {
          const capabilities = await tiktok.getAccountCapabilities(accountId);
          if (!capabilities.directPostAvailable)
            return reply.code(400).send({
              error: 'TikTok Direct Post is not available for this account.',
              code: 'TIKTOK_DIRECT_POST_NOT_AUTHORIZED',
            });
          if (
            !capabilities.privacyLevelOptions.includes(
              privacyLevel as (typeof capabilities.privacyLevelOptions)[number],
            )
          )
            return reply.code(400).send({
              error:
                'The selected TikTok privacy level is not currently available for this creator.',
              code: 'TIKTOK_PRIVACY_LEVEL_UNAVAILABLE',
            });
          const result = options.jobService!.create({
            type: 'tiktok.direct-post',
            idempotencyKey: `manual:tiktok:${mediaId}:${accountId}`,
            input: {
              mediaId,
              accountId,
              metadata: {
                privacyLevel,
                ...(typeof values.caption === 'string' ? { caption: values.caption } : {}),
                ...(typeof values.disableComment === 'boolean'
                  ? { disableComment: values.disableComment }
                  : {}),
                ...(typeof values.disableDuet === 'boolean'
                  ? { disableDuet: values.disableDuet }
                  : {}),
                ...(typeof values.disableStitch === 'boolean'
                  ? { disableStitch: values.disableStitch }
                  : {}),
              },
            },
          });
          return reply.code(result.created ? 201 : 200).send(result);
        } catch (error) {
          if (isPlatformError(error))
            return reply
              .code(
                error.category === 'configuration' || error.category === 'validation' ? 400 : 502,
              )
              .send({ error: error.publicMessage, code: error.code });
          throw error;
        }
      });
    }
  }
  if (options.workflowService !== undefined) {
    const workflows = options.workflowService;
    const workflowInput = (body: unknown): WorkflowInput | undefined => {
      if (typeof body !== 'object' || body === null) return undefined;
      const value = body as Record<string, unknown>;
      if (
        typeof value.name !== 'string' ||
        (typeof value.sourceDirectory !== 'string' &&
          (typeof value.remoteSource !== 'object' || value.remoteSource === null)) ||
        typeof value.titleTemplate !== 'string' ||
        (typeof value.accountId !== 'string' && !Array.isArray(value.destinations))
      )
        return undefined;
      if (value.descriptionTemplate !== undefined && typeof value.descriptionTemplate !== 'string')
        return undefined;
      if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return undefined;
      if (value.category !== undefined && typeof value.category !== 'string') return undefined;
      if (value.destinations !== undefined && !Array.isArray(value.destinations)) return undefined;
      if (
        value.privacy !== undefined &&
        value.privacy !== 'private' &&
        value.privacy !== 'public' &&
        value.privacy !== 'unlisted'
      )
        return undefined;
      return value as unknown as WorkflowInput;
    };
    server.get('/api/workflows', async () => ({ workflows: workflows.list() }));
    server.get<{ Params: { id: string } }>('/api/workflows/:id', async (request, reply) => {
      const workflow = workflows.get(request.params.id);
      return workflow === undefined
        ? reply.code(404).send({ error: 'Workflow not found.', code: 'WORKFLOW_NOT_FOUND' })
        : { workflow };
    });
    server.post<{ Body: unknown }>('/api/workflows', async (request, reply) => {
      const input = workflowInput(request.body);
      if (input === undefined)
        return reply.code(400).send({ error: 'Invalid workflow input.', code: 'INVALID_WORKFLOW' });
      try {
        return reply.code(201).send({ workflow: workflows.create(input) });
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : 'Invalid workflow.',
          code: 'INVALID_WORKFLOW',
        });
      }
    });
    server.put<{ Params: { id: string }; Body: unknown }>(
      '/api/workflows/:id',
      async (request, reply) => {
        const input = workflowInput(request.body);
        if (input === undefined)
          return reply
            .code(400)
            .send({ error: 'Invalid workflow input.', code: 'INVALID_WORKFLOW' });
        try {
          const workflow = workflows.update(request.params.id, input);
          return workflow === undefined
            ? reply.code(404).send({ error: 'Workflow not found.', code: 'WORKFLOW_NOT_FOUND' })
            : { workflow };
        } catch (error) {
          return reply.code(400).send({
            error: error instanceof Error ? error.message : 'Invalid workflow.',
            code: 'INVALID_WORKFLOW',
          });
        }
      },
    );
    server.delete<{ Params: { id: string } }>('/api/workflows/:id', async (request, reply) =>
      workflows.delete(request.params.id)
        ? reply.code(204).send()
        : reply.code(404).send({ error: 'Workflow not found.', code: 'WORKFLOW_NOT_FOUND' }),
    );
  }
  if (options.sourceService !== undefined) {
    const sources = options.sourceService;
    server.get('/api/sources', async () => ({ sources: sources.list() }));
    server.get<{ Params: { id: string } }>('/api/sources/:id', async (request, reply) => {
      const source = sources.get(request.params.id);
      return source === undefined
        ? reply.code(404).send({ error: 'Source not found.', code: 'SOURCE_NOT_FOUND' })
        : { source, items: sources.items(source.id) };
    });
    server.post<{ Body: unknown }>('/api/sources/youtube', async (request, reply) => {
      const value = request.body;
      if (typeof value !== 'object' || value === null)
        return reply.code(400).send({ error: 'Invalid YouTube source.', code: 'INVALID_SOURCE' });
      const body = value as Record<string, unknown>;
      if (typeof body.accountId !== 'string' || typeof body.channelId !== 'string')
        return reply
          .code(400)
          .send({ error: 'An account and channel ID are required.', code: 'INVALID_SOURCE' });
      try {
        return reply.code(201).send({
          source: sources.addYouTube({
            accountId: body.accountId,
            channelId: body.channelId,
            ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
          }),
        });
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : 'Invalid YouTube source.',
          code: 'INVALID_SOURCE',
        });
      }
    });
    for (const action of ['poll', 'pause', 'resume'] as const)
      server.post<{ Params: { id: string } }>(
        `/api/sources/:id/${action}`,
        async (request, reply) => {
          const source = sources[action](request.params.id);
          return source === undefined
            ? reply.code(404).send({ error: 'Source not found.', code: 'SOURCE_NOT_FOUND' })
            : { source };
        },
      );
  }
  server.get(
    '/api/session',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['csrfToken'],
            properties: { csrfToken: { type: 'string' } },
          },
        },
      },
    },
    async (request) => {
      const existing = request.session.get('csrfToken');
      const csrfToken =
        typeof existing === 'string' ? existing : randomBytes(32).toString('base64url');
      if (existing !== csrfToken) request.session.set('csrfToken', csrfToken);
      return { csrfToken };
    },
  );

  const staticRoot = options.staticRoot === undefined ? defaultStaticRoot : options.staticRoot;
  if (staticRoot !== false) {
    server.register(fastifyStatic, { root: staticRoot });
    server.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not Found', code: 'API_ROUTE_NOT_FOUND' });
      }
      if (request.method === 'GET' && request.headers.accept?.includes('text/html')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not Found', code: 'ROUTE_NOT_FOUND' });
    });
  }

  server.setErrorHandler((error, request, reply) => {
    const candidateStatus =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? error.statusCode
        : undefined;
    const statusCode =
      typeof candidateStatus === 'number' && candidateStatus < 500 ? candidateStatus : 500;
    const errorType = error instanceof Error ? error.name : 'UnknownError';
    request.log.error({ errorType, statusCode }, 'Request failed');
    return reply.code(statusCode).send({
      error: statusCode === 500 ? 'Internal Server Error' : 'Request Failed',
      code: statusCode === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
    });
  });

  return server;
}
