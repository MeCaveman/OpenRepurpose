import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fastifySecureSession from '@fastify/secure-session';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController } from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApplicationConfig } from '@openrepurpose/shared';
import type {
  JobService,
  JobStatus,
  MediaImportService,
  MediaRepository,
} from '@openrepurpose/core';

declare module '@fastify/secure-session' {
  interface SessionData {
    csrfToken?: string;
  }
}

const stateChangingMethods = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);
const defaultStaticRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));

export interface BuildServerOptions {
  readonly config: ApplicationConfig;
  readonly jobService?: JobService;
  readonly logger?: boolean;
  readonly mediaImportService?: MediaImportService;
  readonly mediaRepository?: MediaRepository;
  readonly sessionKey: Buffer;
  readonly staticRoot?: false | string;
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

export function buildServer(options: BuildServerOptions): FastifyInstance {
  if (options.sessionKey.length !== 32) {
    throw new Error('The secure session key must contain exactly 32 bytes.');
  }

  const server = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ?? false,
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
      sameSite: 'strict',
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
