import { createHash } from 'node:crypto';
import { z } from 'zod';

const identifier = z.string().trim().min(1).max(200);
const milliseconds = z.number().int().nonnegative();

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
    text: z.string().trim().min(1).max(20_000),
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

export interface TranscriptionProviderContext {
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
  replaceGeneratedCues(id: string, cues: readonly TranscriptCue[], now: Date): Transcript;
  reserve(input: ReserveTranscriptInput): ReserveTranscriptResult;
  updateCue(id: string, position: number, cue: TranscriptCue, now: Date): Transcript;
}
