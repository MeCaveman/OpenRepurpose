import { OPENREPURPOSE_VERSION, z } from '@openrepurpose/shared';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type {
  JsonValue,
  Job,
  JobService,
  MediaRepository,
  ScheduleService,
  WorkflowService,
} from '@openrepurpose/core';
import type { TikTokOAuthService } from '@openrepurpose/tiktok';
import type { YouTubeOAuthService } from '@openrepurpose/youtube';

const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const paginationSchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(25) })
  .strict();
const jobStatusSchema = z.enum([
  'pending',
  'running',
  'retrying',
  'succeeded',
  'failed',
  'cancelled',
]);

const toolSchemas = {
  cancel_job: z.object({ jobId: idSchema }).strict(),
  get_job: z.object({ jobId: idSchema }).strict(),
  get_status: z.object({}).strict(),
  list_accounts: paginationSchema,
  list_jobs: paginationSchema.extend({ status: jobStatusSchema.optional() }).strict(),
  list_media: paginationSchema,
  list_workflows: paginationSchema,
  publish_media: z.discriminatedUnion('platform', [
    z
      .object({
        accountId: idSchema,
        idempotencyKey: idSchema,
        mediaId: idSchema,
        metadata: z
          .object({
            description: z.string().max(5_000).optional(),
            privacy: z.enum(['private', 'public', 'unlisted']).default('private'),
            title: z.string().trim().min(1).max(500),
          })
          .strict(),
        platform: z.literal('youtube'),
      })
      .strict(),
    z
      .object({
        accountId: idSchema,
        idempotencyKey: idSchema,
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
        platform: z.literal('tiktok'),
      })
      .strict(),
  ]),
  run_workflow: z
    .object({ idempotencyKey: idSchema, mediaId: idSchema, workflowId: idSchema })
    .strict(),
  schedule_workflow: z
    .object({
      definition: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('once'), requestedLocalTime: z.string().max(32) }).strict(),
        z.object({ expression: z.string().min(1).max(100), kind: z.literal('cron-v1') }).strict(),
      ]),
      timeZone: z.string().min(3).max(100),
      workflowId: idSchema,
    })
    .strict(),
} as const;

type ToolName = keyof typeof toolSchemas;
type JsonRecord = Record<string, unknown>;

export interface McpServiceOptions {
  readonly accountService?: Pick<YouTubeOAuthService, 'listAccounts'>;
  readonly jobService?: JobService;
  readonly mediaRepository?: MediaRepository;
  readonly scheduleService?: ScheduleService;
  readonly tiktokOAuthService?: Pick<TikTokOAuthService, 'getAccountCapabilities'>;
  readonly version?: string;
  readonly workflowService?: WorkflowService;
}

export interface McpRequest {
  readonly id?: number | string | null;
  readonly jsonrpc?: string;
  readonly method?: string;
  readonly params?: unknown;
}

function safeMedia(media: ReturnType<MediaRepository['list']>[number]) {
  return {
    createdAt: media.createdAt,
    id: media.id,
    metadata: media.metadata,
    modifiedAt: media.modifiedAt,
    sizeBytes: media.sizeBytes,
    state: media.state,
  };
}

function safeWorkflow(workflow: NonNullable<ReturnType<WorkflowService['get']>>) {
  return {
    createdAt: workflow.createdAt,
    destinations: workflow.destinations,
    enabled: workflow.enabled,
    id: workflow.id,
    localSourceConfigured: workflow.sourceDirectory.length > 0,
    name: workflow.name,
    ...(workflow.remoteSource === undefined
      ? {}
      : { remoteSource: { connectionId: workflow.remoteSource.connectionId } }),
    updatedAt: workflow.updatedAt,
  };
}

function safeJob(job: Job) {
  return {
    attemptCount: job.attemptCount,
    availableAt: job.availableAt,
    createdAt: job.createdAt,
    id: job.id,
    maxAttempts: job.maxAttempts,
    status: job.status,
    type: job.type,
    updatedAt: job.updatedAt,
  };
}

function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function toolError(code: string, message: string) {
  return textResult({ error: { code, message } }, true);
}

function list<T>(items: readonly T[], limit: number) {
  return { data: items.slice(0, limit), page: { limit } };
}

const toolDefinitions = [
  ['get_status', 'Read the local OpenRepurpose service status.', { readOnlyHint: true }],
  ['list_accounts', 'List safe connected-account metadata.', { readOnlyHint: true }],
  ['list_media', 'List managed media metadata without local file paths.', { readOnlyHint: true }],
  ['list_workflows', 'List safe workflow metadata.', { readOnlyHint: true }],
  ['list_jobs', 'List safe persistent-job metadata.', { readOnlyHint: true }],
  ['get_job', 'Get a job and its safe attempt history.', { readOnlyHint: true }],
  [
    'run_workflow',
    'Run an enabled workflow for an existing managed media item.',
    { destructiveHint: true },
  ],
  ['publish_media', 'Queue a publish job for existing managed media.', { destructiveHint: true }],
  [
    'schedule_workflow',
    'Schedule polling for a remote-source workflow.',
    { destructiveHint: true },
  ],
  ['cancel_job', 'Request cancellation of a persistent job.', { destructiveHint: true }],
] as const satisfies readonly [ToolName, string, Record<string, boolean>][];

/**
 * A deliberately small MCP facade. It owns protocol and schema validation only; every operation
 * delegates to the same application services used by the REST and browser boundaries.
 */
export class McpServer {
  public constructor(private readonly options: McpServiceOptions) {}

  public async handle(request: McpRequest): Promise<JsonRecord | undefined> {
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string')
      return this.error(request.id, -32600, 'Invalid JSON-RPC request.');
    if (request.method === 'notifications/initialized') return undefined;
    if (request.method === 'initialize')
      return this.result(request.id, {
        capabilities: { tools: {} },
        protocolVersion: '2025-03-26',
        serverInfo: {
          name: 'openrepurpose',
          version: this.options.version ?? OPENREPURPOSE_VERSION,
        },
      });
    if (request.method === 'tools/list')
      return this.result(request.id, {
        tools: toolDefinitions.map(([name, description, annotations]) => ({
          annotations,
          description,
          inputSchema: z.toJSONSchema(toolSchemas[name], { unrepresentable: 'any' }),
          name,
        })),
      });
    if (request.method !== 'tools/call') return this.error(request.id, -32601, 'Method not found.');

    const call = z
      .object({ arguments: z.record(z.string(), z.unknown()).optional(), name: z.string() })
      .strict()
      .safeParse(request.params);
    if (!call.success || !Object.prototype.hasOwnProperty.call(toolSchemas, call.data.name))
      return this.result(
        request.id,
        toolError('TOOL_NOT_FOUND', 'The requested tool is unavailable.'),
      );
    const name = call.data.name as ToolName;
    const parsed = toolSchemas[name].safeParse(call.data.arguments ?? {});
    if (!parsed.success)
      return this.result(
        request.id,
        toolError('VALIDATION_FAILED', 'The tool arguments did not match the strict schema.'),
      );
    try {
      return this.result(request.id, await this.call(name, parsed.data));
    } catch {
      return this.result(
        request.id,
        toolError('OPERATION_FAILED', 'The requested operation failed.'),
      );
    }
  }

  private async call(name: ToolName, args: unknown) {
    if (name === 'get_status')
      return textResult({
        apiVersion: 'v1',
        service: 'openrepurpose',
        status: 'ok',
        version: this.options.version ?? OPENREPURPOSE_VERSION,
      });
    if (name === 'list_accounts') {
      const { limit } = args as z.infer<(typeof toolSchemas)['list_accounts']>;
      return textResult(list(this.options.accountService?.listAccounts() ?? [], limit));
    }
    if (name === 'list_media') {
      const { limit } = args as z.infer<(typeof toolSchemas)['list_media']>;
      return textResult(list((this.options.mediaRepository?.list() ?? []).map(safeMedia), limit));
    }
    if (name === 'list_workflows') {
      const { limit } = args as z.infer<(typeof toolSchemas)['list_workflows']>;
      return textResult(
        list((this.options.workflowService?.list() ?? []).map(safeWorkflow), limit),
      );
    }
    if (name === 'list_jobs') {
      const { limit, status } = args as z.infer<(typeof toolSchemas)['list_jobs']>;
      return textResult(list((this.options.jobService?.list(status) ?? []).map(safeJob), limit));
    }
    if (name === 'get_job') {
      const { jobId } = args as z.infer<(typeof toolSchemas)['get_job']>;
      const details = this.options.jobService?.show(jobId);
      return details === undefined
        ? toolError('JOB_NOT_FOUND', 'Job not found.')
        : textResult({
            attempts: details.attempts.map((attempt) => ({
              attemptNumber: attempt.attemptNumber,
              ...(attempt.errorCode === undefined ? {} : { errorCode: attempt.errorCode }),
              finishedAt: attempt.finishedAt,
              startedAt: attempt.startedAt,
              status: attempt.status,
            })),
            job: safeJob(details.job),
          });
    }
    if (name === 'cancel_job') {
      const { jobId } = args as z.infer<(typeof toolSchemas)['cancel_job']>;
      const job = this.options.jobService?.cancel(jobId);
      return job === undefined
        ? toolError('JOB_NOT_FOUND', 'Job not found.')
        : textResult({ job: safeJob(job) });
    }
    if (name === 'run_workflow') {
      const { mediaId, workflowId } = args as z.infer<(typeof toolSchemas)['run_workflow']>;
      const media = this.options.mediaRepository?.findById(mediaId);
      if (media === undefined) return toolError('MEDIA_NOT_FOUND', 'Media not found.');
      const workflow = this.options.workflowService?.get(workflowId);
      if (workflow === undefined) return toolError('WORKFLOW_NOT_FOUND', 'Workflow not found.');
      if (!workflow.enabled) return toolError('WORKFLOW_DISABLED', 'Workflow is disabled.');
      const result = this.options.workflowService?.executeWatchedMedia(workflowId, media);
      return result === undefined
        ? toolError('WORKFLOW_NOT_RUNNABLE', 'Workflow cannot run for this media.')
        : textResult(result);
    }
    if (name === 'publish_media') {
      const input = args as z.infer<(typeof toolSchemas)['publish_media']>;
      if (this.options.mediaRepository?.findById(input.mediaId) === undefined)
        return toolError('MEDIA_NOT_FOUND', 'Media not found.');
      if (this.options.jobService === undefined)
        return toolError('RESOURCE_UNAVAILABLE', 'Publishing is unavailable.');
      if (input.platform === 'tiktok') {
        const capabilities = await this.options.tiktokOAuthService?.getAccountCapabilities(
          input.accountId,
        );
        if (
          capabilities === undefined ||
          !capabilities.directPostAvailable ||
          !capabilities.privacyLevelOptions.includes(input.metadata.privacyLevel)
        )
          return toolError(
            'PUBLISH_OPTIONS_UNAVAILABLE',
            'The selected TikTok options are unavailable.',
          );
      }
      const result = this.options.jobService.create({
        idempotencyKey: `mcp:${input.platform}:${input.idempotencyKey}`,
        input: JSON.parse(
          JSON.stringify({
            accountId: input.accountId,
            mediaId: input.mediaId,
            metadata: input.metadata,
          }),
        ) as JsonValue,
        type: input.platform === 'youtube' ? 'youtube.upload' : 'tiktok.direct-post',
      });
      return textResult({ created: result.created, job: safeJob(result.job) });
    }
    const { definition, timeZone, workflowId } = args as z.infer<
      (typeof toolSchemas)['schedule_workflow']
    >;
    const workflow = this.options.workflowService?.get(workflowId);
    if (workflow === undefined) return toolError('WORKFLOW_NOT_FOUND', 'Workflow not found.');
    if (workflow.remoteSource === undefined)
      return toolError('SCHEDULE_UNSUPPORTED', 'Only remote-source workflows can be scheduled.');
    if (this.options.scheduleService === undefined)
      return toolError('RESOURCE_UNAVAILABLE', 'Scheduling is unavailable.');
    return textResult({
      schedule: this.options.scheduleService.create({
        definition,
        target: {
          kind: 'source_poll',
          sourceConnectionId: workflow.remoteSource.connectionId,
          version: 1,
        },
        timeZone,
      }),
    });
  }

  private error(id: McpRequest['id'], code: number, message: string): JsonRecord {
    return { error: { code, message }, id: id ?? null, jsonrpc: '2.0' };
  }

  private result(id: McpRequest['id'], result: unknown): JsonRecord {
    return { id: id ?? null, jsonrpc: '2.0', result };
  }
}

export function createMcpServer(options: McpServiceOptions): McpServer {
  return new McpServer(options);
}

/** Runs the standard newline-delimited JSON-RPC transport used by local stdio MCP clients. */
export async function serveMcpStdio(
  server: McpServer,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const lines = createInterface({ crlfDelay: Infinity, input });
  for await (const line of lines) {
    let request: McpRequest;
    try {
      request = JSON.parse(line) as McpRequest;
    } catch {
      output.write(
        `${JSON.stringify({
          error: { code: -32700, message: 'Invalid JSON.' },
          id: null,
          jsonrpc: '2.0',
        })}\n`,
      );
      continue;
    }
    const response = await server.handle(request);
    if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
  }
}
