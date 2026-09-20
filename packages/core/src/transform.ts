import { createHash } from 'node:crypto';
import { z } from 'zod';

const nonEmptyIdentifier = z.string().trim().min(1).max(200);
const milliseconds = z.number().int().nonnegative();
const positiveMilliseconds = z.number().int().positive();
const positiveDimension = z.number().int().min(2).max(16_384);

export const trimTransformSchema = z
  .object({
    type: z.literal('trim'),
    startMs: milliseconds.default(0),
    endMs: positiveMilliseconds.optional(),
    durationMs: positiveMilliseconds.optional(),
    mode: z.literal('accurate').default('accurate'),
  })
  .strict()
  .refine((step) => step.endMs === undefined || step.endMs > step.startMs, {
    message: 'endMs must be greater than startMs',
    path: ['endMs'],
  })
  .refine((step) => step.endMs === undefined || step.durationMs === undefined, {
    message: 'endMs and durationMs are mutually exclusive',
    path: ['durationMs'],
  });

const cropAnchorSchema = z.enum(['center', 'top', 'bottom', 'left', 'right']);
const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be a six-digit hexadecimal color')
  .transform((color) => color.toLowerCase());

export const fitTransformSchema = z.discriminatedUnion('mode', [
  z
    .object({
      type: z.literal('fit'),
      mode: z.literal('crop'),
      width: positiveDimension,
      height: positiveDimension,
      anchor: cropAnchorSchema.default('center'),
    })
    .strict(),
  z
    .object({
      type: z.literal('fit'),
      mode: z.literal('contain'),
      width: positiveDimension,
      height: positiveDimension,
      anchor: cropAnchorSchema.default('center'),
      backgroundColor: colorSchema.default('#000000'),
    })
    .strict(),
  z
    .object({
      type: z.literal('fit'),
      mode: z.literal('stretch'),
      width: positiveDimension,
      height: positiveDimension,
    })
    .strict(),
]);

export const audioTransformSchema = z.discriminatedUnion('mode', [
  z.object({ type: z.literal('audio'), mode: z.literal('preserve') }).strict(),
  z
    .object({
      type: z.literal('audio'),
      mode: z.literal('normalize'),
      targetLufs: z.number().min(-70).max(-5).default(-14),
      truePeakDb: z.number().min(-9).max(0).default(-1.5),
      loudnessRangeLufs: z.number().min(1).max(50).default(11),
    })
    .strict(),
  z
    .object({
      type: z.literal('audio'),
      mode: z.literal('gain'),
      gainDb: z.number().min(-60).max(60),
    })
    .strict(),
  z.object({ type: z.literal('audio'), mode: z.literal('remove') }).strict(),
]);

const overlayPositionSchema = z.enum([
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
]);

export const watermarkTransformSchema = z
  .object({
    type: z.literal('watermark'),
    assetId: nonEmptyIdentifier,
    opacity: z.number().positive().max(1).default(1),
    position: overlayPositionSchema.default('top-right'),
    marginPx: z.number().int().nonnegative().max(4_096).default(24),
    scalePercent: z.number().positive().max(100).default(15),
  })
  .strict();

export const transformStepSchema = z.union([
  trimTransformSchema,
  fitTransformSchema,
  audioTransformSchema,
  watermarkTransformSchema,
]);

export const transformOutputSchema = z
  .object({
    container: z.literal('mp4').default('mp4'),
    videoCodec: z.literal('h264').default('h264'),
    audioCodec: z.enum(['aac', 'none']).default('aac'),
    pixelFormat: z.literal('yuv420p').default('yuv420p'),
    crf: z.number().int().min(0).max(51).default(23),
    preset: z
      .enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower'])
      .default('medium'),
    maxWidth: positiveDimension.optional(),
    maxHeight: positiveDimension.optional(),
    maxFrameRate: z.number().positive().max(240).optional(),
  })
  .strict();

export const transformRecipeSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    steps: z.array(transformStepSchema).max(100).default([]),
    output: transformOutputSchema.prefault({}),
  })
  .strict();

export const transformPlanSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    user: transformRecipeSchema,
    destination: z
      .object({
        destinationId: nonEmptyIdentifier,
        profileVersion: nonEmptyIdentifier,
        recipe: transformRecipeSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export type TrimTransform = z.output<typeof trimTransformSchema>;
export type FitTransform = z.output<typeof fitTransformSchema>;
export type AudioTransform = z.output<typeof audioTransformSchema>;
export type WatermarkTransform = z.output<typeof watermarkTransformSchema>;
export type TransformStep = z.output<typeof transformStepSchema>;
export type TransformOutput = z.output<typeof transformOutputSchema>;
export type TransformRecipe = z.output<typeof transformRecipeSchema>;
export type TransformRecipeInput = z.input<typeof transformRecipeSchema>;
export type TransformPlan = z.output<typeof transformPlanSchema>;
export type TransformPlanInput = z.input<typeof transformPlanSchema>;

/** Parses a recipe and materializes all behavior-affecting defaults. Step order is preserved. */
export function normalizeTransformRecipe(recipe: TransformRecipeInput): TransformRecipe {
  return transformRecipeSchema.parse(recipe);
}

/** Keeps user intent separate from destination compliance while normalizing both layers. */
export function normalizeTransformPlan(plan: TransformPlanInput): TransformPlan {
  return transformPlanSchema.parse(plan);
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

export function serializeNormalizedTransformPlan(plan: TransformPlan): string {
  return canonicalJson(plan);
}

export function transformRecipeHash(plan: TransformPlanInput): string {
  const normalizedPlan = normalizeTransformPlan(plan);
  return `sha256:${createHash('sha256')
    .update(serializeNormalizedTransformPlan(normalizedPlan))
    .digest('hex')}`;
}

export interface TransformToolIdentity {
  /** The concrete FFmpeg encoder implementation, for example `libx264`. */
  readonly encoder: string;
  readonly ffmpegVersion: string;
}

export interface TransformCacheKeyInput {
  readonly outputProfileVersion: string;
  readonly plan: TransformPlanInput;
  readonly sourceFingerprint: string;
  readonly tool: TransformToolIdentity;
}

export interface TransformCacheIdentity {
  readonly cacheKey: string;
  readonly normalizedPlan: TransformPlan;
  readonly outputProfileVersion: string;
  readonly recipeHash: string;
  readonly sourceFingerprint: string;
  readonly tool: TransformToolIdentity;
}

/** Builds the complete deterministic identity for an output derivative. */
export function createTransformCacheIdentity(
  input: TransformCacheKeyInput,
): TransformCacheIdentity {
  const sourceFingerprint = nonEmptyIdentifier.parse(input.sourceFingerprint);
  const outputProfileVersion = nonEmptyIdentifier.parse(input.outputProfileVersion);
  const tool = {
    encoder: nonEmptyIdentifier.parse(input.tool.encoder),
    ffmpegVersion: nonEmptyIdentifier.parse(input.tool.ffmpegVersion),
  };
  const normalizedPlan = normalizeTransformPlan(input.plan);
  const recipeHash = transformRecipeHash(normalizedPlan);
  const cachePayload = canonicalJson({
    cacheKeyVersion: 1,
    normalizedPlan,
    outputProfileVersion,
    sourceFingerprint,
    tool,
  });
  return {
    cacheKey: `sha256:${createHash('sha256').update(cachePayload).digest('hex')}`,
    normalizedPlan,
    outputProfileVersion,
    recipeHash,
    sourceFingerprint,
    tool,
  };
}

export type TransformDerivativeStatus =
  'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface TransformDerivativeOutput {
  readonly metadata: {
    readonly audioCodec?: string;
    readonly durationMillis: number;
    readonly frameRate?: number;
    readonly hasAudio: boolean;
    readonly height: number;
    readonly videoCodec: string;
    readonly width: number;
  };
  readonly path: string;
  readonly sizeBytes: number;
}

export interface TransformDerivativeProvenance {
  readonly encoder: string;
  readonly ffmpegVersion: string;
  readonly normalizedPlan: TransformPlan;
  readonly outputProfileVersion: string;
  readonly recipeHash: string;
  readonly sourceFingerprint: string;
  readonly sourceMediaId: string;
}

export interface TransformDerivative {
  readonly cacheKey: string;
  readonly completedAt?: Date;
  readonly createdAt: Date;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly id: string;
  readonly output?: TransformDerivativeOutput;
  readonly provenance: TransformDerivativeProvenance;
  readonly status: TransformDerivativeStatus;
  readonly updatedAt: Date;
}
