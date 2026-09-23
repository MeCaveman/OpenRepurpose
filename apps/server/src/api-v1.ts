import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodType } from '@openrepurpose/shared';
import type {
  ApiIdempotencyService,
  ApiPermission,
  ApiTokenService,
  DestinationJobRecord,
  DestinationJobRepository,
  JobRunner,
  JobService,
  JobStatus,
  JsonValue,
  MediaImportService,
  MediaRepository,
  ScheduleService,
  SourceConnection,
  SourceService,
  TranscriptService,
  TransformService,
  WorkflowInput,
  Workflow,
  WorkflowService,
} from '@openrepurpose/core';
import { ApiIdempotencyConflictError } from '@openrepurpose/core';
import type { TikTokOAuthService } from '@openrepurpose/tiktok';
import type { YouTubeOAuthService } from '@openrepurpose/youtube';

const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const idParamsSchema = z.object({ id: idSchema }).strict();
const paginationSchema = z
  .object({
    cursor: z.string().max(128).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
const jobStatusSchema = z.enum([
  'pending',
  'running',
  'retrying',
  'succeeded',
  'failed',
  'cancelled',
]);
const jobsQuerySchema = paginationSchema.extend({ status: jobStatusSchema.optional() }).strict();
const tokenCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    permissions: z
      .array(z.enum(['read', 'control']))
      .min(1)
      .max(2),
  })
  .strict();
const mediaImportSchema = z.object({ path: z.string().min(1).max(4_096) }).strict();
const sourceCreateSchema = z.discriminatedUnion('provider', [
  z
    .object({
      provider: z.literal('youtube'),
      accountId: idSchema,
      channelId: z.string().trim().min(1).max(128),
      displayName: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal('twitch'),
      accountId: idSchema,
      broadcasterId: z.string().trim().min(1).max(128),
      editorId: z.string().trim().min(1).max(128).optional(),
      kind: z.enum(['clips', 'vods']),
      displayName: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal('kick'),
      accountId: idSchema,
      broadcasterId: z.string().trim().min(1).max(128),
      displayName: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
]);
const youtubeDestinationSchema = z
  .object({
    destinationId: z.literal('youtube'),
    accountId: idSchema,
    category: z.string().max(100).optional(),
    privacy: z.enum(['private', 'public', 'unlisted']),
  })
  .strict();
const tiktokDestinationSchema = z
  .object({
    destinationId: z.literal('tiktok'),
    accountId: idSchema,
    captionTemplate: z.string().max(2_200).optional(),
    disableComment: z.boolean().optional(),
    disableDuet: z.boolean().optional(),
    disableStitch: z.boolean().optional(),
    privacyLevel: z.enum([
      'FOLLOWER_OF_CREATOR',
      'MUTUAL_FOLLOW_FRIENDS',
      'PUBLIC_TO_EVERYONE',
      'SELF_ONLY',
    ]),
  })
  .strict();
const instagramDestinationSchema = z
  .object({
    destinationId: z.literal('instagram'),
    accountId: idSchema,
    captionTemplate: z.string().max(2_200).optional(),
    shareToFeed: z.boolean().optional(),
  })
  .strict();
const facebookDestinationSchema = z
  .object({
    destinationId: z.literal('facebook'),
    accountId: idSchema,
    titleTemplate: z.string().max(500).optional(),
    descriptionTemplate: z.string().max(5_000).optional(),
  })
  .strict();
const workflowCreateSchema = z
  .object({
    accountId: idSchema.optional(),
    category: z.string().max(100).optional(),
    descriptionTemplate: z.string().max(5_000).optional(),
    destinations: z
      .array(
        z.discriminatedUnion('destinationId', [
          youtubeDestinationSchema,
          tiktokDestinationSchema,
          instagramDestinationSchema,
          facebookDestinationSchema,
        ]),
      )
      .min(1)
      .max(20)
      .optional(),
    enabled: z.boolean().optional(),
    failurePolicy: z.literal('best_effort').optional(),
    name: z.string().trim().min(1).max(200),
    privacy: z.enum(['private', 'public', 'unlisted']).optional(),
    remoteSource: z
      .object({
        connectionId: idSchema,
        retentionPolicy: z
          .discriminatedUnion('kind', [
            z.object({ kind: z.literal('delete_after_success') }).strict(),
            z
              .object({
                kind: z.literal('keep_for_duration'),
                durationSeconds: z.number().int().min(60).max(31_536_000),
              })
              .strict(),
            z.object({ kind: z.literal('keep_forever') }).strict(),
          ])
          .optional(),
        rightsConfirmed: z.boolean().optional(),
      })
      .strict()
      .optional(),
    sourceDirectory: z.string().min(1).max(4_096).optional(),
    titleTemplate: z.string().min(1).max(500),
  })
  .strict()
  .refine((value) => value.sourceDirectory !== undefined || value.remoteSource !== undefined, {
    message: 'A source directory or remote source is required.',
  })
  .refine((value) => value.accountId !== undefined || value.destinations !== undefined, {
    message: 'At least one destination is required.',
  });
const scheduleCreateSchema = z
  .object({
    definition: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('once'), requestedLocalTime: z.string().max(32) }).strict(),
      z.object({ kind: z.literal('cron-v1'), expression: z.string().min(1).max(100) }).strict(),
    ]),
    target: z
      .object({
        kind: z.literal('source_poll'),
        sourceConnectionId: idSchema,
        version: z.literal(1),
      })
      .strict(),
    timeZone: z.string().min(3).max(100),
  })
  .strict();
const publishSchema = z.discriminatedUnion('platform', [
  z
    .object({
      platform: z.literal('youtube'),
      accountId: idSchema,
      mediaId: idSchema,
      metadata: z
        .object({
          title: z.string().trim().min(1).max(500),
          description: z.string().max(5_000).optional(),
          privacy: z.enum(['private', 'public', 'unlisted']).default('private'),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      platform: z.literal('tiktok'),
      accountId: idSchema,
      mediaId: idSchema,
      metadata: z
        .object({
          caption: z.string().max(2_200).optional(),
          disableComment: z.boolean().optional(),
          disableDuet: z.boolean().optional(),
          disableStitch: z.boolean().optional(),
          privacyLevel: z.enum([
            'FOLLOWER_OF_CREATOR',
            'MUTUAL_FOLLOW_FRIENDS',
            'PUBLIC_TO_EVERYONE',
            'SELF_ONLY',
          ]),
        })
        .strict(),
    })
    .strict(),
]);

interface ApiPrincipal {
  readonly permissions: readonly ApiPermission[];
  readonly subject: string;
  readonly type: 'browser' | 'token';
}

export interface ApiV1Options {
  readonly accountService?: Pick<YouTubeOAuthService, 'listAccounts'>;
  readonly destinationJobRepository?: DestinationJobRepository;
  readonly idempotencyService?: ApiIdempotencyService;
  readonly jobRunner?: Pick<JobRunner, 'drain'>;
  readonly jobService?: JobService;
  readonly mediaImportService?: MediaImportService;
  readonly mediaRepository?: MediaRepository;
  readonly scheduleService?: ScheduleService;
  readonly sourceService?: SourceService;
  readonly tiktokOAuthService?: Pick<TikTokOAuthService, 'getAccountCapabilities'>;
  readonly tokenService?: ApiTokenService;
  readonly transcriptService?: TranscriptService;
  readonly transformService?: TransformService;
  readonly workflowService?: WorkflowService;
}

function jsonSchema(schema: ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
  delete generated.$schema;
  return generated;
}

function safeMedia(asset: ReturnType<MediaRepository['list']>[number]) {
  return {
    createdAt: asset.createdAt,
    id: asset.id,
    metadata: asset.metadata,
    modifiedAt: asset.modifiedAt,
    sizeBytes: asset.sizeBytes,
    state: asset.state,
  };
}

function safeDestination(record: DestinationJobRecord) {
  return {
    destinationId: record.destinationId,
    jobId: record.jobId,
    ...(record.remoteId === undefined ? {} : { remoteId: record.remoteId }),
    remoteStatus: record.remoteStatus,
    ...(record.remoteUrl === undefined ? {} : { remoteUrl: record.remoteUrl }),
    updatedAt: record.updatedAt,
    uploadedBytes: record.uploadedBytes,
  };
}

function safeWorkflow(workflow: Workflow) {
  const remoteSource =
    workflow.remoteSource === undefined
      ? undefined
      : {
          connectionId: workflow.remoteSource.connectionId,
          ...(workflow.remoteSource.filters === undefined
            ? {}
            : { filters: workflow.remoteSource.filters }),
          localOriginalConfigured: workflow.remoteSource.localOriginal !== undefined,
          ...(workflow.remoteSource.retentionPolicy === undefined
            ? {}
            : { retentionPolicy: workflow.remoteSource.retentionPolicy }),
          ...(workflow.remoteSource.rightsConfirmed === undefined
            ? {}
            : { rightsConfirmed: workflow.remoteSource.rightsConfirmed }),
        };
  return {
    createdAt: workflow.createdAt,
    descriptionTemplate: workflow.descriptionTemplate,
    definition: workflow.definition,
    destinations: workflow.destinations,
    enabled: workflow.enabled,
    failurePolicy: workflow.failurePolicy,
    id: workflow.id,
    localSourceConfigured: workflow.sourceDirectory.length > 0,
    name: workflow.name,
    plan: workflow.plan,
    ...(remoteSource === undefined ? {} : { remoteSource }),
    titleTemplate: workflow.titleTemplate,
    updatedAt: workflow.updatedAt,
  };
}

function safeSource(source: SourceConnection) {
  const configuration = Object.fromEntries(
    ['accountId', 'broadcasterId', 'editorId', 'kind']
      .map((key) => [key, source.configuration[key]] as const)
      .filter((entry): entry is readonly [string, boolean | number | string] =>
        ['boolean', 'number', 'string'].includes(typeof entry[1]),
      ),
  );
  return {
    adapterId: source.adapterId,
    cadenceOwner: source.cadenceOwner,
    configuration,
    consecutivePollFailures: source.consecutivePollFailures,
    createdAt: source.createdAt,
    displayName: source.displayName,
    externalSourceId: source.externalSourceId,
    id: source.id,
    ...(source.lastPollAt === undefined ? {} : { lastPollAt: source.lastPollAt }),
    ...(source.lastPollErrorCode === undefined
      ? {}
      : { lastPollErrorCode: source.lastPollErrorCode }),
    ...(source.lastPollErrorMessage === undefined
      ? {}
      : { lastPollErrorMessage: source.lastPollErrorMessage }),
    ...(source.lastSuccessfulPollAt === undefined
      ? {}
      : { lastSuccessfulPollAt: source.lastSuccessfulPollAt }),
    ...(source.nextPollAt === undefined ? {} : { nextPollAt: source.nextPollAt }),
    status: source.status,
    updatedAt: source.updatedAt,
  };
}

function safeTransform(derivative: ReturnType<TransformService['list']>[number]) {
  return {
    cacheKey: derivative.cacheKey,
    ...(derivative.completedAt === undefined ? {} : { completedAt: derivative.completedAt }),
    createdAt: derivative.createdAt,
    ...(derivative.errorCode === undefined ? {} : { errorCode: derivative.errorCode }),
    ...(derivative.errorMessage === undefined ? {} : { errorMessage: derivative.errorMessage }),
    id: derivative.id,
    ...(derivative.output === undefined
      ? {}
      : {
          output: {
            metadata: derivative.output.metadata,
            sizeBytes: derivative.output.sizeBytes,
            ...(derivative.output.sidecarCaptions === undefined
              ? {}
              : {
                  sidecarCaptions: {
                    format: derivative.output.sidecarCaptions.format,
                    sizeBytes: derivative.output.sidecarCaptions.sizeBytes,
                  },
                }),
          },
        }),
    ...(derivative.progress === undefined ? {} : { progress: derivative.progress }),
    ...(derivative.progressUpdatedAt === undefined
      ? {}
      : { progressUpdatedAt: derivative.progressUpdatedAt }),
    provenance: derivative.provenance,
    status: derivative.status,
    updatedAt: derivative.updatedAt,
  };
}

class ApiOperationError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiOperationError';
  }
}

const errorJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message', 'requestId'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        requestId: { type: 'string' },
        details: { type: 'array', items: { type: 'object' } },
      },
    },
  },
};

/** Generated from the same strict Zod request contracts enforced by the handlers below. */
export function createApiV1OpenApiDocument(): Record<string, unknown> {
  const request = (schema: ZodType) => ({
    required: true,
    content: { 'application/json': { schema: jsonSchema(schema) } },
  });
  const operation = (summary: string, body?: ZodType, security = true) => ({
    summary,
    ...(security ? { security: [{ bearerAuth: [] }, { browserSession: [] }] } : {}),
    ...(body === undefined ? {} : { requestBody: request(body) }),
    responses: {
      '200': { description: 'Success' },
      '400': {
        description: 'Invalid request',
        content: { 'application/json': { schema: errorJsonSchema } },
      },
      '401': {
        description: 'Authentication required',
        content: { 'application/json': { schema: errorJsonSchema } },
      },
      '403': {
        description: 'Insufficient permission',
        content: { 'application/json': { schema: errorJsonSchema } },
      },
      '409': {
        description: 'Conflict',
        content: { 'application/json': { schema: errorJsonSchema } },
      },
    },
  });
  return {
    openapi: '3.1.0',
    info: { title: 'OpenRepurpose local API', version: 'v1' },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'OpenRepurpose API token' },
        browserSession: { type: 'apiKey', in: 'cookie', name: 'openrepurpose_session' },
      },
    },
    paths: {
      '/health': { get: operation('Health and version', undefined, false) },
      '/openapi.json': { get: operation('OpenAPI document', undefined, false) },
      '/auth/tokens': {
        get: operation('List API token metadata'),
        post: operation('Create an API token', tokenCreateSchema),
      },
      '/auth/tokens/{id}': { delete: operation('Revoke an API token') },
      '/accounts': { get: operation('List safe account metadata') },
      '/media': { get: operation('List media') },
      '/media/import': { post: operation('Import local media', mediaImportSchema) },
      '/sources': {
        get: operation('List sources'),
        post: operation('Create a source', sourceCreateSchema),
      },
      '/sources/{id}': { get: operation('Get a source') },
      '/workflows': {
        get: operation('List workflows'),
        post: operation('Create a workflow', workflowCreateSchema),
      },
      '/workflows/{id}': { get: operation('Get a workflow') },
      '/jobs': { get: operation('List jobs') },
      '/jobs/{id}': { get: operation('Get a job') },
      '/jobs/{id}/cancel': { post: operation('Cancel a job') },
      '/schedules': {
        get: operation('List schedules'),
        post: operation('Create a schedule', scheduleCreateSchema),
      },
      '/schedules/{id}': { get: operation('Get a schedule') },
      '/transforms': { get: operation('List transforms') },
      '/transforms/{id}': { get: operation('Get a transform') },
      '/transcripts/{id}': { get: operation('Get a transcript') },
      '/media/{id}/transcripts': { get: operation('List media transcripts') },
      '/publish': { post: operation('Queue a publish job', publishSchema) },
    },
  };
}

function apiError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: readonly unknown[],
) {
  return reply.code(statusCode).send({
    error: { code, message, requestId: request.id, ...(details === undefined ? {} : { details }) },
  });
}

function validate<T>(
  schema: ZodType<T>,
  value: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): T | undefined {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  apiError(
    request,
    reply,
    400,
    'VALIDATION_FAILED',
    'The request did not match the API schema.',
    result.error.issues
      .slice(0, 20)
      .map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  );
  return undefined;
}

function bearerValue(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header === undefined) return undefined;
  const match = /^Bearer ([^\s]+)$/u.exec(header);
  return match?.[1];
}

function authorize(
  options: ApiV1Options,
  request: FastifyRequest,
  reply: FastifyReply,
  permission: ApiPermission,
): ApiPrincipal | undefined {
  if (request.headers.authorization !== undefined) {
    const token = bearerValue(request);
    const authenticated =
      token === undefined ? undefined : options.tokenService?.authenticate(token);
    if (authenticated === undefined) {
      reply.header('WWW-Authenticate', 'Bearer realm="OpenRepurpose API v1"');
      apiError(
        request,
        reply,
        401,
        'AUTHENTICATION_REQUIRED',
        'A valid API bearer token is required.',
      );
      return undefined;
    }
    if (!authenticated.permissions.includes(permission)) {
      apiError(
        request,
        reply,
        403,
        'PERMISSION_DENIED',
        `The ${permission} permission is required.`,
      );
      return undefined;
    }
    return {
      permissions: authenticated.permissions,
      subject: `token:${authenticated.id}`,
      type: 'token',
    };
  }
  const csrfToken = request.session.get('csrfToken');
  if (typeof csrfToken !== 'string') {
    apiError(
      request,
      reply,
      401,
      'AUTHENTICATION_REQUIRED',
      'A browser session or API bearer token is required.',
    );
    return undefined;
  }
  return {
    permissions: ['control', 'read'],
    subject: `browser:${createHash('sha256').update(csrfToken).digest('hex')}`,
    type: 'browser',
  };
}

function cursorOffset(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return 0;
  try {
    const value = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^v1:(\d+)$/u.exec(value);
    if (match === null || match[1] === undefined) return undefined;
    const offset = Number(match[1]);
    return Number.isSafeInteger(offset) && offset >= 0 ? offset : undefined;
  } catch {
    return undefined;
  }
}

function paged<T>(items: readonly T[], limit: number, offset: number) {
  const data = items.slice(offset, offset + limit);
  const nextOffset = offset + data.length;
  return {
    data,
    page: {
      limit,
      ...(nextOffset >= items.length
        ? {}
        : { nextCursor: Buffer.from(`v1:${nextOffset}`, 'utf8').toString('base64url') }),
    },
  };
}

function readPage(
  value: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
  jobs = false,
): { limit: number; offset: number; status?: JobStatus } | undefined {
  if (jobs) {
    const query = validate(jobsQuerySchema, value, request, reply);
    if (query === undefined) return undefined;
    const offset = cursorOffset(query.cursor);
    if (offset === undefined) {
      apiError(request, reply, 400, 'CURSOR_INVALID', 'The pagination cursor is invalid.');
      return undefined;
    }
    return {
      limit: query.limit,
      offset,
      ...(query.status === undefined ? {} : { status: query.status }),
    };
  }
  const query = validate(paginationSchema, value, request, reply);
  if (query === undefined) return undefined;
  const offset = cursorOffset(query.cursor);
  if (offset === undefined) {
    apiError(request, reply, 400, 'CURSOR_INVALID', 'The pagination cursor is invalid.');
    return undefined;
  }
  return { limit: query.limit, offset };
}

function idempotencyKey(request: FastifyRequest, reply: FastifyReply): string | undefined {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    apiError(
      request,
      reply,
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'A valid Idempotency-Key header is required.',
    );
    return undefined;
  }
  return value;
}

async function idempotent<T>(input: {
  readonly action: () => Promise<{ readonly statusCode: number; readonly value: T }>;
  readonly body: unknown;
  readonly key: string;
  readonly operation: string;
  readonly options: ApiV1Options;
  readonly principal: ApiPrincipal;
  readonly reply: FastifyReply;
  readonly request: FastifyRequest;
}) {
  if (input.options.idempotencyService === undefined)
    return apiError(
      input.request,
      input.reply,
      503,
      'API_NOT_CONFIGURED',
      'API idempotency is unavailable.',
    );
  try {
    const result = await input.options.idempotencyService.execute({
      key: input.key,
      operation: input.operation,
      request: input.body,
      run: input.action,
      subject: input.principal.subject,
    });
    if (result.replayed) input.reply.header('Idempotency-Replayed', 'true');
    return input.reply.code(result.statusCode).send(result.value);
  } catch (error) {
    if (error instanceof ApiIdempotencyConflictError)
      return apiError(input.request, input.reply, 409, error.code, error.message);
    if (error instanceof ApiOperationError)
      return apiError(input.request, input.reply, error.statusCode, error.code, error.message);
    throw error;
  }
}

function unavailable(request: FastifyRequest, reply: FastifyReply, resource: string) {
  return apiError(request, reply, 503, 'RESOURCE_UNAVAILABLE', `${resource} is unavailable.`);
}

export function registerApiV1Routes(server: FastifyInstance, options: ApiV1Options): void {
  const openapi = createApiV1OpenApiDocument();
  server.get('/api/v1/health', async () => ({
    apiVersion: 'v1',
    service: 'openrepurpose',
    status: 'ok',
    version: '0.1.0',
  }));
  server.get('/api/v1/openapi.json', async (_request, reply) =>
    reply.header('Cache-Control', 'no-store').send(openapi),
  );

  server.get('/api/v1/auth/tokens', async (request, reply) => {
    if (authorize(options, request, reply, 'control') === undefined) return;
    return options.tokenService === undefined
      ? unavailable(request, reply, 'API token administration')
      : { data: options.tokenService.list() };
  });
  server.post<{ Body: unknown }>('/api/v1/auth/tokens', async (request, reply) => {
    if (authorize(options, request, reply, 'control') === undefined) return;
    const body = validate(tokenCreateSchema, request.body, request, reply);
    if (body === undefined) return;
    if (options.tokenService === undefined)
      return unavailable(request, reply, 'API token administration');
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send(options.tokenService.create(body.name, body.permissions));
  });
  server.delete<{ Params: unknown }>('/api/v1/auth/tokens/:id', async (request, reply) => {
    if (authorize(options, request, reply, 'control') === undefined) return;
    const params = validate(idParamsSchema, request.params, request, reply);
    if (params === undefined) return;
    const token = options.tokenService?.revoke(params.id);
    return token === undefined
      ? apiError(request, reply, 404, 'TOKEN_NOT_FOUND', 'API token not found.')
      : { token };
  });

  server.get<{ Querystring: unknown }>('/api/v1/accounts', async (request, reply) => {
    if (authorize(options, request, reply, 'read') === undefined) return;
    const page = readPage(request.query, request, reply);
    if (page === undefined) return;
    return paged(options.accountService?.listAccounts() ?? [], page.limit, page.offset);
  });
  server.get<{ Querystring: unknown }>('/api/v1/media', async (request, reply) => {
    if (authorize(options, request, reply, 'read') === undefined) return;
    const page = readPage(request.query, request, reply);
    if (page === undefined) return;
    const media = (options.mediaRepository?.list() ?? []).map(safeMedia);
    return paged(media, page.limit, page.offset);
  });
  server.post<{ Body: unknown }>('/api/v1/media/import', async (request, reply) => {
    const principal = authorize(options, request, reply, 'control');
    if (principal === undefined) return;
    const body = validate(mediaImportSchema, request.body, request, reply);
    const key = idempotencyKey(request, reply);
    if (body === undefined || key === undefined) return;
    if (options.mediaImportService === undefined)
      return unavailable(request, reply, 'Media import');
    return idempotent({
      action: async () => {
        const result = await options.mediaImportService!.import(body.path);
        return {
          statusCode: result.duplicate ? 200 : 201,
          value: { duplicate: result.duplicate, media: safeMedia(result.asset) },
        };
      },
      body,
      key,
      operation: 'media.import',
      options,
      principal,
      reply,
      request,
    });
  });

  server.get<{ Querystring: unknown }>('/api/v1/sources', async (request, reply) => {
    if (authorize(options, request, reply, 'read') === undefined) return;
    const page = readPage(request.query, request, reply);
    if (page === undefined) return;
    return paged((options.sourceService?.list() ?? []).map(safeSource), page.limit, page.offset);
  });
  server.get<{ Params: unknown }>('/api/v1/sources/:id', async (request, reply) => {
    if (authorize(options, request, reply, 'read') === undefined) return;
    const params = validate(idParamsSchema, request.params, request, reply);
    if (params === undefined) return;
    const source = options.sourceService?.get(params.id);
    return source === undefined
      ? apiError(request, reply, 404, 'SOURCE_NOT_FOUND', 'Source not found.')
      : { source: safeSource(source), items: options.sourceService!.items(source.id) };
  });
  server.post<{ Body: unknown }>('/api/v1/sources', async (request, reply) => {
    const principal = authorize(options, request, reply, 'control');
    if (principal === undefined) return;
    const body = validate(sourceCreateSchema, request.body, request, reply);
    const key = idempotencyKey(request, reply);
    if (body === undefined || key === undefined) return;
    if (options.sourceService === undefined) return unavailable(request, reply, 'Sources');
    return idempotent({
      action: async () => {
        const source =
          body.provider === 'youtube'
            ? options.sourceService!.addYouTube({
                accountId: body.accountId,
                channelId: body.channelId,
                ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
              })
            : body.provider === 'twitch'
              ? options.sourceService!.addTwitch({
                  accountId: body.accountId,
                  broadcasterId: body.broadcasterId,
                  kind: body.kind,
                  ...(body.editorId === undefined ? {} : { editorId: body.editorId }),
                  ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
                })
              : options.sourceService!.addKick({
                  accountId: body.accountId,
                  broadcasterId: body.broadcasterId,
                  ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
                });
        return { statusCode: 201, value: { source: safeSource(source) } };
      },
      body,
      key,
      operation: 'sources.create',
      options,
      principal,
      reply,
      request,
    });
  });

  server.get<{ Querystring: unknown }>('/api/v1/workflows', async (request, reply) => {
    if (authorize(options, request, reply, 'read') === undefined) return;
    const page = readPage(request.query, request, reply);
    if (page === undefined) return;
    return paged(
      (options.workflowService?.list() ?? []).map(safeWorkflow),
      page.limit,
      page.offset,
    );
  });
  server.get<{ Params: unknown }>('/api/v1/workflows/:id', async (request, reply) => {
    if (authorize(options, request, reply, 'read') === undefined) return;
    const params = validate(idParamsSchema, request.params, request, reply);
    if (params === undefined) return;
    const workflow = options.workflowService?.get(params.id);
    return workflow === undefined
      ? apiError(request, reply, 404, 'WORKFLOW_NOT_FOUND', 'Workflow not found.')
      : { workflow: safeWorkflow(workflow) };
  });
  server.post<{ Body: unknown }>('/api/v1/workflows', async (request, reply) => {
    const principal = authorize(options, request, reply, 'control');
    if (principal === undefined) return;
    const body = validate(workflowCreateSchema, request.body, request, reply);
    const key = idempotencyKey(request, reply);
    if (body === undefined || key === undefined) return;
    if (options.workflowService === undefined) return unavailable(request, reply, 'Workflows');
    return idempotent({
      action: async () => {
        try {
          return {
            statusCode: 201,
            value: {
              workflow: safeWorkflow(
                options.workflowService!.create(body as unknown as WorkflowInput),
              ),
            },
          };
        } catch {
          throw new ApiOperationError(422, 'WORKFLOW_INVALID', 'The workflow is invalid.');
        }
      },
      body,
      key,
      operation: 'workflows.create',
      options,
      principal,
      reply,
      request,
    });
  });

  server.get<{ Querystring: unknown }>('/api/v1/jobs', async (request, reply) => {
    if (authorize(options, request, reply, 'read') === undefined) return;
    const page = readPage(request.query, request, reply, true);
    if (page === undefined) return;
    const jobs = options.jobService?.list(page.status) ?? [];
    return paged(
      jobs.map((job) => ({
        ...job,
        ...(options.destinationJobRepository?.find(job.id) === undefined
          ? {}
          : { destination: safeDestination(options.destinationJobRepository.find(job.id)!) }),
      })),
      page.limit,
      page.offset,
    );
  });
  server.get<{ Params: unknown }>('/api/v1/jobs/:id', async (request, reply) => {
    if (authorize(options, request, reply, 'read') === undefined) return;
    const params = validate(idParamsSchema, request.params, request, reply);
    if (params === undefined) return;
    const details = options.jobService?.show(params.id);
    return details === undefined
      ? apiError(request, reply, 404, 'JOB_NOT_FOUND', 'Job not found.')
      : details;
  });
  server.post<{ Params: unknown }>('/api/v1/jobs/:id/cancel', async (request, reply) => {
    if (authorize(options, request, reply, 'control') === undefined) return;
    const params = validate(idParamsSchema, request.params, request, reply);
    if (params === undefined) return;
    const existing = options.jobService?.show(params.id)?.job;
    const job =
      existing?.type === 'media.transform' && options.transformService !== undefined
        ? options.transformService.cancelJob(params.id)
        : options.jobService?.cancel(params.id);
    return job === undefined
      ? apiError(request, reply, 404, 'JOB_NOT_FOUND', 'Job not found.')
      : { job };
  });

  server.get<{ Querystring: unknown }>('/api/v1/schedules', async (request, reply) => {
    if (authorize(options, request, reply, 'read') === undefined) return;
    const page = readPage(request.query, request, reply);
    if (page === undefined) return;
    return paged(options.scheduleService?.list() ?? [], page.limit, page.offset);
  });
  server.get<{ Params: unknown }>('/api/v1/schedules/:id', async (request, reply) => {
    if (authorize(options, request, reply, 'read') === undefined) return;
    const params = validate(idParamsSchema, request.params, request, reply);
    if (params === undefined) return;
    const schedule = options.scheduleService?.show(params.id);
    return schedule === undefined
      ? apiError(request, reply, 404, 'SCHEDULE_NOT_FOUND', 'Schedule not found.')
      : { schedule };
  });
  server.post<{ Body: unknown }>('/api/v1/schedules', async (request, reply) => {
    const principal = authorize(options, request, reply, 'control');
    if (principal === undefined) return;
    const body = validate(scheduleCreateSchema, request.body, request, reply);
    const key = idempotencyKey(request, reply);
    if (body === undefined || key === undefined) return;
    if (options.scheduleService === undefined) return unavailable(request, reply, 'Schedules');
    return idempotent({
      action: async () => {
        try {
          return { statusCode: 201, value: { schedule: options.scheduleService!.create(body) } };
        } catch {
          throw new ApiOperationError(422, 'SCHEDULE_INVALID', 'The schedule is invalid.');
        }
      },
      body,
      key,
      operation: 'schedules.create',
      options,
      principal,
      reply,
      request,
    });
  });

  server.get<{ Querystring: unknown }>('/api/v1/transforms', async (request, reply) => {
    if (authorize(options, request, reply, 'read') === undefined) return;
    const page = readPage(request.query, request, reply);
    if (page === undefined) return;
    return paged(
      (options.transformService?.list() ?? []).map(safeTransform),
      page.limit,
      page.offset,
    );
  });
  server.get<{ Params: unknown }>('/api/v1/transforms/:id', async (request, reply) => {
    if (authorize(options, request, reply, 'read') === undefined) return;
    const params = validate(idParamsSchema, request.params, request, reply);
    if (params === undefined) return;
    const derivative = options.transformService?.inspect(params.id);
    return derivative === undefined
      ? apiError(request, reply, 404, 'TRANSFORM_NOT_FOUND', 'Transform not found.')
      : { derivative: safeTransform(derivative) };
  });
  server.get<{ Params: unknown }>('/api/v1/transcripts/:id', async (request, reply) => {
    if (authorize(options, request, reply, 'read') === undefined) return;
    const params = validate(idParamsSchema, request.params, request, reply);
    if (params === undefined) return;
    const transcript = options.transcriptService?.show(params.id);
    return transcript === undefined
      ? apiError(request, reply, 404, 'TRANSCRIPT_NOT_FOUND', 'Transcript not found.')
      : { transcript };
  });
  server.get<{ Params: unknown; Querystring: unknown }>(
    '/api/v1/media/:id/transcripts',
    async (request, reply) => {
      if (authorize(options, request, reply, 'read') === undefined) return;
      const params = validate(idParamsSchema, request.params, request, reply);
      const page = readPage(request.query, request, reply);
      if (params === undefined || page === undefined) return;
      return paged(
        options.transcriptService?.listForMedia(params.id) ?? [],
        page.limit,
        page.offset,
      );
    },
  );

  server.post<{ Body: unknown }>('/api/v1/publish', async (request, reply) => {
    const principal = authorize(options, request, reply, 'control');
    if (principal === undefined) return;
    const body = validate(publishSchema, request.body, request, reply);
    const key = idempotencyKey(request, reply);
    if (body === undefined || key === undefined) return;
    if (options.jobService === undefined || options.mediaRepository === undefined)
      return unavailable(request, reply, 'Publishing');
    if (options.mediaRepository.findById(body.mediaId) === undefined)
      return apiError(request, reply, 404, 'MEDIA_NOT_FOUND', 'Media not found.');
    return idempotent({
      action: async () => {
        if (body.platform === 'youtube') {
          const result = options.jobService!.create({
            type: 'youtube.upload',
            idempotencyKey: `api:${principal.subject}:youtube:${key}`,
            input: JSON.parse(
              JSON.stringify({
                accountId: body.accountId,
                mediaId: body.mediaId,
                metadata: body.metadata,
              }),
            ) as JsonValue,
          });
          return { statusCode: result.created ? 201 : 200, value: result };
        }
        if (options.tiktokOAuthService === undefined)
          throw new ApiOperationError(
            503,
            'PUBLISH_UNAVAILABLE',
            'TikTok publishing is unavailable.',
          );
        const capabilities = await options.tiktokOAuthService.getAccountCapabilities(
          body.accountId,
        );
        if (
          !capabilities.directPostAvailable ||
          !capabilities.privacyLevelOptions.includes(body.metadata.privacyLevel)
        )
          throw new ApiOperationError(
            422,
            'PUBLISH_OPTIONS_UNAVAILABLE',
            'The selected TikTok publishing options are unavailable.',
          );
        const result = options.jobService!.create({
          type: 'tiktok.direct-post',
          idempotencyKey: `api:${principal.subject}:tiktok:${key}`,
          input: JSON.parse(
            JSON.stringify({
              accountId: body.accountId,
              mediaId: body.mediaId,
              metadata: body.metadata,
            }),
          ) as JsonValue,
        });
        return { statusCode: result.created ? 201 : 200, value: result };
      },
      body,
      key,
      operation: 'publish.create',
      options,
      principal,
      reply,
      request,
    });
  });
}
