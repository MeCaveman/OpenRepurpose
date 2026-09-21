import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import {
  compileWorkflowExecutionPlan,
  serializeNormalizedTransformPlan,
  transcriptCueListSchema,
  transcriptCueSchema,
  transformPlanSchema,
} from '@openrepurpose/core';
import type {
  AccountCapability,
  AccountProvider,
  AccountRepository,
  AccountStatus,
  ConnectedAccount,
  DestinationJobRecord,
  DestinationJobRepository,
  EnqueueJobInput,
  EnqueueJobResult,
  Job,
  JobAccountControl,
  JobAttempt,
  JobClaimLimits,
  JobFailure,
  JobQueueMode,
  JobQueueState,
  JobRepository,
  JobStatus,
  JsonValue,
  MediaAsset,
  MediaRepository,
  ReserveTransformDerivativeInput,
  ReserveTransformDerivativeResult,
  SourceMediaArtifact,
  SourceMediaDescriptor,
  SourceMediaOwnership,
  SourceMediaResolution,
  SourceMediaResolutionRepository,
  SourceExecutionDestination,
  SourceRetentionPolicy,
  SourceWorkflowExecution,
  SourceWorkflowExecutionRepository,
  SourceWorkflowExecutionSnapshot,
  MetaCredential,
  MetaCredentialRepository,
  MetaCredentialStatus,
  MetaPublishTarget,
  MetaTargetAvailability,
  MetaTargetKind,
  OAuthAuthorizationRequest,
  OAuthAuthorizationRequestRepository,
  UpsertConnectedAccountInput,
  SourceCursor,
  SourceCursorRepository,
  SourceConnection,
  Schedule,
  ScheduleOccurrence,
  ScheduleRepository,
  SourcePollingRepository,
  RemoteSourceItem,
  SourceItemObservation,
  SourceJsonValue,
  Workflow,
  WorkflowDefinition,
  WorkflowDestination,
  WorkflowRepository,
  RemoteWorkflowSource,
  TransformDerivative,
  TransformDerivativeOutput,
  TransformDerivativeRepository,
  TransformDerivativeStatus,
  TransformProgress,
  Transcript,
  TranscriptCue,
  TranscriptRepository,
  TranscriptSource,
  TranscriptionOptionValue,
  ReserveTranscriptInput,
  ReserveTranscriptResult,
} from '@openrepurpose/core';
import { migrations } from './migrations/index.js';
import type { Migration } from './migrations/types.js';
import { mediaAssets, metaCredentials, metaPublishTargets, settings } from './schema.js';

export { migrations } from './migrations/index.js';
export type { Migration } from './migrations/index.js';
export {
  accounts,
  destinationJobRecords,
  jobAttempts,
  jobs,
  mediaAssets,
  oauthAuthorizationRequests,
  metaCredentials,
  metaPublishTargets,
  settings,
  sourceConnections,
  schedules,
  scheduleOccurrences,
  sourceCursors,
  sourceExecutionDestinations,
  sourceItems,
  sourceMediaArtifacts,
  sourceMediaResolutions,
  sourceWorkflowExecutions,
  transformDerivatives,
  transcripts,
  transcriptCues,
  workflowRemoteSources,
  workflows,
  workflowDestinations,
} from './schema.js';

export interface OpenDatabaseOptions {
  readonly createParentDirectory?: boolean;
}

export interface OpenRepurposeDatabase {
  readonly client: DatabaseSync;
  readonly db: ReturnType<typeof drizzle>;
  close(): void;
}

/** Opens a local SQLite database with durability and referential-integrity safeguards enabled. */
export function openDatabase(
  path: string,
  options: OpenDatabaseOptions = {},
): OpenRepurposeDatabase {
  if (options.createParentDirectory ?? true) mkdirSync(dirname(path), { recursive: true });
  const client = new DatabaseSync(path);
  client.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return { client, db: drizzle({ client }), close: () => client.close() };
}

/** Applies each unapplied migration atomically and rejects altered historical migrations. */
export function runMigrations(
  database: OpenRepurposeDatabase,
  migrationSet: readonly Migration[] = migrations,
): void {
  database.client.exec(
    `CREATE TABLE IF NOT EXISTS __openrepurpose_migrations (id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL);`,
  );
  const lookup = database.client.prepare(
    'SELECT checksum FROM __openrepurpose_migrations WHERE id = ?',
  );
  const record = database.client.prepare(
    'INSERT INTO __openrepurpose_migrations (id, checksum, applied_at) VALUES (?, ?, ?)',
  );
  for (const migration of migrationSet) {
    const checksum = createHash('sha256')
      .update(migration.sql)
      .update(migration.foreignKeysDisabled === true ? '\nforeign_keys_disabled=true' : '')
      .digest('hex');
    const existing = lookup.get(migration.id) as { checksum: string } | undefined;
    if (existing !== undefined) {
      if (existing.checksum !== checksum)
        throw new Error(`Applied migration ${migration.id} does not match its recorded checksum.`);
      continue;
    }
    if (migration.foreignKeysDisabled === true) database.client.exec('PRAGMA foreign_keys = OFF;');
    database.client.exec('BEGIN IMMEDIATE;');
    try {
      database.client.exec(migration.sql);
      if (
        migration.foreignKeysDisabled === true &&
        database.client.prepare('PRAGMA foreign_key_check;').all().length > 0
      )
        throw new Error(`Migration ${migration.id} introduced a foreign key violation.`);
      record.run(migration.id, checksum, Date.now());
      database.client.exec('COMMIT;');
    } catch (error) {
      database.client.exec('ROLLBACK;');
      throw error;
    } finally {
      if (migration.foreignKeysDisabled === true) database.client.exec('PRAGMA foreign_keys = ON;');
    }
  }
}

/** Infrastructure repository for durable settings; domain services depend on its narrow contract. */
export class SettingsRepository {
  public constructor(private readonly database: OpenRepurposeDatabase) {}
  public get(key: string): string | undefined {
    return this.database.db.select().from(settings).where(eq(settings.key, key)).get()?.value;
  }
  public set(key: string, value: string): void {
    const updatedAt = new Date();
    this.database.db
      .insert(settings)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } })
      .run();
  }
}

/** SQLite implementation of the media-library boundary. */
export class SqliteMediaRepository implements MediaRepository {
  public constructor(private readonly database: OpenRepurposeDatabase) {}
  public create(asset: MediaAsset): MediaAsset {
    this.database.db.insert(mediaAssets).values(this.toRow(asset)).run();
    return asset;
  }
  public findById(id: string): MediaAsset | undefined {
    const row = this.database.db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).get();
    return row === undefined ? undefined : this.toAsset(row);
  }
  public findByFingerprint(fingerprint: string): MediaAsset | undefined {
    const row = this.database.db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.fingerprint, fingerprint))
      .get();
    return row === undefined ? undefined : this.toAsset(row);
  }
  public list(): readonly MediaAsset[] {
    return this.database.db
      .select()
      .from(mediaAssets)
      .orderBy(desc(mediaAssets.createdAt))
      .all()
      .map((row) => this.toAsset(row));
  }
  private toRow(asset: MediaAsset) {
    return {
      id: asset.id,
      path: asset.path,
      fingerprint: asset.fingerprint,
      sizeBytes: asset.sizeBytes,
      modifiedAt: asset.modifiedAt,
      state: asset.state,
      durationMillis:
        asset.metadata.durationSeconds === undefined
          ? null
          : Math.round(asset.metadata.durationSeconds * 1000),
      videoCodec: asset.metadata.videoCodec ?? null,
      audioCodec: asset.metadata.audioCodec ?? null,
      width: asset.metadata.width ?? null,
      height: asset.metadata.height ?? null,
      frameRateMilli:
        asset.metadata.frameRate === undefined ? null : Math.round(asset.metadata.frameRate * 1000),
      hasAudio: asset.metadata.hasAudio,
      createdAt: asset.createdAt,
    };
  }
  private toAsset(row: typeof mediaAssets.$inferSelect): MediaAsset {
    return {
      id: row.id,
      path: row.path,
      fingerprint: row.fingerprint,
      sizeBytes: row.sizeBytes,
      modifiedAt: row.modifiedAt,
      state: row.state,
      createdAt: row.createdAt,
      metadata: {
        hasAudio: row.hasAudio,
        ...(row.durationMillis === null ? {} : { durationSeconds: row.durationMillis / 1000 }),
        ...(row.videoCodec === null ? {} : { videoCodec: row.videoCodec }),
        ...(row.audioCodec === null ? {} : { audioCodec: row.audioCodec }),
        ...(row.width === null ? {} : { width: row.width }),
        ...(row.height === null ? {} : { height: row.height }),
        ...(row.frameRateMilli === null ? {} : { frameRate: row.frameRateMilli / 1000 }),
      },
    };
  }
}

interface RawTransformDerivativeRow {
  readonly cache_key: string;
  readonly completed_at: number | null;
  readonly created_at: number;
  readonly encoder: string;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly ffmpeg_version: string;
  readonly id: string;
  readonly normalized_plan_json: string;
  readonly output_audio_codec: string | null;
  readonly output_duration_millis: number | null;
  readonly output_frame_rate_milli: number | null;
  readonly output_has_audio: number | null;
  readonly output_height: number | null;
  readonly output_path: string | null;
  readonly output_profile_version: string;
  readonly output_size_bytes: number | null;
  readonly output_video_codec: string | null;
  readonly output_width: number | null;
  readonly sidecar_caption_path: string | null;
  readonly sidecar_caption_size_bytes: number | null;
  readonly progress_json: string | null;
  readonly progress_updated_at: number | null;
  readonly recipe_hash: string;
  readonly source_fingerprint: string;
  readonly source_media_id: string;
  readonly status: TransformDerivativeStatus;
  readonly updated_at: number;
}

function transformDerivativeFromRow(row: RawTransformDerivativeRow): TransformDerivative {
  const output: TransformDerivativeOutput | undefined =
    row.output_path === null ||
    row.output_size_bytes === null ||
    row.output_duration_millis === null ||
    row.output_video_codec === null ||
    row.output_width === null ||
    row.output_height === null ||
    row.output_has_audio === null
      ? undefined
      : {
          path: row.output_path,
          sizeBytes: row.output_size_bytes,
          metadata: {
            durationMillis: row.output_duration_millis,
            hasAudio: row.output_has_audio === 1,
            height: row.output_height,
            videoCodec: row.output_video_codec,
            width: row.output_width,
            ...(row.output_audio_codec === null ? {} : { audioCodec: row.output_audio_codec }),
            ...(row.output_frame_rate_milli === null
              ? {}
              : { frameRate: row.output_frame_rate_milli / 1000 }),
          },
        };
  const sidecarCaptions =
    row.sidecar_caption_path === null || row.sidecar_caption_size_bytes === null
      ? undefined
      : {
          format: 'srt' as const,
          path: row.sidecar_caption_path,
          sizeBytes: row.sidecar_caption_size_bytes,
        };
  return {
    cacheKey: row.cache_key,
    createdAt: new Date(row.created_at),
    id: row.id,
    provenance: {
      encoder: row.encoder,
      ffmpegVersion: row.ffmpeg_version,
      normalizedPlan: transformPlanSchema.parse(JSON.parse(row.normalized_plan_json)),
      outputProfileVersion: row.output_profile_version,
      recipeHash: row.recipe_hash,
      sourceFingerprint: row.source_fingerprint,
      sourceMediaId: row.source_media_id,
    },
    status: row.status,
    updatedAt: new Date(row.updated_at),
    ...(row.completed_at === null ? {} : { completedAt: new Date(row.completed_at) }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    ...(output === undefined
      ? {}
      : { output: { ...output, ...(sidecarCaptions === undefined ? {} : { sidecarCaptions }) } }),
    ...(row.progress_json === null
      ? {}
      : { progress: JSON.parse(row.progress_json) as TransformProgress }),
    ...(row.progress_updated_at === null
      ? {}
      : { progressUpdatedAt: new Date(row.progress_updated_at) }),
  };
}

/** Atomic SQLite reservation and lifecycle transitions for deterministic transform outputs. */
export class SqliteTransformDerivativeRepository implements TransformDerivativeRepository {
  public constructor(private readonly database: OpenRepurposeDatabase) {}

  public reserve(input: ReserveTransformDerivativeInput): ReserveTransformDerivativeResult {
    const result = this.database.client
      .prepare(
        `INSERT OR IGNORE INTO transform_derivatives (
           id, source_media_id, source_fingerprint, cache_key, recipe_hash,
           normalized_plan_json, output_profile_version, ffmpeg_version, encoder,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        input.id,
        input.sourceMediaId,
        input.identity.sourceFingerprint,
        input.identity.cacheKey,
        input.identity.recipeHash,
        serializeNormalizedTransformPlan(input.identity.normalizedPlan),
        input.identity.outputProfileVersion,
        input.identity.tool.ffmpegVersion,
        input.identity.tool.encoder,
        input.now.getTime(),
        input.now.getTime(),
      );
    const derivative = this.findByCacheKey(input.identity.cacheKey);
    if (derivative === undefined) throw new Error('Transform derivative reservation failed.');
    return { created: Number(result.changes) === 1, derivative };
  }

  public findById(id: string): TransformDerivative | undefined {
    return this.findOne('id', id);
  }

  public findByCacheKey(cacheKey: string): TransformDerivative | undefined {
    return this.findOne('cache_key', cacheKey);
  }

  public list(status?: TransformDerivativeStatus): readonly TransformDerivative[] {
    const rows = (status === undefined
      ? this.database.client
          .prepare('SELECT * FROM transform_derivatives ORDER BY created_at DESC')
          .all()
      : this.database.client
          .prepare('SELECT * FROM transform_derivatives WHERE status = ? ORDER BY created_at DESC')
          .all(status)) as unknown as RawTransformDerivativeRow[];
    return rows.map(transformDerivativeFromRow);
  }

  public markRunning(id: string, now: Date): TransformDerivative {
    const result = this.database.client
      .prepare(
        `UPDATE transform_derivatives
         SET status = 'running', error_code = NULL, error_message = NULL,
             completed_at = NULL, progress_json = NULL, progress_updated_at = NULL,
             updated_at = ?
         WHERE id = ? AND status IN ('pending', 'failed')`,
      )
      .run(now.getTime(), id);
    if (Number(result.changes) !== 1)
      throw new Error('Transform derivative is not available to run.');
    return this.required(id);
  }

  public updateProgress(id: string, progress: TransformProgress, now: Date): boolean {
    const result = this.database.client
      .prepare(
        `UPDATE transform_derivatives
         SET progress_json = ?, progress_updated_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(JSON.stringify(progress), now.getTime(), now.getTime(), id);
    return Number(result.changes) === 1;
  }

  public complete(id: string, output: TransformDerivativeOutput, now: Date): TransformDerivative {
    const result = this.database.client
      .prepare(
        `UPDATE transform_derivatives
         SET status = 'succeeded', output_path = ?, output_size_bytes = ?,
             output_duration_millis = ?, output_video_codec = ?, output_audio_codec = ?,
             output_width = ?, output_height = ?, output_frame_rate_milli = ?,
             output_has_audio = ?, sidecar_caption_path = ?, sidecar_caption_size_bytes = ?, progress_json = NULL, progress_updated_at = NULL,
             updated_at = ?, completed_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(
        output.path,
        output.sizeBytes,
        output.metadata.durationMillis,
        output.metadata.videoCodec,
        output.metadata.audioCodec ?? null,
        output.metadata.width,
        output.metadata.height,
        output.metadata.frameRate === undefined
          ? null
          : Math.round(output.metadata.frameRate * 1000),
        output.metadata.hasAudio ? 1 : 0,
        output.sidecarCaptions?.path ?? null,
        output.sidecarCaptions?.sizeBytes ?? null,
        now.getTime(),
        now.getTime(),
        id,
      );
    if (Number(result.changes) !== 1) throw new Error('Transform completion was not accepted.');
    return this.required(id);
  }

  public fail(
    id: string,
    failure: { readonly code: string; readonly message: string },
    now: Date,
  ): TransformDerivative {
    return this.finishWithoutOutput(id, 'failed', now, failure);
  }

  public markCancelled(id: string, now: Date): TransformDerivative {
    return this.finishWithoutOutput(id, 'cancelled', now);
  }

  public invalidateSucceeded(
    id: string,
    failure: { readonly code: string; readonly message: string },
    now: Date,
  ): TransformDerivative {
    const result = this.database.client
      .prepare(
        `UPDATE transform_derivatives
         SET status = 'failed', output_path = NULL, output_size_bytes = NULL,
             output_duration_millis = NULL, output_video_codec = NULL,
             output_audio_codec = NULL, output_width = NULL, output_height = NULL,
             output_frame_rate_milli = NULL, output_has_audio = NULL,
             error_code = ?, error_message = ?, progress_json = NULL,
             progress_updated_at = NULL, updated_at = ?, completed_at = ?
         WHERE id = ? AND status = 'succeeded'`,
      )
      .run(failure.code, failure.message, now.getTime(), now.getTime(), id);
    if (Number(result.changes) !== 1) throw new Error('Transform invalidation was rejected.');
    return this.required(id);
  }

  public resetPending(id: string, now: Date): TransformDerivative {
    const result = this.database.client
      .prepare(
        `UPDATE transform_derivatives
         SET status = 'pending', error_code = NULL, error_message = NULL,
             progress_json = NULL, progress_updated_at = NULL, completed_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('failed', 'cancelled')`,
      )
      .run(now.getTime(), id);
    if (Number(result.changes) !== 1) throw new Error('Transform derivative cannot be reset.');
    return this.required(id);
  }

  public recoverRunning(now: Date): readonly TransformDerivative[] {
    const running = this.list('running');
    for (const derivative of running)
      this.fail(
        derivative.id,
        {
          code: 'TRANSFORM_INTERRUPTED',
          message: 'The previous transform worker stopped before finalization.',
        },
        now,
      );
    return running.map((derivative) => this.required(derivative.id));
  }

  private finishWithoutOutput(
    id: string,
    status: 'cancelled' | 'failed',
    now: Date,
    failure?: { readonly code: string; readonly message: string },
  ): TransformDerivative {
    const result = this.database.client
      .prepare(
        `UPDATE transform_derivatives
         SET status = ?, output_path = NULL, output_size_bytes = NULL,
             output_duration_millis = NULL, output_video_codec = NULL,
             output_audio_codec = NULL, output_width = NULL, output_height = NULL,
             output_frame_rate_milli = NULL, output_has_audio = NULL,
             error_code = ?, error_message = ?, progress_json = NULL,
             progress_updated_at = NULL, updated_at = ?, completed_at = ?
         WHERE id = ? AND status IN ('pending', 'running')`,
      )
      .run(
        status,
        status === 'failed' ? (failure?.code ?? 'TRANSFORM_FAILED') : null,
        status === 'failed' ? (failure?.message ?? 'Transform failed.') : null,
        now.getTime(),
        now.getTime(),
        id,
      );
    if (Number(result.changes) !== 1)
      throw new Error(`Transform ${status} transition was rejected.`);
    return this.required(id);
  }

  private findOne(column: 'cache_key' | 'id', value: string): TransformDerivative | undefined {
    const row = this.database.client
      .prepare(`SELECT * FROM transform_derivatives WHERE ${column} = ?`)
      .get(value) as unknown as RawTransformDerivativeRow | undefined;
    return row === undefined ? undefined : transformDerivativeFromRow(row);
  }

  private required(id: string): TransformDerivative {
    const derivative = this.findById(id);
    if (derivative === undefined) throw new Error('Transform derivative does not exist.');
    return derivative;
  }
}

interface RawTranscriptRow {
  readonly cache_key: string;
  readonly created_at: number;
  readonly derivative_id: string | null;
  readonly generated_at: number | null;
  readonly has_user_edits: number;
  readonly id: string;
  readonly language: string | null;
  readonly media_id: string | null;
  readonly model_id: string;
  readonly model_version: string;
  readonly options_json: string;
  readonly provider_id: string;
  readonly revision: number;
  readonly source_audio_fingerprint: string;
  readonly updated_at: number;
}

interface RawTranscriptCueRow {
  readonly end_millis: number;
  readonly position: number;
  readonly start_millis: number;
  readonly text: string;
  readonly words_json: string | null;
}

function transcriptFromRows(
  row: RawTranscriptRow,
  cues: readonly RawTranscriptCueRow[],
): Transcript {
  const source: TranscriptSource =
    row.media_id === null
      ? { kind: 'derivative', derivativeId: requiredValue(row.derivative_id, 'derivative ID') }
      : { kind: 'media', mediaId: row.media_id };
  return {
    cacheKey: row.cache_key,
    createdAt: new Date(row.created_at),
    cues: cues.map((cue) =>
      transcriptCueSchema.parse({
        endMs: cue.end_millis,
        startMs: cue.start_millis,
        text: cue.text,
        ...(cue.words_json === null ? {} : { words: JSON.parse(cue.words_json) }),
      }),
    ),
    ...(row.generated_at === null ? {} : { generatedAt: new Date(row.generated_at) }),
    hasUserEdits: row.has_user_edits === 1,
    id: row.id,
    ...(row.language === null ? {} : { language: row.language }),
    model: { id: row.model_id, version: row.model_version },
    options: JSON.parse(row.options_json) as Readonly<Record<string, TranscriptionOptionValue>>,
    providerId: row.provider_id,
    revision: row.revision,
    source,
    sourceAudioFingerprint: row.source_audio_fingerprint,
    updatedAt: new Date(row.updated_at),
  };
}

function requiredValue(value: string | null, label: string): string {
  if (value === null) throw new Error(`Transcript is missing its ${label}.`);
  return value;
}

/** Atomic SQLite transcript cache reservation and cue-edit persistence. */
export class SqliteTranscriptRepository implements TranscriptRepository {
  public constructor(private readonly database: OpenRepurposeDatabase) {}

  public reserve(input: ReserveTranscriptInput): ReserveTranscriptResult {
    const source =
      input.source.kind === 'media'
        ? { mediaId: input.source.mediaId, derivativeId: null }
        : { mediaId: null, derivativeId: input.source.derivativeId };
    const result = this.database.client
      .prepare(
        `INSERT OR IGNORE INTO transcripts (
          id, media_id, derivative_id, source_audio_fingerprint, cache_key, provider_id,
          model_id, model_version, language, options_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        source.mediaId,
        source.derivativeId,
        input.identity.sourceAudioFingerprint,
        input.identity.cacheKey,
        input.identity.providerId,
        input.identity.model.id,
        input.identity.model.version,
        input.identity.language ?? null,
        JSON.stringify(input.identity.normalizedOptions),
        input.now.getTime(),
        input.now.getTime(),
      );
    const transcript = this.findByCacheKey(input.identity.cacheKey);
    if (transcript === undefined) throw new Error('Transcript reservation failed.');
    return { created: Number(result.changes) === 1, transcript };
  }

  public findById(id: string): Transcript | undefined {
    const row = this.database.client
      .prepare('SELECT * FROM transcripts WHERE id = ?')
      .get(id) as unknown as RawTranscriptRow | undefined;
    return row === undefined ? undefined : this.withCues(row);
  }

  public findByCacheKey(cacheKey: string): Transcript | undefined {
    const row = this.database.client
      .prepare('SELECT * FROM transcripts WHERE cache_key = ?')
      .get(cacheKey) as unknown as RawTranscriptRow | undefined;
    return row === undefined ? undefined : this.withCues(row);
  }

  public listByMediaId(mediaId: string): readonly Transcript[] {
    const rows = this.database.client
      .prepare('SELECT * FROM transcripts WHERE media_id = ? ORDER BY updated_at DESC, id ASC')
      .all(mediaId) as unknown as RawTranscriptRow[];
    return rows.map((row) => this.withCues(row));
  }

  public replaceGeneratedCues(id: string, cues: readonly TranscriptCue[], now: Date): Transcript {
    const normalized = transcriptCueListSchema.parse(cues);
    this.database.client.exec('BEGIN IMMEDIATE;');
    try {
      const update = this.database.client
        .prepare(
          `UPDATE transcripts
           SET generated_at = ?, updated_at = ?, revision = revision + 1
           WHERE id = ? AND has_user_edits = 0`,
        )
        .run(now.getTime(), now.getTime(), id);
      if (Number(update.changes) !== 1)
        throw new Error('Generated cues cannot overwrite a user-edited or missing transcript.');
      this.database.client.prepare('DELETE FROM transcript_cues WHERE transcript_id = ?').run(id);
      const insert = this.database.client.prepare(
        `INSERT INTO transcript_cues (
          transcript_id, position, start_millis, end_millis, text, words_json
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      normalized.forEach((cue, position) =>
        insert.run(
          id,
          position,
          cue.startMs,
          cue.endMs,
          cue.text,
          cue.words === undefined ? null : JSON.stringify(cue.words),
        ),
      );
      this.database.client.exec('COMMIT;');
    } catch (error) {
      this.database.client.exec('ROLLBACK;');
      throw error;
    }
    return this.required(id);
  }

  public replaceUserEditedCues(
    id: string,
    expectedRevision: number,
    cues: readonly TranscriptCue[],
    now: Date,
  ): Transcript | undefined {
    const normalized = transcriptCueListSchema.parse(cues);
    this.database.client.exec('BEGIN IMMEDIATE;');
    try {
      const update = this.database.client
        .prepare(
          `UPDATE transcripts
           SET has_user_edits = 1, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(now.getTime(), id, expectedRevision);
      if (Number(update.changes) !== 1) {
        this.database.client.exec('ROLLBACK;');
        return undefined;
      }
      this.database.client.prepare('DELETE FROM transcript_cues WHERE transcript_id = ?').run(id);
      const insert = this.database.client.prepare(
        `INSERT INTO transcript_cues (
          transcript_id, position, start_millis, end_millis, text, words_json
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      normalized.forEach((cue, position) =>
        insert.run(
          id,
          position,
          cue.startMs,
          cue.endMs,
          cue.text,
          cue.words === undefined ? null : JSON.stringify(cue.words),
        ),
      );
      this.database.client.exec('COMMIT;');
    } catch (error) {
      this.database.client.exec('ROLLBACK;');
      throw error;
    }
    return this.required(id);
  }

  public updateCue(id: string, position: number, cue: TranscriptCue, now: Date): Transcript {
    const normalized = transcriptCueSchema.parse(cue);
    this.database.client.exec('BEGIN IMMEDIATE;');
    try {
      const cueUpdate = this.database.client
        .prepare(
          `UPDATE transcript_cues
           SET start_millis = ?, end_millis = ?, text = ?, words_json = ?
           WHERE transcript_id = ? AND position = ?`,
        )
        .run(
          normalized.startMs,
          normalized.endMs,
          normalized.text,
          normalized.words === undefined ? null : JSON.stringify(normalized.words),
          id,
          position,
        );
      if (Number(cueUpdate.changes) !== 1) throw new Error('Transcript cue does not exist.');
      this.database.client
        .prepare(
          `UPDATE transcripts
           SET has_user_edits = 1, revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(now.getTime(), id);
      this.database.client.exec('COMMIT;');
    } catch (error) {
      this.database.client.exec('ROLLBACK;');
      throw error;
    }
    return this.required(id);
  }

  private withCues(row: RawTranscriptRow): Transcript {
    const cues = this.database.client
      .prepare('SELECT * FROM transcript_cues WHERE transcript_id = ? ORDER BY position')
      .all(row.id) as unknown as RawTranscriptCueRow[];
    return transcriptFromRows(row, cues);
  }

  private required(id: string): Transcript {
    const transcript = this.findById(id);
    if (transcript === undefined) throw new Error('Transcript does not exist.');
    return transcript;
  }
}

interface RawWorkflowRow {
  readonly created_at: number;
  readonly description_template: string;
  readonly definition_json: string | null;
  readonly enabled: number;
  readonly execution_plan_json: string | null;
  readonly execution_plan_version: string | null;
  readonly failure_policy: Workflow['failurePolicy'];
  readonly id: string;
  readonly name: string;
  readonly source_directory: string;
  readonly title_template: string;
  readonly updated_at: number;
}

interface RawWorkflowDestinationRow {
  readonly account_id: string;
  readonly configuration_json: string;
  readonly destination_id: WorkflowDestination['destinationId'];
}

interface RawWorkflowRemoteSourceRow {
  readonly filters_json: string;
  readonly local_original_json: string | null;
  readonly retention_duration_seconds: number | null;
  readonly retention_policy: SourceRetentionPolicy['kind'];
  readonly rights_confirmed: number;
  readonly source_connection_id: string;
}

function workflowDestinationFromRow(row: RawWorkflowDestinationRow): WorkflowDestination {
  const configuration = JSON.parse(row.configuration_json) as Record<string, unknown>;
  if (row.destination_id === 'youtube') {
    return {
      destinationId: 'youtube',
      accountId: row.account_id,
      privacy: configuration.privacy as Extract<
        WorkflowDestination,
        { destinationId: 'youtube' }
      >['privacy'],
      ...(typeof configuration.category === 'string' ? { category: configuration.category } : {}),
    };
  }
  if (row.destination_id === 'instagram') {
    return {
      destinationId: 'instagram',
      accountId: row.account_id,
      ...(typeof configuration.captionTemplate === 'string'
        ? { captionTemplate: configuration.captionTemplate }
        : {}),
      ...(typeof configuration.shareToFeed === 'boolean'
        ? { shareToFeed: configuration.shareToFeed }
        : {}),
    };
  }
  if (row.destination_id === 'facebook') {
    return {
      destinationId: 'facebook',
      accountId: row.account_id,
      ...(typeof configuration.titleTemplate === 'string'
        ? { titleTemplate: configuration.titleTemplate }
        : {}),
      ...(typeof configuration.descriptionTemplate === 'string'
        ? { descriptionTemplate: configuration.descriptionTemplate }
        : {}),
    };
  }
  return {
    destinationId: 'tiktok',
    accountId: row.account_id,
    privacyLevel: configuration.privacyLevel as Extract<
      WorkflowDestination,
      { destinationId: 'tiktok' }
    >['privacyLevel'],
    ...(typeof configuration.captionTemplate === 'string'
      ? { captionTemplate: configuration.captionTemplate }
      : {}),
    ...(typeof configuration.disableComment === 'boolean'
      ? { disableComment: configuration.disableComment }
      : {}),
    ...(typeof configuration.disableDuet === 'boolean'
      ? { disableDuet: configuration.disableDuet }
      : {}),
    ...(typeof configuration.disableStitch === 'boolean'
      ? { disableStitch: configuration.disableStitch }
      : {}),
  };
}

function workflowFromRow(
  row: RawWorkflowRow,
  destinations: readonly WorkflowDestination[],
  remoteSource?: RemoteWorkflowSource,
): Workflow {
  const definition =
    row.definition_json === null
      ? legacyDefinition(row, destinations, remoteSource)
      : (JSON.parse(row.definition_json) as WorkflowDefinition);
  // Recompile on read so stored JSON remains an audit snapshot, never an executable command.
  const plan = compileWorkflowExecutionPlan({
    definition,
    id: row.id,
    name: row.name,
    titleTemplate: row.title_template,
    descriptionTemplate: row.description_template,
    failurePolicy: row.failure_policy,
  });
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    sourceDirectory: row.source_directory,
    titleTemplate: row.title_template,
    descriptionTemplate: row.description_template,
    definition,
    plan,
    destinations,
    ...(remoteSource === undefined ? {} : { remoteSource }),
    failurePolicy: row.failure_policy,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function legacyDefinition(
  row: RawWorkflowRow,
  destinations: readonly WorkflowDestination[],
  remoteSource?: RemoteWorkflowSource,
): WorkflowDefinition {
  const source = {
    id: 'source',
    kind: 'source' as const,
    sourceType: remoteSource === undefined ? ('watched_folder' as const) : ('remote' as const),
  };
  const destinationSteps = destinations.map((destination, position) => ({
    id: `destination-${position + 1}`,
    kind: 'destination' as const,
    destination,
  }));
  return {
    schemaVersion: 1,
    steps: [source, ...destinationSteps],
    edges: destinationSteps.map((step) => ({ from: source.id, to: step.id })),
  };
}

/** SQLite workflow definitions. Execution snapshots are placed in jobs by WorkflowService. */
export class SqliteWorkflowRepository implements WorkflowRepository {
  public constructor(private readonly database: OpenRepurposeDatabase) {}
  public create(workflow: Workflow): Workflow {
    this.write(workflow, false);
    return workflow;
  }
  public delete(id: string): boolean {
    return (
      Number(this.database.client.prepare('DELETE FROM workflows WHERE id = ?').run(id).changes) ===
      1
    );
  }
  public findById(id: string): Workflow | undefined {
    const row = this.database.client.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as
      RawWorkflowRow | undefined;
    return row === undefined
      ? undefined
      : workflowFromRow(row, this.destinations(id), this.remoteSource(id));
  }
  public list(enabled?: boolean): readonly Workflow[] {
    const statement =
      enabled === undefined
        ? this.database.client.prepare('SELECT * FROM workflows ORDER BY created_at DESC, id DESC')
        : this.database.client.prepare(
            'SELECT * FROM workflows WHERE enabled = ? ORDER BY created_at DESC, id DESC',
          );
    const rows = (enabled === undefined
      ? statement.all()
      : statement.all(enabled ? 1 : 0)) as unknown as RawWorkflowRow[];
    return rows.map((row) =>
      workflowFromRow(row, this.destinations(row.id), this.remoteSource(row.id)),
    );
  }
  public update(workflow: Workflow): Workflow | undefined {
    const result = this.write(workflow, true);
    return result ? workflow : undefined;
  }
  private write(workflow: Workflow, update: boolean): boolean {
    const client = this.database.client;
    const values = [
      workflow.name,
      workflow.enabled ? 1 : 0,
      workflow.sourceDirectory,
      workflow.titleTemplate,
      workflow.descriptionTemplate,
      workflow.failurePolicy,
      JSON.stringify(workflow.definition),
      JSON.stringify(workflow.plan),
      workflow.plan.planVersion,
      workflow.createdAt.getTime(),
      workflow.updatedAt.getTime(),
      workflow.id,
    ];
    client.exec('BEGIN IMMEDIATE;');
    try {
      const changed = update
        ? Number(
            client
              .prepare(
                `UPDATE workflows SET name=?, enabled=?, source_directory=?, title_template=?, description_template=?, failure_policy=?, definition_json=?, execution_plan_json=?, execution_plan_version=?, created_at=?, updated_at=? WHERE id=?`,
              )
              .run(...values).changes,
          ) === 1
        : (client
            .prepare(
              `INSERT INTO workflows (name, enabled, source_directory, title_template, description_template, failure_policy, definition_json, execution_plan_json, execution_plan_version, created_at, updated_at, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(...values),
          true);
      if (changed) {
        client.prepare('DELETE FROM workflow_destinations WHERE workflow_id = ?').run(workflow.id);
        const insert = client.prepare(
          `INSERT INTO workflow_destinations (
             workflow_id, destination_id, account_id, position, configuration_json
           ) VALUES (?, ?, ?, ?, ?)`,
        );
        workflow.destinations.forEach((destination, position) => {
          const { accountId, destinationId, ...configuration } = destination;
          insert.run(
            workflow.id,
            destinationId,
            accountId,
            position,
            JSON.stringify(configuration),
          );
        });
        client
          .prepare('DELETE FROM workflow_remote_sources WHERE workflow_id = ?')
          .run(workflow.id);
        if (workflow.remoteSource !== undefined) {
          const retention = workflow.remoteSource.retentionPolicy ?? {
            kind: 'delete_after_success' as const,
          };
          client
            .prepare(
              `INSERT INTO workflow_remote_sources (
                workflow_id, source_connection_id, filters_json, retention_policy,
                retention_duration_seconds, rights_confirmed, local_original_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              workflow.id,
              workflow.remoteSource.connectionId,
              JSON.stringify(workflow.remoteSource.filters ?? {}),
              retention.kind,
              retention.kind === 'keep_for_duration' ? retention.durationSeconds : null,
              workflow.remoteSource.rightsConfirmed === true ? 1 : 0,
              workflow.remoteSource.localOriginal === undefined
                ? null
                : JSON.stringify(workflow.remoteSource.localOriginal),
            );
        }
      }
      client.exec('COMMIT;');
      return changed;
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }

  private destinations(workflowId: string): readonly WorkflowDestination[] {
    return (
      this.database.client
        .prepare(
          `SELECT destination_id, account_id, configuration_json
           FROM workflow_destinations WHERE workflow_id = ? ORDER BY position ASC`,
        )
        .all(workflowId) as unknown as RawWorkflowDestinationRow[]
    ).map(workflowDestinationFromRow);
  }

  private remoteSource(workflowId: string): RemoteWorkflowSource | undefined {
    const row = this.database.client
      .prepare('SELECT * FROM workflow_remote_sources WHERE workflow_id = ?')
      .get(workflowId) as RawWorkflowRemoteSourceRow | undefined;
    if (row === undefined) return undefined;
    const retentionPolicy: SourceRetentionPolicy =
      row.retention_policy === 'keep_for_duration'
        ? { kind: 'keep_for_duration', durationSeconds: row.retention_duration_seconds! }
        : { kind: row.retention_policy };
    const filters = JSON.parse(row.filters_json) as NonNullable<RemoteWorkflowSource['filters']>;
    return {
      connectionId: row.source_connection_id,
      retentionPolicy,
      ...(Object.keys(filters).length === 0 ? {} : { filters }),
      ...(row.local_original_json === null
        ? {}
        : {
            localOriginal: JSON.parse(row.local_original_json) as NonNullable<
              RemoteWorkflowSource['localOriginal']
            >,
          }),
      ...(row.rights_confirmed === 1 ? { rightsConfirmed: true } : {}),
    };
  }
}

interface RawSourceCursorRow {
  readonly workflow_id: string;
  readonly source_key: string;
  readonly path: string;
  readonly size_bytes: number;
  readonly modified_at: number;
  readonly observed_at: number;
  readonly state: SourceCursor['state'];
  readonly media_id: string | null;
}
function cursorFromRow(row: RawSourceCursorRow): SourceCursor {
  return {
    workflowId: row.workflow_id,
    sourceKey: row.source_key,
    path: row.path,
    sizeBytes: row.size_bytes,
    modifiedAt: new Date(row.modified_at),
    observedAt: new Date(row.observed_at),
    state: row.state,
    ...(row.media_id === null ? {} : { mediaId: row.media_id }),
  };
}
/** Cursor rows retain observed signatures across a restart, enabling settling and dedupe. */
export class SqliteSourceCursorRepository implements SourceCursorRepository {
  public constructor(private readonly database: OpenRepurposeDatabase) {}
  public delete(workflowId: string, sourceKey: string): boolean {
    return (
      Number(
        this.database.client
          .prepare('DELETE FROM source_cursors WHERE workflow_id = ? AND source_key = ?')
          .run(workflowId, sourceKey).changes,
      ) === 1
    );
  }
  public find(workflowId: string, sourceKey: string): SourceCursor | undefined {
    const row = this.database.client
      .prepare('SELECT * FROM source_cursors WHERE workflow_id = ? AND source_key = ?')
      .get(workflowId, sourceKey) as RawSourceCursorRow | undefined;
    return row === undefined ? undefined : cursorFromRow(row);
  }
  public save(cursor: SourceCursor): SourceCursor {
    this.database.client
      .prepare(
        `INSERT INTO source_cursors (workflow_id, source_key, path, size_bytes, modified_at, observed_at, state, media_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workflow_id, source_key) DO UPDATE SET path=excluded.path, size_bytes=excluded.size_bytes, modified_at=excluded.modified_at, observed_at=excluded.observed_at, state=excluded.state, media_id=excluded.media_id`,
      )
      .run(
        cursor.workflowId,
        cursor.sourceKey,
        cursor.path,
        cursor.sizeBytes,
        cursor.modifiedAt.getTime(),
        cursor.observedAt.getTime(),
        cursor.state,
        cursor.mediaId ?? null,
      );
    return cursor;
  }
}

interface RawSourceConnectionRow {
  readonly adapter_id: string;
  readonly cadence_owner: SourceConnection['cadenceOwner'];
  readonly configuration_json: string;
  readonly consecutive_poll_failures: number;
  readonly created_at: number;
  readonly cursor_json: string | null;
  readonly display_name: string;
  readonly external_source_id: string;
  readonly id: string;
  readonly last_poll_at: number | null;
  readonly last_poll_error_code: string | null;
  readonly last_poll_error_message: string | null;
  readonly last_successful_poll_at: number | null;
  readonly next_poll_at: number | null;
  readonly status: SourceConnection['status'];
  readonly updated_at: number;
}

interface RawRemoteSourceItemRow {
  readonly dedupe_key: string;
  readonly event_id: string | null;
  readonly external_id: string;
  readonly first_observed_at: number;
  readonly id: string;
  readonly lifecycle_status:
    | 'observed'
    | 'queued'
    | 'resolving'
    | 'media_ready'
    | 'processing'
    | 'publishing'
    | 'partial_failure'
    | 'retrying'
    | 'published'
    | 'cleanup_pending'
    | 'completed'
    | 'failed';
  readonly last_observed_at: number;
  readonly metadata_json: string;
  readonly media_descriptor_json: string | null;
  readonly published_at: number | null;
  readonly source_connection_id: string;
  readonly resolution_status: 'unresolved' | 'resolving' | 'ready' | 'unavailable' | 'failed';
  readonly updated_at: number;
}

function sourceConnectionFromRow(row: RawSourceConnectionRow): SourceConnection {
  return {
    id: row.id,
    adapterId: row.adapter_id,
    externalSourceId: row.external_source_id,
    displayName: row.display_name,
    configuration: JSON.parse(row.configuration_json) as Record<string, SourceJsonValue>,
    cursor: row.cursor_json,
    status: row.status,
    consecutivePollFailures: row.consecutive_poll_failures,
    cadenceOwner: row.cadence_owner,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    ...(row.last_poll_at === null ? {} : { lastPollAt: new Date(row.last_poll_at) }),
    ...(row.last_successful_poll_at === null
      ? {}
      : { lastSuccessfulPollAt: new Date(row.last_successful_poll_at) }),
    ...(row.last_poll_error_code === null ? {} : { lastPollErrorCode: row.last_poll_error_code }),
    ...(row.last_poll_error_message === null
      ? {}
      : { lastPollErrorMessage: row.last_poll_error_message }),
    ...(row.next_poll_at === null ? {} : { nextPollAt: new Date(row.next_poll_at) }),
  };
}

interface RawScheduleRow {
  readonly created_at: number;
  readonly definition_json: string;
  readonly id: string;
  readonly last_occurrence_at: number | null;
  readonly next_occurrence_at: number | null;
  readonly revision: number;
  readonly status: Schedule['status'];
  readonly target_json: string;
  readonly time_zone: string;
  readonly updated_at: number;
}
interface RawScheduleOccurrenceRow {
  readonly created_at: number;
  readonly dispatch_status: ScheduleOccurrence['dispatchStatus'];
  readonly error_message: string | null;
  readonly id: string;
  readonly schedule_id: string;
  readonly schedule_revision: number;
  readonly scheduled_for_utc: number;
  readonly target_json: string;
  readonly updated_at: number;
}
function scheduleFromRow(row: RawScheduleRow): Schedule {
  const definition = JSON.parse(row.definition_json) as Schedule['definition'];
  return {
    id: row.id,
    status: row.status,
    revision: row.revision,
    target: JSON.parse(row.target_json) as Schedule['target'],
    definition:
      definition.kind === 'once'
        ? { ...definition, resolvedAt: new Date(definition.resolvedAt) }
        : definition,
    timeZone: row.time_zone,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    ...(row.next_occurrence_at === null
      ? {}
      : { nextOccurrenceAt: new Date(row.next_occurrence_at) }),
    ...(row.last_occurrence_at === null
      ? {}
      : { lastOccurrenceAt: new Date(row.last_occurrence_at) }),
  };
}
function scheduleOccurrenceFromRow(row: RawScheduleOccurrenceRow): ScheduleOccurrence {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    scheduleRevision: row.schedule_revision,
    scheduledFor: new Date(row.scheduled_for_utc),
    target: JSON.parse(row.target_json) as ScheduleOccurrence['target'],
    dispatchStatus: row.dispatch_status,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
  };
}

/** SQLite persistence for durable scheduler checkpoints and immutable occurrence history. */
export class SqliteScheduleRepository implements ScheduleRepository {
  public constructor(private readonly database: OpenRepurposeDatabase) {}
  public create(schedule: Schedule): Schedule {
    this.database.client
      .prepare(
        `INSERT INTO schedules (id,status,revision,target_json,definition_json,time_zone,next_occurrence_at,last_occurrence_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        schedule.id,
        schedule.status,
        schedule.revision,
        JSON.stringify(schedule.target),
        JSON.stringify(schedule.definition),
        schedule.timeZone,
        schedule.nextOccurrenceAt?.getTime() ?? null,
        schedule.lastOccurrenceAt?.getTime() ?? null,
        schedule.createdAt.getTime(),
        schedule.updatedAt.getTime(),
      );
    return this.find(schedule.id)!;
  }
  public find(id: string): Schedule | undefined {
    const row = this.database.client.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as
      RawScheduleRow | undefined;
    return row === undefined ? undefined : scheduleFromRow(row);
  }
  public list(): readonly Schedule[] {
    return (
      this.database.client
        .prepare('SELECT * FROM schedules ORDER BY created_at ASC, id ASC')
        .all() as unknown as RawScheduleRow[]
    ).map(scheduleFromRow);
  }
  public listDue(now: Date, limit: number): readonly Schedule[] {
    return (
      this.database.client
        .prepare(
          `SELECT * FROM schedules WHERE status = 'active' AND next_occurrence_at <= ? ORDER BY next_occurrence_at ASC, id ASC LIMIT ?`,
        )
        .all(now.getTime(), limit) as unknown as RawScheduleRow[]
    ).map(scheduleFromRow);
  }
  public listPendingDispatch(limit: number): readonly ScheduleOccurrence[] {
    return (
      this.database.client
        .prepare(
          `SELECT * FROM schedule_occurrences WHERE dispatch_status IN ('pending_dispatch', 'failed') ORDER BY created_at ASC, id ASC LIMIT ?`,
        )
        .all(limit) as unknown as RawScheduleOccurrenceRow[]
    ).map(scheduleOccurrenceFromRow);
  }
  public materialize(input: {
    readonly nextOccurrenceAt?: Date;
    readonly now: Date;
    readonly occurrence: ScheduleOccurrence;
    readonly scheduleId: string;
    readonly status: Schedule['status'];
  }): boolean {
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      const result = client
        .prepare(
          `UPDATE schedules SET status = ?, next_occurrence_at = ?, last_occurrence_at = ?, updated_at = ? WHERE id = ? AND status = 'active' AND next_occurrence_at = ?`,
        )
        .run(
          input.status,
          input.nextOccurrenceAt?.getTime() ?? null,
          input.occurrence.scheduledFor.getTime(),
          input.now.getTime(),
          input.scheduleId,
          input.occurrence.scheduledFor.getTime(),
        );
      if (result.changes === 0) {
        client.exec('COMMIT;');
        return false;
      }
      client
        .prepare(
          `INSERT INTO schedule_occurrences (id,schedule_id,schedule_revision,scheduled_for_utc,target_json,dispatch_status,error_message,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,?,?)`,
        )
        .run(
          input.occurrence.id,
          input.occurrence.scheduleId,
          input.occurrence.scheduleRevision,
          input.occurrence.scheduledFor.getTime(),
          JSON.stringify(input.occurrence.target),
          input.occurrence.dispatchStatus,
          input.now.getTime(),
          input.now.getTime(),
        );
      client.exec('COMMIT;');
      return true;
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }
  public markDispatched(id: string, now: Date): void {
    this.database.client
      .prepare(
        `UPDATE schedule_occurrences SET dispatch_status = 'dispatched', error_message = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(now.getTime(), id);
  }
  public markDispatchFailed(id: string, message: string, now: Date): void {
    this.database.client
      .prepare(
        `UPDATE schedule_occurrences SET dispatch_status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`,
      )
      .run(message, now.getTime(), id);
  }
}

function remoteSourceItemFromRow(row: RawRemoteSourceItemRow): RemoteSourceItem {
  return {
    id: row.id,
    sourceConnectionId: row.source_connection_id,
    externalId: row.external_id,
    dedupeKey: row.dedupe_key,
    metadata: JSON.parse(row.metadata_json) as Record<string, SourceJsonValue>,
    ...(row.media_descriptor_json === null
      ? {}
      : { media: JSON.parse(row.media_descriptor_json) as SourceMediaDescriptor }),
    firstObservedAt: new Date(row.first_observed_at),
    lastObservedAt: new Date(row.last_observed_at),
    updatedAt: new Date(row.updated_at),
    ...(row.event_id === null ? {} : { eventId: row.event_id }),
    ...(row.published_at === null ? {} : { publishedAt: new Date(row.published_at) }),
  };
}

/** Durable poll state and item dedupe. Workflow work is enqueued by the application runner. */
export class SqliteSourcePollingRepository implements SourcePollingRepository {
  public constructor(private readonly database: OpenRepurposeDatabase) {}

  public createConnection(input: {
    readonly adapterId: string;
    readonly configuration: Readonly<Record<string, SourceJsonValue>>;
    readonly displayName: string;
    readonly externalSourceId: string;
    readonly now: Date;
  }): SourceConnection {
    const id = randomUUID();
    this.database.client
      .prepare(
        `INSERT INTO source_connections (
          id, adapter_id, external_source_id, display_name, configuration_json, status, cursor_json,
          consecutive_poll_failures, next_poll_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', NULL, 0, ?, ?, ?)`,
      )
      .run(
        id,
        input.adapterId,
        input.externalSourceId,
        input.displayName,
        JSON.stringify(input.configuration),
        input.now.getTime(),
        input.now.getTime(),
        input.now.getTime(),
      );
    return this.connection(id)!;
  }

  public findConnection(id: string): SourceConnection | undefined {
    return this.connection(id);
  }

  public listConnections(): readonly SourceConnection[] {
    return (
      this.database.client
        .prepare('SELECT * FROM source_connections ORDER BY created_at DESC, id ASC')
        .all() as unknown as RawSourceConnectionRow[]
    ).map(sourceConnectionFromRow);
  }

  public listDue(now: Date): readonly SourceConnection[] {
    return (
      this.database.client
        .prepare(
          `SELECT * FROM source_connections
           WHERE status = 'active' AND (
             (cadence_owner = 'interval' AND (next_poll_at IS NULL OR next_poll_at <= ?)) OR
             (cadence_owner = 'schedule' AND scheduled_poll_pending = 1 AND next_poll_at <= ?)
           )
           ORDER BY COALESCE(next_poll_at, created_at) ASC, id ASC`,
        )
        .all(now.getTime(), now.getTime()) as unknown as RawSourceConnectionRow[]
    ).map(sourceConnectionFromRow);
  }

  public listItems(connectionId: string, limit = 25) {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const rows = this.database.client
      .prepare(
        `SELECT source_items.*, (
          SELECT cleanup_status FROM source_workflow_executions
          WHERE source_item_id = source_items.id
          ORDER BY created_at DESC LIMIT 1
        ) AS cleanup_status
        FROM source_items WHERE source_connection_id = ?
        ORDER BY last_observed_at DESC, id DESC LIMIT ?`,
      )
      .all(connectionId, safeLimit) as unknown as (RawRemoteSourceItemRow & {
      readonly cleanup_status:
        | 'not_eligible'
        | 'eligible'
        | 'scheduled'
        | 'running'
        | 'completed'
        | 'failed'
        | 'retained'
        | null;
    })[];
    return rows.map((row) => ({
      ...remoteSourceItemFromRow(row),
      lifecycleStatus: row.lifecycle_status,
      resolutionStatus: row.resolution_status,
      ...(row.cleanup_status === null ? {} : { cleanupStatus: row.cleanup_status }),
    }));
  }

  public requestPoll(connectionId: string, now: Date): SourceConnection | undefined {
    this.database.client
      .prepare(
        `UPDATE source_connections SET next_poll_at = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(now.getTime(), now.getTime(), connectionId);
    return this.connection(connectionId);
  }

  public enableScheduleCadence(connectionId: string, now: Date): boolean {
    return (
      this.database.client
        .prepare(
          `UPDATE source_connections SET cadence_owner = 'schedule', next_poll_at = NULL,
       scheduled_poll_pending = 0, updated_at = ? WHERE id = ? AND status = 'active'`,
        )
        .run(now.getTime(), connectionId).changes > 0
    );
  }

  public requestScheduledPoll(connectionId: string, now: Date): boolean {
    return (
      this.database.client
        .prepare(
          `UPDATE source_connections SET next_poll_at = ?, scheduled_poll_pending = 1, updated_at = ?
       WHERE id = ? AND status = 'active' AND cadence_owner = 'schedule'
       AND (next_poll_at IS NULL OR next_poll_at <= ?)`,
        )
        .run(now.getTime(), now.getTime(), connectionId, now.getTime()).changes > 0
    );
  }

  public recordPollFailure(input: {
    readonly connectionId: string;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly nextPollAt?: Date;
    readonly now: Date;
    readonly pauseForAuthorization: boolean;
  }): SourceConnection | undefined {
    const status = input.pauseForAuthorization ? 'authorization_failed' : 'active';
    this.database.client
      .prepare(
        `UPDATE source_connections SET status = ?, last_poll_at = ?, last_poll_error_code = ?,
         last_poll_error_message = ?, consecutive_poll_failures = consecutive_poll_failures + 1,
         next_poll_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        status,
        input.now.getTime(),
        input.errorCode,
        input.errorMessage,
        input.nextPollAt?.getTime() ?? null,
        input.now.getTime(),
        input.connectionId,
      );
    return this.connection(input.connectionId);
  }

  public recordPollSuccess(input: {
    readonly connectionId: string;
    readonly cursor: string | null;
    readonly nextPollAt?: Date;
    readonly now: Date;
  }): SourceConnection | undefined {
    this.database.client
      .prepare(
        `UPDATE source_connections SET cursor_json = ?, last_poll_at = ?, last_successful_poll_at = ?,
         last_poll_error_code = NULL, last_poll_error_message = NULL, consecutive_poll_failures = 0,
         next_poll_at = ?, scheduled_poll_pending = 0, updated_at = ? WHERE id = ? AND status = 'active'`,
      )
      .run(
        input.cursor,
        input.now.getTime(),
        input.now.getTime(),
        input.nextPollAt?.getTime() ?? null,
        input.now.getTime(),
        input.connectionId,
      );
    return this.connection(input.connectionId);
  }

  public upsertObservedItem(input: {
    readonly connectionId: string;
    readonly item: SourceItemObservation;
    readonly now: Date;
  }): { readonly created: boolean; readonly item: RemoteSourceItem } {
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      const existing = client
        .prepare('SELECT * FROM source_items WHERE source_connection_id = ? AND external_id = ?')
        .get(input.connectionId, input.item.externalId) as RawRemoteSourceItemRow | undefined;
      if (existing === undefined) {
        const id = randomUUID();
        client
          .prepare(
            `INSERT INTO source_items (
              id, source_connection_id, external_id, dedupe_key, event_id, published_at,
              first_observed_at, last_observed_at, metadata_json, media_descriptor_json, lifecycle_status,
              resolution_status, linked_media_id, completed_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'observed', 'unresolved', NULL, NULL, ?)`,
          )
          .run(
            id,
            input.connectionId,
            input.item.externalId,
            input.item.externalId,
            input.item.eventId ?? null,
            input.item.publishedAt === undefined ? null : Date.parse(input.item.publishedAt),
            input.now.getTime(),
            input.now.getTime(),
            JSON.stringify(input.item.metadata),
            input.item.media === undefined ? null : JSON.stringify(input.item.media),
            input.now.getTime(),
          );
        const row = client
          .prepare('SELECT * FROM source_items WHERE id = ?')
          .get(id) as unknown as RawRemoteSourceItemRow;
        client.exec('COMMIT;');
        return { created: true, item: remoteSourceItemFromRow(row) };
      }
      client
        .prepare(
          `UPDATE source_items SET event_id = ?, published_at = ?, metadata_json = ?, media_descriptor_json = ?,
           last_observed_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          input.item.eventId ?? null,
          input.item.publishedAt === undefined ? null : Date.parse(input.item.publishedAt),
          JSON.stringify(input.item.metadata),
          input.item.media === undefined ? null : JSON.stringify(input.item.media),
          input.now.getTime(),
          input.now.getTime(),
          existing.id,
        );
      const row = client
        .prepare('SELECT * FROM source_items WHERE id = ?')
        .get(existing.id) as unknown as RawRemoteSourceItemRow;
      client.exec('COMMIT;');
      return { created: false, item: remoteSourceItemFromRow(row) };
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }

  public setConnectionStatus(
    connectionId: string,
    status: 'active' | 'paused',
    now: Date,
  ): SourceConnection | undefined {
    this.database.client
      .prepare(
        `UPDATE source_connections SET status = ?, next_poll_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(status, status === 'active' ? now.getTime() : null, now.getTime(), connectionId);
    return this.connection(connectionId);
  }

  private connection(id: string): SourceConnection | undefined {
    const row = this.database.client
      .prepare('SELECT * FROM source_connections WHERE id = ?')
      .get(id) as RawSourceConnectionRow | undefined;
    return row === undefined ? undefined : sourceConnectionFromRow(row);
  }
}

interface RawSourceMediaResolutionRow {
  readonly completed_at: number | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly execution_id: string;
  readonly job_scope_id: string;
  readonly managed_path: string | null;
  readonly media_id: string | null;
  readonly resolver_id: string | null;
  readonly source_item_id: string;
  readonly started_at: number;
  readonly status: SourceMediaResolution['status'];
  readonly updated_at: number;
}

interface RawSourceMediaArtifactRow {
  readonly cleanup_state: SourceMediaArtifact['cleanupState'];
  readonly deleted_at: number | null;
  readonly execution_id: string | null;
  readonly id: string;
  readonly media_id: string | null;
  readonly ownership: SourceMediaOwnership;
  readonly path: string;
  readonly source_item_id: string;
  readonly state: SourceMediaArtifact['state'];
  readonly updated_at: number;
}

function sourceMediaResolutionFromRow(row: RawSourceMediaResolutionRow): SourceMediaResolution {
  return {
    sourceItemId: row.source_item_id,
    executionId: row.execution_id,
    jobScopeId: row.job_scope_id,
    status: row.status,
    startedAt: new Date(row.started_at),
    updatedAt: new Date(row.updated_at),
    ...(row.resolver_id === null ? {} : { resolverId: row.resolver_id }),
    ...(row.managed_path === null ? {} : { managedPath: row.managed_path }),
    ...(row.media_id === null ? {} : { mediaId: row.media_id }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    ...(row.completed_at === null ? {} : { completedAt: new Date(row.completed_at) }),
  };
}

function sourceMediaArtifactFromRow(row: RawSourceMediaArtifactRow): SourceMediaArtifact {
  return {
    id: row.id,
    sourceItemId: row.source_item_id,
    path: row.path,
    ownership: row.ownership,
    state: row.state,
    cleanupState: row.cleanup_state,
    updatedAt: new Date(row.updated_at),
    ...(row.execution_id === null ? {} : { executionId: row.execution_id }),
    ...(row.media_id === null ? {} : { mediaId: row.media_id }),
    ...(row.deleted_at === null ? {} : { deletedAt: new Date(row.deleted_at) }),
  };
}

/** Durable resolution and artifact lifecycle state shared by restart recovery and cleanup. */
export class SqliteSourceMediaResolutionRepository implements SourceMediaResolutionRepository {
  public constructor(private readonly database: OpenRepurposeDatabase) {}

  public begin(input: {
    readonly executionId: string;
    readonly jobScopeId: string;
    readonly managedPath?: string;
    readonly now: Date;
    readonly resolverId?: string;
    readonly sourceItemId: string;
  }): SourceMediaResolution {
    this.database.client
      .prepare(
        `INSERT INTO source_media_resolutions (
          source_item_id, execution_id, job_scope_id, status, resolver_id, managed_path,
          started_at, updated_at
        ) VALUES (?, ?, ?, 'resolving', ?, ?, ?, ?)
        ON CONFLICT(source_item_id, execution_id) DO UPDATE SET
          job_scope_id = excluded.job_scope_id, status = 'resolving',
          resolver_id = excluded.resolver_id,
          managed_path = COALESCE(excluded.managed_path, source_media_resolutions.managed_path),
          media_id = NULL, error_code = NULL, error_message = NULL,
          updated_at = excluded.updated_at, completed_at = NULL`,
      )
      .run(
        input.sourceItemId,
        input.executionId,
        input.jobScopeId,
        input.resolverId ?? null,
        input.managedPath ?? null,
        input.now.getTime(),
        input.now.getTime(),
      );
    this.database.client
      .prepare(
        `UPDATE source_items SET lifecycle_status = 'resolving', resolution_status = 'resolving',
         updated_at = ? WHERE id = ?`,
      )
      .run(input.now.getTime(), input.sourceItemId);
    return this.require(input.sourceItemId, input.executionId);
  }

  public find(sourceItemId: string, executionId: string): SourceMediaResolution | undefined {
    const row = this.database.client
      .prepare(
        'SELECT * FROM source_media_resolutions WHERE source_item_id = ? AND execution_id = ?',
      )
      .get(sourceItemId, executionId) as RawSourceMediaResolutionRow | undefined;
    return row === undefined ? undefined : sourceMediaResolutionFromRow(row);
  }

  public findArtifact(id: string): SourceMediaArtifact | undefined {
    const row = this.database.client
      .prepare('SELECT * FROM source_media_artifacts WHERE id = ?')
      .get(id) as RawSourceMediaArtifactRow | undefined;
    return row === undefined ? undefined : sourceMediaArtifactFromRow(row);
  }

  public findArtifactForResolution(
    sourceItemId: string,
    executionId: string,
  ): SourceMediaArtifact | undefined {
    const row = this.database.client
      .prepare(
        `SELECT * FROM source_media_artifacts
         WHERE source_item_id = ? AND execution_id = ? ORDER BY created_at ASC LIMIT 1`,
      )
      .get(sourceItemId, executionId) as RawSourceMediaArtifactRow | undefined;
    return row === undefined ? undefined : sourceMediaArtifactFromRow(row);
  }

  public markReady(input: {
    readonly executionId: string;
    readonly media: MediaAsset;
    readonly now: Date;
    readonly ownership: SourceMediaOwnership;
    readonly sourceItemId: string;
  }): { readonly artifact: SourceMediaArtifact; readonly resolution: SourceMediaResolution } {
    const artifactId = `${input.sourceItemId}:${input.executionId}`;
    const cleanupState = input.ownership === 'user_owned_original' ? 'protected' : 'not_eligible';
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      client
        .prepare(
          `UPDATE source_media_resolutions SET status = 'ready', media_id = ?, error_code = NULL,
           error_message = NULL, updated_at = ?, completed_at = ?
           WHERE source_item_id = ? AND execution_id = ?`,
        )
        .run(
          input.media.id,
          input.now.getTime(),
          input.now.getTime(),
          input.sourceItemId,
          input.executionId,
        );
      client
        .prepare(
          `UPDATE source_items SET lifecycle_status = 'media_ready', resolution_status = 'ready',
           linked_media_id = ?, updated_at = ? WHERE id = ?`,
        )
        .run(input.media.id, input.now.getTime(), input.sourceItemId);
      client
        .prepare(
          `INSERT INTO source_media_artifacts (
            id, source_item_id, execution_id, media_id, path, ownership, state, cleanup_state,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET media_id = excluded.media_id, state = 'available',
            updated_at = excluded.updated_at, deleted_at = NULL`,
        )
        .run(
          artifactId,
          input.sourceItemId,
          input.executionId,
          input.media.id,
          input.media.path,
          input.ownership,
          cleanupState,
          input.now.getTime(),
          input.now.getTime(),
        );
      client.exec('COMMIT;');
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
    return {
      resolution: this.require(input.sourceItemId, input.executionId),
      artifact: this.requireArtifact(artifactId),
    };
  }

  public markFailed(input: {
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly executionId: string;
    readonly now: Date;
    readonly sourceItemId: string;
    readonly status: 'failed' | 'cancelled';
  }): SourceMediaResolution {
    this.database.client
      .prepare(
        `UPDATE source_media_resolutions SET status = ?, media_id = NULL, error_code = ?,
         error_message = ?, updated_at = ?, completed_at = ?
         WHERE source_item_id = ? AND execution_id = ?`,
      )
      .run(
        input.status,
        input.errorCode,
        input.errorMessage,
        input.now.getTime(),
        input.now.getTime(),
        input.sourceItemId,
        input.executionId,
      );
    this.database.client
      .prepare(
        `UPDATE source_items SET lifecycle_status = 'failed', resolution_status = 'failed',
         updated_at = ? WHERE id = ?`,
      )
      .run(input.now.getTime(), input.sourceItemId);
    return this.require(input.sourceItemId, input.executionId);
  }

  public markCleanupRunning(id: string, now: Date): SourceMediaArtifact | undefined {
    return this.updateCleanup(id, "cleanup_state = 'running', updated_at = ?", [now.getTime()]);
  }

  public markCleanupCompleted(id: string, now: Date): SourceMediaArtifact | undefined {
    return this.updateCleanup(
      id,
      "cleanup_state = 'completed', state = 'deleted', deleted_at = ?, updated_at = ?",
      [now.getTime(), now.getTime()],
    );
  }

  public markCleanupFailed(
    id: string,
    errorCode: string,
    errorMessage: string,
    now: Date,
  ): SourceMediaArtifact | undefined {
    const artifact = this.findArtifact(id);
    if (artifact?.executionId !== undefined)
      this.database.client
        .prepare(
          `UPDATE source_workflow_executions SET cleanup_status = 'failed',
           cleanup_error_code = ?, cleanup_error_message = ?, updated_at = ? WHERE id = ?`,
        )
        .run(errorCode, errorMessage, now.getTime(), artifact.executionId);
    return this.updateCleanup(id, "cleanup_state = 'failed', updated_at = ?", [now.getTime()]);
  }

  private updateCleanup(
    id: string,
    assignment: string,
    values: readonly (number | string)[],
  ): SourceMediaArtifact | undefined {
    this.database.client
      .prepare(`UPDATE source_media_artifacts SET ${assignment} WHERE id = ?`)
      .run(...values, id);
    return this.findArtifact(id);
  }

  private require(sourceItemId: string, executionId: string): SourceMediaResolution {
    const resolution = this.find(sourceItemId, executionId);
    if (resolution === undefined) throw new Error('Source media resolution checkpoint is missing.');
    return resolution;
  }

  private requireArtifact(id: string): SourceMediaArtifact {
    const artifact = this.findArtifact(id);
    if (artifact === undefined) throw new Error('Source media artifact checkpoint is missing.');
    return artifact;
  }
}

interface RawSourceWorkflowExecutionRow {
  readonly cleanup_eligible_at: number | null;
  readonly cleanup_status: SourceWorkflowExecution['cleanupStatus'];
  readonly completed_at: number | null;
  readonly id: string;
  readonly retention_duration_seconds: number | null;
  readonly retention_policy: SourceRetentionPolicy['kind'];
  readonly snapshot_json: string;
  readonly source_item_id: string;
  readonly status: SourceWorkflowExecution['status'];
  readonly workflow_key: string;
  readonly workflow_version: string;
}

interface RawSourceExecutionDestinationRow {
  readonly destination_id: SourceExecutionDestination['destinationId'];
  readonly destination_key: string;
  readonly execution_id: string;
  readonly id: string;
  readonly idempotency_key: string;
  readonly job_id: string | null;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
  readonly remote_id: string | null;
  readonly remote_url: string | null;
  readonly required: number;
  readonly status: SourceExecutionDestination['status'];
}

function sourceWorkflowExecutionFromRow(
  row: RawSourceWorkflowExecutionRow,
): SourceWorkflowExecution {
  const retentionPolicy: SourceRetentionPolicy =
    row.retention_policy === 'keep_for_duration'
      ? { kind: 'keep_for_duration', durationSeconds: row.retention_duration_seconds! }
      : { kind: row.retention_policy };
  return {
    id: row.id,
    sourceItemId: row.source_item_id,
    workflowKey: row.workflow_key,
    workflowVersion: row.workflow_version,
    status: row.status,
    snapshot: JSON.parse(row.snapshot_json) as SourceWorkflowExecutionSnapshot,
    retentionPolicy,
    cleanupStatus: row.cleanup_status,
    ...(row.cleanup_eligible_at === null
      ? {}
      : { cleanupEligibleAt: new Date(row.cleanup_eligible_at) }),
    ...(row.completed_at === null ? {} : { completedAt: new Date(row.completed_at) }),
  };
}

function sourceExecutionDestinationFromRow(
  row: RawSourceExecutionDestinationRow,
): SourceExecutionDestination {
  return {
    id: row.id,
    executionId: row.execution_id,
    destinationKey: row.destination_key,
    destinationId: row.destination_id,
    required: row.required === 1,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    ...(row.job_id === null ? {} : { jobId: row.job_id }),
    ...(row.remote_id === null ? {} : { remoteId: row.remote_id }),
    ...(row.remote_url === null ? {} : { remoteUrl: row.remote_url }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    ...(row.last_error_message === null ? {} : { lastErrorMessage: row.last_error_message }),
  };
}

/** Durable source execution orchestration over the existing job and destination checkpoints. */
export class SqliteSourceWorkflowExecutionRepository implements SourceWorkflowExecutionRepository {
  public constructor(private readonly database: OpenRepurposeDatabase) {}

  public create(input: {
    readonly destinations: readonly {
      readonly destinationId: WorkflowDestination['destinationId'];
      readonly destinationKey: string;
      readonly id: string;
      readonly idempotencyKey: string;
      readonly required: boolean;
    }[];
    readonly executionId: string;
    readonly now: Date;
    readonly retentionPolicy: SourceRetentionPolicy;
    readonly snapshot: SourceWorkflowExecutionSnapshot;
    readonly sourceItemId: string;
    readonly workflowId: string;
    readonly workflowKey: string;
    readonly workflowVersion: string;
  }): { readonly created: boolean; readonly execution: SourceWorkflowExecution } {
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      const existing = client
        .prepare(
          `SELECT * FROM source_workflow_executions
           WHERE source_item_id = ? AND workflow_key = ? AND workflow_version = ?`,
        )
        .get(input.sourceItemId, input.workflowKey, input.workflowVersion) as
        RawSourceWorkflowExecutionRow | undefined;
      if (existing !== undefined) {
        client.exec('COMMIT;');
        return { created: false, execution: sourceWorkflowExecutionFromRow(existing) };
      }
      const duration =
        input.retentionPolicy.kind === 'keep_for_duration'
          ? input.retentionPolicy.durationSeconds
          : null;
      client
        .prepare(
          `INSERT INTO source_workflow_executions (
            id, source_item_id, workflow_id, workflow_key, workflow_version, status, snapshot_json,
            retention_policy, retention_duration_seconds, cleanup_status, cleanup_eligible_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, 'not_eligible', NULL, ?, ?)`,
        )
        .run(
          input.executionId,
          input.sourceItemId,
          input.workflowId,
          input.workflowKey,
          input.workflowVersion,
          JSON.stringify(input.snapshot),
          input.retentionPolicy.kind,
          duration,
          input.now.getTime(),
          input.now.getTime(),
        );
      const insertDestination = client.prepare(
        `INSERT INTO source_execution_destinations (
          id, execution_id, destination_key, destination_id, required, job_id, idempotency_key,
          status, attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'pending', 0, ?, ?)`,
      );
      for (const destination of input.destinations)
        insertDestination.run(
          destination.id,
          input.executionId,
          destination.destinationKey,
          destination.destinationId,
          destination.required ? 1 : 0,
          destination.idempotencyKey,
          input.now.getTime(),
          input.now.getTime(),
        );
      client
        .prepare(
          `UPDATE source_items SET lifecycle_status = 'queued', updated_at = ?
           WHERE id = ? AND lifecycle_status = 'observed'`,
        )
        .run(input.now.getTime(), input.sourceItemId);
      const row = client
        .prepare('SELECT * FROM source_workflow_executions WHERE id = ?')
        .get(input.executionId) as unknown as RawSourceWorkflowExecutionRow;
      client.exec('COMMIT;');
      return { created: true, execution: sourceWorkflowExecutionFromRow(row) };
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }

  public find(id: string): SourceWorkflowExecution | undefined {
    const row = this.database.client
      .prepare('SELECT * FROM source_workflow_executions WHERE id = ?')
      .get(id) as RawSourceWorkflowExecutionRow | undefined;
    return row === undefined ? undefined : sourceWorkflowExecutionFromRow(row);
  }

  public findSourceItem(id: string): RemoteSourceItem | undefined {
    const row = this.database.client.prepare('SELECT * FROM source_items WHERE id = ?').get(id) as
      RawRemoteSourceItemRow | undefined;
    return row === undefined ? undefined : remoteSourceItemFromRow(row);
  }

  public listDestinations(executionId: string): readonly SourceExecutionDestination[] {
    return (
      this.database.client
        .prepare(
          'SELECT * FROM source_execution_destinations WHERE execution_id = ? ORDER BY created_at, id',
        )
        .all(executionId) as unknown as RawSourceExecutionDestinationRow[]
    ).map(sourceExecutionDestinationFromRow);
  }

  public attachDestinationJob(
    destinationId: string,
    job: Job,
    now: Date,
  ): SourceExecutionDestination {
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      client
        .prepare(
          `UPDATE source_execution_destinations SET job_id = ?, status = ?,
           attempt_count = ?, last_error_code = ?, last_error_message = ?,
           completed_at = CASE WHEN ? = 'succeeded' THEN ? ELSE NULL END, updated_at = ?
           WHERE id = ? AND status <> 'succeeded'`,
        )
        .run(
          job.id,
          job.status,
          job.attemptCount,
          job.lastErrorCode ?? null,
          job.lastErrorMessage ?? null,
          job.status,
          job.completedAt?.getTime() ?? null,
          now.getTime(),
          destinationId,
        );
      client
        .prepare(
          `UPDATE source_workflow_executions SET status = 'running', updated_at = ?
           WHERE id = (SELECT execution_id FROM source_execution_destinations WHERE id = ?)
             AND status <> 'succeeded'`,
        )
        .run(now.getTime(), destinationId);
      client
        .prepare(
          `UPDATE source_items SET lifecycle_status = 'publishing', updated_at = ?
           WHERE id = (
             SELECT source_item_id FROM source_workflow_executions WHERE id = (
               SELECT execution_id FROM source_execution_destinations WHERE id = ?
             )
           ) AND lifecycle_status NOT IN ('cleanup_pending', 'completed')`,
        )
        .run(now.getTime(), destinationId);
      const row = client
        .prepare('SELECT * FROM source_execution_destinations WHERE id = ?')
        .get(destinationId) as unknown as RawSourceExecutionDestinationRow;
      client.exec('COMMIT;');
      return sourceExecutionDestinationFromRow(row);
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }

  public listNeedingRun(): readonly SourceWorkflowExecution[] {
    return this.listBy(
      `SELECT * FROM source_workflow_executions WHERE status = 'pending' ORDER BY created_at, id`,
    );
  }

  public listDueCleanup(now: Date): readonly SourceWorkflowExecution[] {
    return this.listBy(
      `SELECT * FROM source_workflow_executions
       WHERE cleanup_status IN ('eligible', 'failed') AND cleanup_eligible_at <= ?
       ORDER BY cleanup_eligible_at, id`,
      now.getTime(),
    );
  }

  public listArtifacts(executionId: string): readonly SourceMediaArtifact[] {
    return (
      this.database.client
        .prepare('SELECT * FROM source_media_artifacts WHERE execution_id = ? ORDER BY id')
        .all(executionId) as unknown as RawSourceMediaArtifactRow[]
    ).map(sourceMediaArtifactFromRow);
  }

  public markCleanupRunning(executionId: string, now: Date): SourceWorkflowExecution {
    this.database.client
      .prepare(
        `UPDATE source_workflow_executions SET cleanup_status = 'running', updated_at = ?
         WHERE id = ? AND cleanup_status IN ('eligible', 'scheduled', 'failed', 'running')`,
      )
      .run(now.getTime(), executionId);
    return this.require(executionId);
  }

  public markCleanupCompleted(executionId: string, now: Date): SourceWorkflowExecution {
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      client
        .prepare(
          `UPDATE source_workflow_executions SET cleanup_status = 'completed',
           cleanup_error_code = NULL, cleanup_error_message = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(now.getTime(), executionId);
      client
        .prepare(
          `UPDATE source_items SET lifecycle_status = 'completed', completed_at = ?, updated_at = ?
           WHERE id = (SELECT source_item_id FROM source_workflow_executions WHERE id = ?)
             AND NOT EXISTS (
               SELECT 1 FROM source_workflow_executions
               WHERE source_item_id = source_items.id
                 AND cleanup_status NOT IN ('completed', 'retained')
             )`,
        )
        .run(now.getTime(), now.getTime(), executionId);
      client.exec('COMMIT;');
      return this.require(executionId);
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }

  public markCleanupFailed(
    executionId: string,
    errorCode: string,
    errorMessage: string,
    now: Date,
  ): SourceWorkflowExecution {
    this.database.client
      .prepare(
        `UPDATE source_workflow_executions SET cleanup_status = 'failed', cleanup_error_code = ?,
         cleanup_error_message = ?, updated_at = ? WHERE id = ?`,
      )
      .run(errorCode, errorMessage, now.getTime(), executionId);
    return this.require(executionId);
  }

  public markRunFailed(
    executionId: string,
    retryable: boolean,
    now: Date,
  ): SourceWorkflowExecution {
    this.database.client
      .prepare('UPDATE source_workflow_executions SET status = ?, updated_at = ? WHERE id = ?')
      .run(retryable ? 'retrying' : 'failed', now.getTime(), executionId);
    return this.require(executionId);
  }

  public retryFailedDestinations(executionId: string, now: Date): number {
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      const rows = client
        .prepare(
          `SELECT job_id FROM source_execution_destinations
           WHERE execution_id = ? AND status = 'failed' AND job_id IS NOT NULL`,
        )
        .all(executionId) as unknown as { job_id: string }[];
      for (const row of rows)
        client
          .prepare(
            `UPDATE jobs SET status = 'pending', available_at = ?,
             max_attempts = max(max_attempts, attempt_count + 3), completed_at = NULL,
             last_error_code = NULL, last_error_message = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(now.getTime(), now.getTime(), row.job_id);
      if (rows.length > 0)
        client
          .prepare(
            `UPDATE source_workflow_executions SET status = 'retrying', updated_at = ? WHERE id = ?`,
          )
          .run(now.getTime(), executionId);
      client.exec('COMMIT;');
      return rows.length;
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }

  private listBy(sql: string, ...values: readonly number[]): readonly SourceWorkflowExecution[] {
    return (
      this.database.client.prepare(sql).all(...values) as unknown as RawSourceWorkflowExecutionRow[]
    ).map(sourceWorkflowExecutionFromRow);
  }

  private require(id: string): SourceWorkflowExecution {
    const execution = this.find(id);
    if (execution === undefined) throw new Error('Source workflow execution not found.');
    return execution;
  }
}

interface RawAccountRow {
  readonly capabilities_json: string;
  readonly connected_at: number;
  readonly display_name: string;
  readonly external_id: string;
  readonly id: string;
  readonly provider: AccountProvider;
  readonly status: AccountStatus;
  readonly updated_at: number;
}

function accountFromRow(row: RawAccountRow): ConnectedAccount {
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.external_id,
    displayName: row.display_name,
    status: row.status,
    capabilities: JSON.parse(row.capabilities_json) as AccountCapability[],
    connectedAt: new Date(row.connected_at),
    updatedAt: new Date(row.updated_at),
  };
}

interface RawMetaCredentialRow {
  readonly connected_at: number;
  readonly display_name: string;
  readonly external_id: string;
  readonly id: string;
  readonly scopes_json: string;
  readonly status: MetaCredentialStatus;
  readonly token_expires_at: number;
  readonly updated_at: number;
}

interface RawMetaTargetRow {
  readonly availability: MetaTargetAvailability;
  readonly blocker: string | null;
  readonly credential_id: string;
  readonly display_name: string;
  readonly enabled: number;
  readonly external_id: string;
  readonly id: string;
  readonly kind: MetaTargetKind;
  readonly page_id: string;
  readonly updated_at: number;
  readonly username: string | null;
}

function metaCredentialFromRow(row: RawMetaCredentialRow): MetaCredential {
  return {
    id: row.id,
    externalId: row.external_id,
    displayName: row.display_name,
    status: row.status,
    scopes: JSON.parse(row.scopes_json) as string[],
    tokenExpiresAt: new Date(row.token_expires_at),
    connectedAt: new Date(row.connected_at),
    updatedAt: new Date(row.updated_at),
  };
}

function metaTargetFromRow(row: RawMetaTargetRow): MetaPublishTarget {
  return {
    id: row.id,
    credentialId: row.credential_id,
    kind: row.kind,
    externalId: row.external_id,
    pageId: row.page_id,
    displayName: row.display_name,
    ...(row.username === null ? {} : { username: row.username }),
    enabled: row.enabled === 1,
    availability: row.availability,
    ...(row.blocker === null ? {} : { blocker: row.blocker }),
    updatedAt: new Date(row.updated_at),
  };
}

/** Durable Meta identities and their separately selectable publishing targets. */
export class SqliteMetaCredentialRepository implements MetaCredentialRepository {
  public constructor(private readonly database: OpenRepurposeDatabase) {}
  public findCredential(id: string): MetaCredential | undefined {
    const row = this.database.client
      .prepare('SELECT * FROM meta_credentials WHERE id = ?')
      .get(id) as RawMetaCredentialRow | undefined;
    return row === undefined ? undefined : metaCredentialFromRow(row);
  }
  public listCredentials(): readonly MetaCredential[] {
    return (
      this.database.client
        .prepare('SELECT * FROM meta_credentials ORDER BY connected_at DESC, id DESC')
        .all() as unknown as RawMetaCredentialRow[]
    ).map(metaCredentialFromRow);
  }
  public listTargets(credentialId?: string): readonly MetaPublishTarget[] {
    const statement =
      credentialId === undefined
        ? this.database.client.prepare(
            'SELECT * FROM meta_publish_targets ORDER BY display_name, id',
          )
        : this.database.client.prepare(
            'SELECT * FROM meta_publish_targets WHERE credential_id = ? ORDER BY display_name, id',
          );
    const rows = (credentialId === undefined
      ? statement.all()
      : statement.all(credentialId)) as unknown as RawMetaTargetRow[];
    return rows.map(metaTargetFromRow);
  }
  public markTargetUnavailable(id: string, blocker: string, updatedAt: Date): boolean {
    return (
      Number(
        this.database.client
          .prepare(
            `UPDATE meta_publish_targets
             SET enabled = 0, availability = 'blocked', blocker = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(blocker, updatedAt.getTime(), id).changes,
      ) === 1
    );
  }
  public removeCredential(id: string): MetaCredential | undefined {
    const existing = this.findCredential(id);
    if (existing !== undefined)
      this.database.client.prepare('DELETE FROM meta_credentials WHERE id = ?').run(id);
    return existing;
  }
  public setCredentialStatus(id: string, status: MetaCredentialStatus, updatedAt: Date): boolean {
    return (
      Number(
        this.database.client
          .prepare('UPDATE meta_credentials SET status = ?, updated_at = ? WHERE id = ?')
          .run(status, updatedAt.getTime(), id).changes,
      ) === 1
    );
  }
  public setTargetEnabled(id: string, enabled: boolean, updatedAt: Date): boolean {
    return (
      Number(
        this.database.client
          .prepare('UPDATE meta_publish_targets SET enabled = ?, updated_at = ? WHERE id = ?')
          .run(enabled ? 1 : 0, updatedAt.getTime(), id).changes,
      ) === 1
    );
  }
  public upsertCredential(input: MetaCredential): MetaCredential {
    const existing = this.database.client
      .prepare('SELECT id, connected_at FROM meta_credentials WHERE external_id = ?')
      .get(input.externalId) as { id: string; connected_at: number } | undefined;
    const id = existing?.id ?? input.id;
    const connectedAt =
      existing === undefined ? input.connectedAt : new Date(existing.connected_at);
    this.database.db
      .insert(metaCredentials)
      .values({
        id,
        externalId: input.externalId,
        displayName: input.displayName,
        status: input.status,
        scopesJson: JSON.stringify(input.scopes),
        tokenExpiresAt: input.tokenExpiresAt,
        connectedAt,
        updatedAt: input.updatedAt,
      })
      .onConflictDoUpdate({
        target: metaCredentials.externalId,
        set: {
          displayName: input.displayName,
          status: input.status,
          scopesJson: JSON.stringify(input.scopes),
          tokenExpiresAt: input.tokenExpiresAt,
          updatedAt: input.updatedAt,
        },
      })
      .run();
    return this.findCredential(id)!;
  }
  public upsertTarget(input: MetaPublishTarget): MetaPublishTarget {
    const existing = this.database.client
      .prepare(
        'SELECT id, enabled FROM meta_publish_targets WHERE credential_id = ? AND kind = ? AND external_id = ?',
      )
      .get(input.credentialId, input.kind, input.externalId) as
      { id: string; enabled: number } | undefined;
    const id = existing?.id ?? input.id;
    const enabled =
      input.availability === 'blocked'
        ? false
        : existing === undefined
          ? input.enabled
          : existing.enabled === 1;
    this.database.db
      .insert(metaPublishTargets)
      .values({
        id,
        credentialId: input.credentialId,
        kind: input.kind,
        externalId: input.externalId,
        pageId: input.pageId,
        displayName: input.displayName,
        username: input.username ?? null,
        enabled,
        availability: input.availability,
        blocker: input.blocker ?? null,
        updatedAt: input.updatedAt,
      })
      .onConflictDoUpdate({
        target: [
          metaPublishTargets.credentialId,
          metaPublishTargets.kind,
          metaPublishTargets.externalId,
        ],
        set: {
          pageId: input.pageId,
          displayName: input.displayName,
          username: input.username ?? null,
          availability: input.availability,
          blocker: input.blocker ?? null,
          updatedAt: input.updatedAt,
        },
      })
      .run();
    const row = this.database.client
      .prepare('SELECT * FROM meta_publish_targets WHERE id = ?')
      .get(id) as RawMetaTargetRow | undefined;
    if (row === undefined) throw new Error('Meta target could not be persisted.');
    return metaTargetFromRow(row);
  }
}

/** SQLite account metadata repository. Secret values are deliberately stored elsewhere. */
export class SqliteAccountRepository implements AccountRepository {
  public constructor(private readonly database: OpenRepurposeDatabase) {}

  public findById(id: string): ConnectedAccount | undefined {
    const row = this.database.client.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
      RawAccountRow | undefined;
    return row === undefined ? undefined : accountFromRow(row);
  }

  public list(): readonly ConnectedAccount[] {
    return (
      this.database.client
        .prepare('SELECT * FROM accounts ORDER BY connected_at DESC, id DESC')
        .all() as unknown as RawAccountRow[]
    ).map(accountFromRow);
  }

  public remove(id: string): ConnectedAccount | undefined {
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      const row = client.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
        RawAccountRow | undefined;
      if (row !== undefined) client.prepare('DELETE FROM accounts WHERE id = ?').run(id);
      client.exec('COMMIT;');
      return row === undefined ? undefined : accountFromRow(row);
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }

  public setProviderStatus(
    provider: AccountProvider,
    status: AccountStatus,
    updatedAt: Date,
  ): number {
    const result = this.database.client
      .prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE provider = ?')
      .run(status, updatedAt.getTime(), provider);
    return Number(result.changes);
  }

  public setStatus(id: string, status: AccountStatus, updatedAt: Date): boolean {
    const result = this.database.client
      .prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, updatedAt.getTime(), id);
    return Number(result.changes) === 1;
  }

  public upsert(input: UpsertConnectedAccountInput): ConnectedAccount {
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      const existing = client
        .prepare('SELECT id, connected_at FROM accounts WHERE provider = ? AND external_id = ?')
        .get(input.provider, input.externalId) as { connected_at: number; id: string } | undefined;
      const id = existing?.id ?? input.id;
      const connectedAt =
        existing === undefined ? input.connectedAt : new Date(existing.connected_at);
      if (existing === undefined) {
        client
          .prepare(
            `INSERT INTO accounts (
              id, provider, external_id, display_name, status, capabilities_json,
              connected_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.provider,
            input.externalId,
            input.displayName,
            input.status,
            JSON.stringify(input.capabilities),
            connectedAt.getTime(),
            input.updatedAt.getTime(),
          );
      } else {
        client
          .prepare(
            `UPDATE accounts SET display_name = ?, status = ?, capabilities_json = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            input.displayName,
            input.status,
            JSON.stringify(input.capabilities),
            input.updatedAt.getTime(),
            id,
          );
      }
      const row = client
        .prepare('SELECT * FROM accounts WHERE id = ?')
        .get(id) as unknown as RawAccountRow;
      client.exec('COMMIT;');
      return accountFromRow(row);
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }
}

interface RawOAuthAuthorizationRequestRow {
  readonly binding_hash: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly id: string;
  readonly provider: AccountProvider;
  readonly redirect_uri: string;
  readonly state_hash: string;
}

function oauthRequestFromRow(row: RawOAuthAuthorizationRequestRow): OAuthAuthorizationRequest {
  return {
    id: row.id,
    provider: row.provider,
    stateHash: row.state_hash,
    bindingHash: row.binding_hash,
    redirectUri: row.redirect_uri,
    expiresAt: new Date(row.expires_at),
    createdAt: new Date(row.created_at),
  };
}

/** Atomic one-time OAuth request storage used to validate state across restarts/processes. */
export class SqliteOAuthAuthorizationRequestRepository implements OAuthAuthorizationRequestRepository {
  public constructor(private readonly database: OpenRepurposeDatabase) {}

  public create(request: OAuthAuthorizationRequest): void {
    this.database.client
      .prepare(
        `INSERT INTO oauth_authorization_requests (
          id, provider, state_hash, binding_hash, redirect_uri, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id,
        request.provider,
        request.stateHash,
        request.bindingHash,
        request.redirectUri,
        request.expiresAt.getTime(),
        request.createdAt.getTime(),
      );
  }

  public consumeByStateHash(
    stateHash: string,
    bindingHash: string,
  ): OAuthAuthorizationRequest | undefined {
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      const row = client
        .prepare(
          'SELECT * FROM oauth_authorization_requests WHERE state_hash = ? AND binding_hash = ?',
        )
        .get(stateHash, bindingHash) as RawOAuthAuthorizationRequestRow | undefined;
      if (row !== undefined)
        client.prepare('DELETE FROM oauth_authorization_requests WHERE id = ?').run(row.id);
      client.exec('COMMIT;');
      return row === undefined ? undefined : oauthRequestFromRow(row);
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }

  public deleteExpired(now: Date): readonly OAuthAuthorizationRequest[] {
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      const rows = client
        .prepare('SELECT * FROM oauth_authorization_requests WHERE expires_at <= ?')
        .all(now.getTime()) as unknown as RawOAuthAuthorizationRequestRow[];
      client
        .prepare('DELETE FROM oauth_authorization_requests WHERE expires_at <= ?')
        .run(now.getTime());
      client.exec('COMMIT;');
      return rows.map(oauthRequestFromRow);
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }
}

interface RawDestinationJobRecordRow {
  readonly destination_id: string;
  readonly job_id: string;
  readonly remote_id: string | null;
  readonly remote_status: string;
  readonly remote_url: string | null;
  readonly resumable_session_url: string | null;
  readonly updated_at: number;
  readonly uploaded_bytes: number;
}

function destinationJobRecordFromRow(row: RawDestinationJobRecordRow): DestinationJobRecord {
  return {
    jobId: row.job_id,
    destinationId: row.destination_id,
    remoteStatus: row.remote_status,
    uploadedBytes: row.uploaded_bytes,
    updatedAt: new Date(row.updated_at),
    ...(row.remote_id === null ? {} : { remoteId: row.remote_id }),
    ...(row.remote_url === null ? {} : { remoteUrl: row.remote_url }),
    ...(row.resumable_session_url === null
      ? {}
      : { resumableSessionUrl: row.resumable_session_url }),
  };
}

/** SQLite checkpoint repository for resumable destination work. */
export class SqliteDestinationJobRepository implements DestinationJobRepository {
  public constructor(private readonly database: OpenRepurposeDatabase) {}

  public find(jobId: string): DestinationJobRecord | undefined {
    const row = this.database.client
      .prepare('SELECT * FROM destination_job_records WHERE job_id = ?')
      .get(jobId) as RawDestinationJobRecordRow | undefined;
    return row === undefined ? undefined : destinationJobRecordFromRow(row);
  }

  public save(record: DestinationJobRecord): DestinationJobRecord {
    this.database.client
      .prepare(
        `INSERT INTO destination_job_records (
          job_id, destination_id, remote_id, remote_url, remote_status,
          resumable_session_url, uploaded_bytes, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          destination_id = excluded.destination_id,
          remote_id = excluded.remote_id,
          remote_url = excluded.remote_url,
          remote_status = excluded.remote_status,
          resumable_session_url = excluded.resumable_session_url,
          uploaded_bytes = excluded.uploaded_bytes,
          updated_at = excluded.updated_at`,
      )
      .run(
        record.jobId,
        record.destinationId,
        record.remoteId ?? null,
        record.remoteUrl ?? null,
        record.remoteStatus,
        record.resumableSessionUrl ?? null,
        record.uploadedBytes,
        record.updatedAt.getTime(),
      );
    return record;
  }
}

interface RawJobRow {
  readonly account_id: string | null;
  readonly attempt_count: number;
  readonly available_at: number;
  readonly cancellation_requested_at: number | null;
  readonly completed_at: number | null;
  readonly created_at: number;
  readonly depends_on_job_id: string | null;
  readonly id: string;
  readonly idempotency_key: string | null;
  readonly input_json: string;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
  readonly lease_expires_at: number | null;
  readonly lease_owner: string | null;
  readonly max_attempts: number;
  readonly platform_id: string | null;
  readonly status: JobStatus;
  readonly type: string;
  readonly updated_at: number;
}

interface RawAttemptRow {
  readonly attempt_number: number;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly finished_at: number | null;
  readonly id: string;
  readonly job_id: string;
  readonly lease_owner: string;
  readonly retryable: number | null;
  readonly started_at: number;
  readonly status: JobAttempt['status'];
}

function jobFromRow(row: RawJobRow): Job {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    input: JSON.parse(row.input_json) as JsonValue,
    maxAttempts: row.max_attempts,
    attemptCount: row.attempt_count,
    availableAt: new Date(row.available_at),
    createdAt: new Date(row.created_at),
    ...(row.depends_on_job_id === null ? {} : { dependsOnJobId: row.depends_on_job_id }),
    updatedAt: new Date(row.updated_at),
    ...(row.platform_id === null ? {} : { platformId: row.platform_id }),
    ...(row.account_id === null ? {} : { accountId: row.account_id }),
    ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: new Date(row.lease_expires_at) }),
    ...(row.cancellation_requested_at === null
      ? {}
      : { cancellationRequestedAt: new Date(row.cancellation_requested_at) }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    ...(row.last_error_message === null ? {} : { lastErrorMessage: row.last_error_message }),
    ...(row.completed_at === null ? {} : { completedAt: new Date(row.completed_at) }),
  };
}

function attemptFromRow(row: RawAttemptRow): JobAttempt {
  return {
    id: row.id,
    jobId: row.job_id,
    attemptNumber: row.attempt_number,
    status: row.status,
    leaseOwner: row.lease_owner,
    startedAt: new Date(row.started_at),
    ...(row.finished_at === null ? {} : { finishedAt: new Date(row.finished_at) }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    ...(row.retryable === null ? {} : { retryable: row.retryable === 1 }),
  };
}

/** Transactional SQLite job queue. Claims and terminal transitions are lease-owner guarded. */
export class SqliteJobRepository implements JobRepository {
  public constructor(private readonly database: OpenRepurposeDatabase) {}

  public enqueue(input: EnqueueJobInput): EnqueueJobResult {
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      if (input.idempotencyKey !== undefined) {
        const existing = client
          .prepare('SELECT * FROM jobs WHERE idempotency_key = ?')
          .get(input.idempotencyKey) as unknown as RawJobRow | undefined;
        if (existing !== undefined) {
          client.exec('COMMIT;');
          return { created: false, job: jobFromRow(existing) };
        }
      }
      const availableAt = input.availableAt ?? input.now;
      client
        .prepare(
          `INSERT INTO jobs (
            id, type, status, input_json, idempotency_key, max_attempts, attempt_count,
            available_at, lease_owner, lease_expires_at, cancellation_requested_at,
            last_error_code, last_error_message, created_at, updated_at, completed_at,
            platform_id, account_id, depends_on_job_id
          ) VALUES (?, ?, 'pending', ?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.type,
          JSON.stringify(input.input),
          input.idempotencyKey ?? null,
          input.maxAttempts,
          availableAt.getTime(),
          input.now.getTime(),
          input.now.getTime(),
          input.platformId ?? null,
          input.accountId ?? null,
          input.dependsOnJobId ?? null,
        );
      const row = client
        .prepare('SELECT * FROM jobs WHERE id = ?')
        .get(input.id) as unknown as RawJobRow;
      client.exec('COMMIT;');
      return { created: true, job: jobFromRow(row) };
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }

  public findById(id: string): Job | undefined {
    const row = this.database.client.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
      RawJobRow | undefined;
    return row === undefined ? undefined : jobFromRow(row);
  }

  public list(status?: JobStatus): readonly Job[] {
    const rows =
      status === undefined
        ? this.database.client.prepare('SELECT * FROM jobs ORDER BY created_at DESC, id DESC').all()
        : this.database.client
            .prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC, id DESC')
            .all(status);
    return (rows as unknown as RawJobRow[]).map(jobFromRow);
  }

  public listAttempts(jobId: string): readonly JobAttempt[] {
    return (
      this.database.client
        .prepare('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY attempt_number ASC')
        .all(jobId) as unknown as RawAttemptRow[]
    ).map(attemptFromRow);
  }

  public claimNext(
    supportedTypes: readonly string[],
    workerId: string,
    now: Date,
    leaseExpiresAt: Date,
    limits?: JobClaimLimits,
  ): Job | undefined {
    if (supportedTypes.length === 0) return undefined;
    const client = this.database.client;
    const placeholders = supportedTypes.map(() => '?').join(', ');
    client.exec('BEGIN IMMEDIATE;');
    try {
      const queue = client
        .prepare('SELECT mode FROM job_queue_control WHERE singleton = 1')
        .get() as { mode: JobQueueMode };
      if (queue.mode !== 'running') {
        client.exec('COMMIT;');
        return undefined;
      }
      if (limits !== undefined) {
        const running = client
          .prepare("SELECT count(*) AS count FROM jobs WHERE status = 'running'")
          .get() as { count: number };
        if (running.count >= limits.globalConcurrency) {
          client.exec('COMMIT;');
          return undefined;
        }
      }
      // A dependent publish must never wait forever after a terminal transform failure. This is
      // deliberately persisted (rather than inferred at read time) so source-execution recovery
      // and the human job history receive the same durable failure signal.
      client
        .prepare(
          `UPDATE jobs SET status = 'failed', last_error_code = 'JOB_DEPENDENCY_FAILED',
             last_error_message = 'A prerequisite job did not succeed.', updated_at = ?, completed_at = ?
           WHERE status IN ('pending', 'retrying') AND depends_on_job_id IN (
             SELECT id FROM jobs WHERE status IN ('failed', 'cancelled')
           )`,
        )
        .run(now.getTime(), now.getTime());
      const candidates = client
        .prepare(
          `SELECT * FROM jobs
           WHERE status IN ('pending', 'retrying')
             AND available_at <= ?
             AND cancellation_requested_at IS NULL
             AND (depends_on_job_id IS NULL OR EXISTS (
               SELECT 1 FROM jobs prerequisite
               WHERE prerequisite.id = jobs.depends_on_job_id AND prerequisite.status = 'succeeded'
             ))
             AND type IN (${placeholders})
           ORDER BY available_at ASC, created_at ASC, id ASC`,
        )
        .all(now.getTime(), ...supportedTypes) as unknown as RawJobRow[];
      const candidate = candidates.find((job) => this.scopeCanRun(job, now, limits));
      if (candidate === undefined) {
        client.exec('COMMIT;');
        return undefined;
      }
      client
        .prepare(
          `UPDATE jobs
           SET status = 'running', attempt_count = attempt_count + 1, lease_owner = ?,
               lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('pending', 'retrying')`,
        )
        .run(workerId, leaseExpiresAt.getTime(), now.getTime(), candidate.id);
      const row = client
        .prepare('SELECT * FROM jobs WHERE id = ?')
        .get(candidate.id) as unknown as RawJobRow;
      client
        .prepare(
          `INSERT INTO job_attempts (
             id, job_id, attempt_number, status, lease_owner, started_at,
             finished_at, error_code, error_message, retryable
           ) VALUES (?, ?, ?, 'running', ?, ?, NULL, NULL, NULL, NULL)`,
        )
        .run(randomUUID(), row.id, row.attempt_count, workerId, now.getTime());
      client.exec('COMMIT;');
      return jobFromRow(row);
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }

  private scopeCanRun(job: RawJobRow, now: Date, limits?: JobClaimLimits): boolean {
    if (job.platform_id === null) return true;
    const client = this.database.client;
    const platformControl = client
      .prepare('SELECT cooldown_until FROM job_platform_controls WHERE platform_id = ?')
      .get(job.platform_id) as { cooldown_until: number | null } | undefined;
    if (
      platformControl?.cooldown_until !== null &&
      platformControl?.cooldown_until !== undefined &&
      platformControl.cooldown_until > now.getTime()
    )
      return false;
    if (limits !== undefined) {
      const platformRunning = client
        .prepare("SELECT count(*) AS count FROM jobs WHERE status = 'running' AND platform_id = ?")
        .get(job.platform_id) as { count: number };
      if (platformRunning.count >= limits.platformConcurrency) return false;
    }
    if (job.account_id === null) return true;
    const accountControl = client
      .prepare(
        `SELECT status, cooldown_until FROM job_account_controls
         WHERE platform_id = ? AND account_id = ?`,
      )
      .get(job.platform_id, job.account_id) as
      { cooldown_until: number | null; status: 'active' | 'paused' } | undefined;
    if (accountControl?.status === 'paused') return false;
    if (
      accountControl?.cooldown_until !== null &&
      accountControl?.cooldown_until !== undefined &&
      accountControl.cooldown_until > now.getTime()
    )
      return false;
    if (limits !== undefined) {
      const accountRunning = client
        .prepare(
          `SELECT count(*) AS count FROM jobs
           WHERE status = 'running' AND platform_id = ? AND account_id = ?`,
        )
        .get(job.platform_id, job.account_id) as { count: number };
      if (accountRunning.count >= limits.accountConcurrency) return false;
    }
    return true;
  }

  public heartbeat(jobId: string, workerId: string, now: Date, leaseExpiresAt: Date): boolean {
    const result = this.database.client
      .prepare(
        `UPDATE jobs SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?`,
      )
      .run(leaseExpiresAt.getTime(), now.getTime(), jobId, workerId);
    return Number(result.changes) === 1;
  }

  public countRunning(): number {
    const row = this.database.client
      .prepare("SELECT count(*) AS count FROM jobs WHERE status = 'running'")
      .get() as { count: number };
    return row.count;
  }

  public complete(jobId: string, workerId: string, now: Date): boolean {
    return this.finish(jobId, workerId, now, 'succeeded');
  }

  public cancelRunning(jobId: string, workerId: string, now: Date): boolean {
    return this.finish(jobId, workerId, now, 'cancelled');
  }

  private finish(
    jobId: string,
    workerId: string,
    now: Date,
    status: 'succeeded' | 'cancelled',
  ): boolean {
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      const job = client.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as
        RawJobRow | undefined;
      const cancellationGuard =
        status === 'succeeded' ? 'AND cancellation_requested_at IS NULL' : '';
      const result = client
        .prepare(
          `UPDATE jobs SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
             updated_at = ?, completed_at = ?
           WHERE id = ? AND status = 'running' AND lease_owner = ? ${cancellationGuard}`,
        )
        .run(status, now.getTime(), now.getTime(), jobId, workerId);
      if (Number(result.changes) === 1) {
        client
          .prepare(
            `UPDATE job_attempts SET status = ?, finished_at = ?
             WHERE job_id = ? AND status = 'running' AND lease_owner = ?`,
          )
          .run(status, now.getTime(), jobId, workerId);
        if (
          status === 'succeeded' &&
          job?.platform_id !== null &&
          job?.platform_id !== undefined &&
          job.account_id !== null
        )
          client
            .prepare(
              `UPDATE job_account_controls
               SET auth_failure_count = 0, updated_at = ?
               WHERE platform_id = ? AND account_id = ? AND status = 'active'`,
            )
            .run(now.getTime(), job.platform_id, job.account_id);
      }
      client.exec('COMMIT;');
      return Number(result.changes) === 1;
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }

  public fail(
    jobId: string,
    workerId: string,
    failure: JobFailure,
    now: Date,
    retryAt?: Date,
    authFailureThreshold = 3,
  ): boolean {
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      const job = client.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as
        RawJobRow | undefined;
      const status = retryAt === undefined ? 'failed' : 'retrying';
      const result = client
        .prepare(
          `UPDATE jobs SET status = ?, available_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, last_error_code = ?, last_error_message = ?,
             updated_at = ?, completed_at = ?
           WHERE id = ? AND status = 'running' AND lease_owner = ?`,
        )
        .run(
          status,
          (retryAt ?? now).getTime(),
          failure.code,
          failure.message,
          now.getTime(),
          retryAt === undefined ? now.getTime() : null,
          jobId,
          workerId,
        );
      if (Number(result.changes) === 1) {
        client
          .prepare(
            `UPDATE job_attempts
             SET status = 'failed', finished_at = ?, error_code = ?, error_message = ?, retryable = ?
             WHERE job_id = ? AND status = 'running' AND lease_owner = ?`,
          )
          .run(
            now.getTime(),
            failure.code,
            failure.message,
            failure.retryable ? 1 : 0,
            jobId,
            workerId,
          );
        if (job !== undefined) this.recordScopeFailure(job, failure, now, authFailureThreshold);
      }
      client.exec('COMMIT;');
      return Number(result.changes) === 1;
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }

  private recordScopeFailure(
    job: RawJobRow,
    failure: JobFailure,
    now: Date,
    authFailureThreshold: number,
  ): void {
    if (job.platform_id === null) return;
    const client = this.database.client;
    if (failure.retryAfterMs !== undefined) {
      const cooldownUntil = now.getTime() + Math.max(0, failure.retryAfterMs);
      client
        .prepare(
          `INSERT INTO job_platform_controls (platform_id, cooldown_until, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(platform_id) DO UPDATE SET
             cooldown_until = max(COALESCE(cooldown_until, 0), excluded.cooldown_until),
             updated_at = excluded.updated_at`,
        )
        .run(job.platform_id, cooldownUntil, now.getTime());
      if (job.account_id !== null)
        client
          .prepare(
            `INSERT INTO job_account_controls (
               platform_id, account_id, status, pause_reason, auth_failure_count,
               cooldown_until, updated_at
             ) VALUES (?, ?, 'active', NULL, 0, ?, ?)
             ON CONFLICT(platform_id, account_id) DO UPDATE SET
               cooldown_until = max(COALESCE(cooldown_until, 0), excluded.cooldown_until),
               updated_at = excluded.updated_at`,
          )
          .run(job.platform_id, job.account_id, cooldownUntil, now.getTime());
    }
    if (
      job.account_id !== null &&
      (failure.category === 'authentication' || failure.category === 'authorization')
    )
      client
        .prepare(
          `INSERT INTO job_account_controls (
             platform_id, account_id, status, pause_reason, auth_failure_count,
             cooldown_until, updated_at
           ) VALUES (?, ?, ?, ?, 1, NULL, ?)
           ON CONFLICT(platform_id, account_id) DO UPDATE SET
             auth_failure_count = auth_failure_count + 1,
             status = CASE
               WHEN auth_failure_count + 1 >= ? THEN 'paused'
               ELSE status
             END,
             pause_reason = CASE
               WHEN auth_failure_count + 1 >= ? THEN excluded.pause_reason
               ELSE pause_reason
             END,
             updated_at = excluded.updated_at`,
        )
        .run(
          job.platform_id,
          job.account_id,
          authFailureThreshold <= 1 ? 'paused' : 'active',
          failure.code,
          now.getTime(),
          authFailureThreshold,
          authFailureThreshold,
        );
  }

  public getQueueState(): JobQueueState {
    const row = this.database.client
      .prepare('SELECT mode, updated_at FROM job_queue_control WHERE singleton = 1')
      .get() as { mode: JobQueueMode; updated_at: number };
    return { mode: row.mode, updatedAt: new Date(row.updated_at) };
  }

  public setQueueMode(mode: JobQueueMode, now: Date): JobQueueState {
    this.database.client
      .prepare('UPDATE job_queue_control SET mode = ?, updated_at = ? WHERE singleton = 1')
      .run(mode, now.getTime());
    return this.getQueueState();
  }

  public getAccountControl(platformId: string, accountId: string): JobAccountControl | undefined {
    const row = this.database.client
      .prepare('SELECT * FROM job_account_controls WHERE platform_id = ? AND account_id = ?')
      .get(platformId, accountId) as
      | {
          account_id: string;
          auth_failure_count: number;
          cooldown_until: number | null;
          pause_reason: string | null;
          platform_id: string;
          status: 'active' | 'paused';
          updated_at: number;
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          accountId: row.account_id,
          authFailureCount: row.auth_failure_count,
          platformId: row.platform_id,
          status: row.status,
          updatedAt: new Date(row.updated_at),
          ...(row.cooldown_until === null ? {} : { cooldownUntil: new Date(row.cooldown_until) }),
          ...(row.pause_reason === null ? {} : { pauseReason: row.pause_reason }),
        };
  }

  public resumeAccount(platformId: string, accountId: string, now: Date): JobAccountControl {
    this.database.client
      .prepare(
        `INSERT INTO job_account_controls (
           platform_id, account_id, status, pause_reason, auth_failure_count,
           cooldown_until, updated_at
         ) VALUES (?, ?, 'active', NULL, 0, NULL, ?)
         ON CONFLICT(platform_id, account_id) DO UPDATE SET
           status = 'active', pause_reason = NULL, auth_failure_count = 0,
           cooldown_until = NULL, updated_at = excluded.updated_at`,
      )
      .run(platformId, accountId, now.getTime());
    return this.getAccountControl(platformId, accountId)!;
  }

  public retry(id: string, now: Date): Job | undefined {
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      const existing = client.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
        RawJobRow | undefined;
      if (existing === undefined) {
        client.exec('COMMIT;');
        return undefined;
      }
      if (existing.status === 'failed')
        client
          .prepare(
            `UPDATE jobs SET status = 'pending', available_at = ?,
               max_attempts = max(max_attempts, attempt_count + 1),
               cancellation_requested_at = NULL, completed_at = NULL,
               last_error_code = NULL, last_error_message = NULL, updated_at = ?
             WHERE id = ? AND status = 'failed'`,
          )
          .run(now.getTime(), now.getTime(), id);
      const updated = client
        .prepare('SELECT * FROM jobs WHERE id = ?')
        .get(id) as unknown as RawJobRow;
      client.exec('COMMIT;');
      return jobFromRow(updated);
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }

  public isCancellationRequested(jobId: string): boolean {
    const row = this.database.client
      .prepare('SELECT cancellation_requested_at FROM jobs WHERE id = ?')
      .get(jobId) as { cancellation_requested_at: number | null } | undefined;
    return row?.cancellation_requested_at !== null && row?.cancellation_requested_at !== undefined;
  }

  public requestCancellation(id: string, now: Date): Job | undefined {
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      const existing = client.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
        RawJobRow | undefined;
      if (existing === undefined) {
        client.exec('COMMIT;');
        return undefined;
      }
      if (existing.status === 'pending' || existing.status === 'retrying') {
        client
          .prepare(
            `UPDATE jobs SET status = 'cancelled', cancellation_requested_at = ?,
               updated_at = ?, completed_at = ? WHERE id = ?`,
          )
          .run(now.getTime(), now.getTime(), now.getTime(), id);
      } else if (existing.status === 'running' && existing.cancellation_requested_at === null) {
        client
          .prepare('UPDATE jobs SET cancellation_requested_at = ?, updated_at = ? WHERE id = ?')
          .run(now.getTime(), now.getTime(), id);
      }
      const updated = client
        .prepare('SELECT * FROM jobs WHERE id = ?')
        .get(id) as unknown as RawJobRow;
      client.exec('COMMIT;');
      return jobFromRow(updated);
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }

  public recoverExpiredLeases(now: Date): number {
    const client = this.database.client;
    client.exec('BEGIN IMMEDIATE;');
    try {
      const expired = client
        .prepare(
          `SELECT id, attempt_count, max_attempts, cancellation_requested_at
           FROM jobs WHERE status = 'running' AND lease_expires_at <= ?`,
        )
        .all(now.getTime()) as unknown as Array<{
        id: string;
        attempt_count: number;
        max_attempts: number;
        cancellation_requested_at: number | null;
      }>;
      for (const job of expired) {
        const cancelled = job.cancellation_requested_at !== null;
        const retrying = !cancelled && job.attempt_count < job.max_attempts;
        const status = cancelled ? 'cancelled' : retrying ? 'retrying' : 'failed';
        client
          .prepare(
            `UPDATE jobs SET status = ?, available_at = ?, lease_owner = NULL,
               lease_expires_at = NULL, last_error_code = ?, last_error_message = ?,
               updated_at = ?, completed_at = ? WHERE id = ? AND status = 'running'`,
          )
          .run(
            status,
            now.getTime(),
            cancelled ? null : 'LEASE_EXPIRED',
            cancelled ? null : 'The previous worker stopped before completing this attempt.',
            now.getTime(),
            retrying ? null : now.getTime(),
            job.id,
          );
        client
          .prepare(
            `UPDATE job_attempts SET status = ?, finished_at = ?, error_code = ?,
               error_message = ?, retryable = ?
             WHERE job_id = ? AND status = 'running'`,
          )
          .run(
            cancelled ? 'cancelled' : 'failed',
            now.getTime(),
            cancelled ? null : 'LEASE_EXPIRED',
            cancelled ? null : 'The previous worker stopped before completing this attempt.',
            cancelled ? null : 1,
            job.id,
          );
      }
      client.exec('COMMIT;');
      return expired.length;
    } catch (error) {
      client.exec('ROLLBACK;');
      throw error;
    }
  }
}
