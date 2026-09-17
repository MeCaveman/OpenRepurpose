import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fastifySecureSession from '@fastify/secure-session';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController } from 'fastify';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApplicationConfig } from '@openrepurpose/shared';
import { isPlatformError, REDACTED_LOG_VALUE } from '@openrepurpose/platform-sdk';
import type { YouTubeOAuthService } from '@openrepurpose/youtube';
import type {
  JobService,
  JobStatus,
  MediaImportService,
  MediaRepository,
  WorkflowInput,
  WorkflowService,
} from '@openrepurpose/core';

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
  readonly logger?: boolean;
  readonly loggerDestination?: LoggerDestination;
  readonly mediaImportService?: MediaImportService;
  readonly mediaRepository?: MediaRepository;
  readonly sessionKey: Buffer;
  readonly staticRoot?: false | string;
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

  if (options.youtubeOAuthService !== undefined) {
    const youtube = options.youtubeOAuthService;
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
      accounts: youtube.listAccounts(),
      youtube: await youtube.credentialStatus(),
    }));
    server.get('/api/setup', async () => ({ youtube: await youtube.credentialStatus() }));
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
    server.delete<{ Params: { id: string } }>('/api/accounts/:id', async (request, reply) => {
      const account = await youtube.removeAccount(request.params.id);
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
      return { jobs: options.jobService!.list(status as JobStatus | undefined) };
    });
    server.get<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
      const details = options.jobService!.show(request.params.id);
      return details === undefined
        ? reply.code(404).send({ error: 'Job not found.', code: 'JOB_NOT_FOUND' })
        : details;
    });
    server.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (request, reply) => {
      const job = options.jobService!.cancel(request.params.id);
      return job === undefined
        ? reply.code(404).send({ error: 'Job not found.', code: 'JOB_NOT_FOUND' })
        : { job };
    });
  }

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
  if (options.workflowService !== undefined) {
    const workflows = options.workflowService;
    const workflowInput = (body: unknown): WorkflowInput | undefined => {
      if (typeof body !== 'object' || body === null) return undefined;
      const value = body as Record<string, unknown>;
      if (
        typeof value.name !== 'string' ||
        typeof value.sourceDirectory !== 'string' ||
        typeof value.accountId !== 'string' ||
        typeof value.titleTemplate !== 'string'
      )
        return undefined;
      if (value.descriptionTemplate !== undefined && typeof value.descriptionTemplate !== 'string')
        return undefined;
      if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return undefined;
      if (value.category !== undefined && typeof value.category !== 'string') return undefined;
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
