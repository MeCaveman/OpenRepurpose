import { createHash } from 'node:crypto';
import { z } from 'zod';

const identifier = z.string().trim().min(1).max(200);
const milliseconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const cueText = z
  .string()
  .trim()
  .min(1)
  .max(20_000)
  .refine((value) => !value.includes('\u0000'), 'Cue text cannot contain a null character.');

export const transcriptionWordSchema = z
  .object({ endMs: milliseconds, startMs: milliseconds, text: z.string().min(1) })
  .strict()
  .refine((word) => word.endMs >= word.startMs, {
    message: 'word endMs must not precede startMs',
    path: ['endMs'],
  });

export const transcriptCueSchema = z
  .object({
    endMs: milliseconds,
    startMs: milliseconds,
    text: cueText,
    words: z.array(transcriptionWordSchema).max(10_000).optional(),
  })
  .strict()
  .refine((cue) => cue.endMs > cue.startMs, {
    message: 'cue endMs must be greater than startMs',
    path: ['endMs'],
  })
  .refine(
    (cue) =>
      cue.words === undefined ||
      cue.words.every((word) => word.startMs >= cue.startMs && word.endMs <= cue.endMs),
    { message: 'word timestamps must stay within their cue', path: ['words'] },
  );

export type TranscriptionWord = z.output<typeof transcriptionWordSchema>;
export type TranscriptCue = z.output<typeof transcriptCueSchema>;

export const transcriptCueListSchema = z
  .array(transcriptCueSchema)
  .min(1, 'A transcript must contain at least one cue.')
  .max(100_000)
  .superRefine((cues, context) => {
    for (let index = 1; index < cues.length; index += 1) {
      if (cues[index]!.startMs < cues[index - 1]!.startMs) {
        context.addIssue({
          code: 'custom',
          message: 'Cue start times must be in chronological order.',
          path: [index, 'startMs'],
        });
      }
    }
  });

export const transcriptEditRequestSchema = z
  .object({
    cues: transcriptCueListSchema,
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

export type TranscriptEditRequest = z.output<typeof transcriptEditRequestSchema>;
export type SubtitleFormat = 'srt' | 'vtt';

export type TranscriptServiceErrorCode =
  'TRANSCRIPT_INVALID' | 'TRANSCRIPT_NOT_FOUND' | 'TRANSCRIPT_REVISION_CONFLICT';

export class TranscriptServiceError extends Error {
  public constructor(
    public readonly code: TranscriptServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TranscriptServiceError';
  }
}

export interface TranscriptionModel {
  readonly id: string;
  /** Provider-owned version, included in cache identity to avoid cross-model reuse. */
  readonly version: string;
}

export interface TranscriptionProviderCapabilities {
  readonly cancellation: boolean;
  readonly wordTimestamps: boolean;
}

/** Input boundary for local or user-configured inference implementations. */
export interface TranscriptionRequest {
  /** A managed local audio path; providers must not infer remote upload behavior from this contract. */
  readonly audioPath: string;
  readonly language?: string;
  readonly model: TranscriptionModel;
  /** Provider-specific, JSON-safe options that materially affect output. */
  readonly options: Readonly<Record<string, TranscriptionOptionValue>>;
}

export type TranscriptionOptionValue =
  | boolean
  | number
  | string
  | null
  | readonly TranscriptionOptionValue[]
  | { readonly [key: string]: TranscriptionOptionValue };

export interface TranscriptionResult {
  readonly cues: readonly TranscriptCue[];
  readonly detectedLanguage?: string;
}

/** Transport-neutral inference progress suitable for jobs, CLI output, and the web UI. */
export interface TranscriptionProgress {
  readonly percent: number;
}

export interface TranscriptionProviderContext {
  readonly onProgress?: (progress: TranscriptionProgress) => void;
  readonly signal: AbortSignal;
}

/**
 * Replaceable inference boundary. whisper.cpp is an implementation detail of a future provider,
 * not a special case in transcript services or persistence.
 */
export interface TranscriptionProvider {
  readonly displayName: string;
  readonly id: string;
  capabilities(): Promise<TranscriptionProviderCapabilities>;
  transcribe(
    request: TranscriptionRequest,
    context: TranscriptionProviderContext,
  ): Promise<TranscriptionResult>;
}

/** Composition-time registry; providers register without core provider switches. */
export class TranscriptionProviderRegistry {
  private readonly providers = new Map<string, TranscriptionProvider>();

  public constructor(providers: readonly TranscriptionProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  public get(id: string): TranscriptionProvider | undefined {
    return this.providers.get(id);
  }

  public list(): readonly TranscriptionProvider[] {
    return [...this.providers.values()];
  }

  public register(provider: TranscriptionProvider): () => void {
    const id = identifier.parse(provider.id);
    if (this.providers.has(id)) throw new Error(`Duplicate transcription provider: ${id}`);
    this.providers.set(id, provider);
    return () => this.providers.delete(id);
  }

  public require(id: string): TranscriptionProvider {
    const provider = this.get(id);
    if (provider === undefined) throw new Error(`Unknown transcription provider: ${id}`);
    return provider;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export interface TranscriptionCacheIdentityInput {
  readonly language?: string;
  readonly model: TranscriptionModel;
  readonly options?: Readonly<Record<string, TranscriptionOptionValue>>;
  readonly providerId: string;
  readonly sourceAudioFingerprint: string;
}

export interface TranscriptionCacheIdentity {
  readonly cacheKey: string;
  readonly language?: string;
  readonly model: TranscriptionModel;
  readonly normalizedOptions: Readonly<Record<string, TranscriptionOptionValue>>;
  readonly providerId: string;
  readonly sourceAudioFingerprint: string;
}

/** Deterministic cache identity for output-affecting inference inputs only. */
export function createTranscriptionCacheIdentity(
  input: TranscriptionCacheIdentityInput,
): TranscriptionCacheIdentity {
  const providerId = identifier.parse(input.providerId);
  const sourceAudioFingerprint = identifier.parse(input.sourceAudioFingerprint);
  const model = {
    id: identifier.parse(input.model.id),
    version: identifier.parse(input.model.version),
  };
  const language = input.language === undefined ? undefined : identifier.parse(input.language);
  const normalizedOptions = (input.options ?? {}) as Readonly<
    Record<string, TranscriptionOptionValue>
  >;
  const payload = canonicalJson({
    cacheKeyVersion: 1,
    language,
    model,
    options: normalizedOptions,
    providerId,
    sourceAudioFingerprint,
  });
  return {
    cacheKey: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
    ...(language === undefined ? {} : { language }),
    model,
    normalizedOptions,
    providerId,
    sourceAudioFingerprint,
  };
}

export type TranscriptSource =
  | { readonly derivativeId: string; readonly kind: 'derivative' }
  | { readonly kind: 'media'; readonly mediaId: string };

export interface Transcript {
  readonly cacheKey: string;
  readonly createdAt: Date;
  readonly cues: readonly TranscriptCue[];
  readonly generatedAt?: Date;
  readonly hasUserEdits: boolean;
  readonly id: string;
  readonly language?: string;
  readonly model: TranscriptionModel;
  readonly options: Readonly<Record<string, TranscriptionOptionValue>>;
  readonly providerId: string;
  readonly revision: number;
  readonly source: TranscriptSource;
  readonly sourceAudioFingerprint: string;
  readonly updatedAt: Date;
}

export interface ReserveTranscriptInput {
  readonly identity: TranscriptionCacheIdentity;
  readonly id: string;
  readonly now: Date;
  readonly source: TranscriptSource;
}

export interface ReserveTranscriptResult {
  readonly created: boolean;
  readonly transcript: Transcript;
}

/** Durable boundary for transcript cache lookups and user-edit persistence. */
export interface TranscriptRepository {
  findByCacheKey(cacheKey: string): Transcript | undefined;
  findById(id: string): Transcript | undefined;
  listByMediaId(mediaId: string): readonly Transcript[];
  replaceGeneratedCues(id: string, cues: readonly TranscriptCue[], now: Date): Transcript;
  replaceUserEditedCues(
    id: string,
    expectedRevision: number,
    cues: readonly TranscriptCue[],
    now: Date,
  ): Transcript | undefined;
  reserve(input: ReserveTranscriptInput): ReserveTranscriptResult;
  updateCue(id: string, position: number, cue: TranscriptCue, now: Date): Transcript;
}

function normalizedCueText(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function subtitleTimestamp(millisecondsValue: number, separator: ',' | '.'): string {
  const hours = Math.floor(millisecondsValue / 3_600_000);
  const minutes = Math.floor((millisecondsValue % 3_600_000) / 60_000);
  const seconds = Math.floor((millisecondsValue % 60_000) / 1_000);
  const millisecondsPart = millisecondsValue % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(millisecondsPart).padStart(3, '0')}`;
}

/** Deterministic UTF-8 subtitle serialization with LF line endings. */
export function exportSubtitle(
  cuesInput: readonly TranscriptCue[],
  format: SubtitleFormat,
): string {
  if (format !== 'srt' && format !== 'vtt')
    throw new TranscriptServiceError('TRANSCRIPT_INVALID', 'Subtitle format must be srt or vtt.');
  const parsed = transcriptCueListSchema.safeParse(cuesInput);
  if (!parsed.success)
    throw new TranscriptServiceError(
      'TRANSCRIPT_INVALID',
      parsed.error.issues[0]?.message ?? 'The transcript contains invalid cues.',
    );
  const cues = parsed.data;
  const blocks = cues.map((cue, index) => {
    const separator = format === 'srt' ? ',' : '.';
    const timing = `${subtitleTimestamp(cue.startMs, separator)} --> ${subtitleTimestamp(cue.endMs, separator)}`;
    const text = normalizedCueText(cue.text);
    return format === 'srt' ? `${index + 1}\n${timing}\n${text}` : `${timing}\n${text}`;
  });
  return `${format === 'vtt' ? 'WEBVTT\n\n' : ''}${blocks.join('\n\n')}\n`;
}

/** Shared application service used by HTTP, CLI, and future workflow entry points. */
export class TranscriptService {
  public constructor(
    private readonly repository: TranscriptRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public listForMedia(mediaId: string): readonly Transcript[] {
    return this.repository.listByMediaId(this.parseId(mediaId));
  }

  public show(id: string): Transcript | undefined {
    return this.repository.findById(this.parseId(id));
  }

  public save(id: string, edit: TranscriptEditRequest): Transcript {
    const transcriptId = this.parseId(id);
    const parsed = transcriptEditRequestSchema.safeParse(edit);
    if (!parsed.success)
      throw new TranscriptServiceError(
        'TRANSCRIPT_INVALID',
        parsed.error.issues[0]?.message ?? 'The transcript edit is invalid.',
      );
    const existing = this.repository.findById(transcriptId);
    if (existing === undefined)
      throw new TranscriptServiceError('TRANSCRIPT_NOT_FOUND', 'Transcript not found.');
    if (existing.revision !== parsed.data.expectedRevision)
      throw new TranscriptServiceError(
        'TRANSCRIPT_REVISION_CONFLICT',
        'The transcript changed after this editor was opened. Reload it before saving.',
      );
    const updated = this.repository.replaceUserEditedCues(
      transcriptId,
      parsed.data.expectedRevision,
      parsed.data.cues,
      this.now(),
    );
    if (updated === undefined)
      throw new TranscriptServiceError(
        'TRANSCRIPT_REVISION_CONFLICT',
        'The transcript changed after this editor was opened. Reload it before saving.',
      );
    return updated;
  }

  public export(
    id: string,
    format: SubtitleFormat,
  ): { readonly content: string; readonly format: SubtitleFormat } {
    const transcript = this.show(id);
    if (transcript === undefined)
      throw new TranscriptServiceError('TRANSCRIPT_NOT_FOUND', 'Transcript not found.');
    return { content: exportSubtitle(transcript.cues, format), format };
  }

  private parseId(value: string): string {
    const parsed = identifier.safeParse(value);
    if (!parsed.success)
      throw new TranscriptServiceError('TRANSCRIPT_INVALID', 'Transcript identifier is invalid.');
    return parsed.data;
  }
}
