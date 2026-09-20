import { describe, expect, it } from 'vitest';
import {
  createTransformCacheIdentity,
  normalizeTransformPlan,
  normalizeTransformRecipe,
  serializeNormalizedTransformPlan,
  transformRecipeHash,
  transformRecipeSchema,
} from '../../packages/core/src/index.js';
import { createTemporaryDatabase } from '../../packages/testkit/src/index.js';

const userPlan = {
  schemaVersion: 1 as const,
  user: {
    steps: [
      { type: 'trim' as const, startMs: 1_000, durationMs: 60_000 },
      { type: 'fit' as const, mode: 'crop' as const, width: 1_080, height: 1_920 },
      { type: 'audio' as const, mode: 'normalize' as const },
      { type: 'watermark' as const, assetId: 'media-watermark' },
    ],
  },
};

describe('transform recipes', () => {
  it('validates and materializes deterministic defaults without flattening intent layers', () => {
    const plan = normalizeTransformPlan({
      ...userPlan,
      destination: {
        destinationId: 'youtube',
        profileVersion: 'youtube-video-v1',
        recipe: {
          steps: [{ type: 'fit', mode: 'contain', width: 1_920, height: 1_080 }],
        },
      },
    });

    expect(plan.user).toEqual({
      schemaVersion: 1,
      steps: [
        { type: 'trim', startMs: 1_000, durationMs: 60_000, mode: 'accurate' },
        { type: 'fit', mode: 'crop', width: 1_080, height: 1_920, anchor: 'center' },
        {
          type: 'audio',
          mode: 'normalize',
          targetLufs: -14,
          truePeakDb: -1.5,
          loudnessRangeLufs: 11,
        },
        {
          type: 'watermark',
          assetId: 'media-watermark',
          opacity: 1,
          position: 'top-right',
          marginPx: 24,
          scalePercent: 15,
        },
      ],
      output: {
        container: 'mp4',
        videoCodec: 'h264',
        audioCodec: 'aac',
        pixelFormat: 'yuv420p',
        crf: 23,
        preset: 'medium',
      },
    });
    expect(plan.destination).toMatchObject({
      destinationId: 'youtube',
      profileVersion: 'youtube-video-v1',
      recipe: {
        steps: [
          {
            type: 'fit',
            mode: 'contain',
            width: 1_920,
            height: 1_080,
            anchor: 'center',
            backgroundColor: '#000000',
          },
        ],
      },
    });
  });

  it('normalizes equivalent recipes to identical canonical JSON and hashes', () => {
    const implicit = normalizeTransformPlan(userPlan);
    const explicit = normalizeTransformPlan({
      schemaVersion: 1,
      user: {
        schemaVersion: 1,
        steps: [
          { durationMs: 60_000, startMs: 1_000, mode: 'accurate', type: 'trim' },
          { height: 1_920, anchor: 'center', type: 'fit', width: 1_080, mode: 'crop' },
          {
            truePeakDb: -1.5,
            targetLufs: -14,
            type: 'audio',
            loudnessRangeLufs: 11,
            mode: 'normalize',
          },
          {
            position: 'top-right',
            scalePercent: 15,
            type: 'watermark',
            marginPx: 24,
            opacity: 1,
            assetId: 'media-watermark',
          },
        ],
        output: {
          preset: 'medium',
          crf: 23,
          pixelFormat: 'yuv420p',
          audioCodec: 'aac',
          videoCodec: 'h264',
          container: 'mp4',
        },
      },
    });

    expect(serializeNormalizedTransformPlan(implicit)).toBe(
      serializeNormalizedTransformPlan(explicit),
    );
    expect(transformRecipeHash(implicit)).toBe(transformRecipeHash(explicit));
  });

  it('rejects ambiguous ranges and untyped command-like fields', () => {
    expect(() =>
      normalizeTransformRecipe({
        steps: [{ type: 'trim', startMs: 2_000, endMs: 1_000 }],
      }),
    ).toThrow('endMs must be greater than startMs');
    expect(() =>
      normalizeTransformRecipe({
        steps: [{ type: 'trim', startMs: 0, endMs: 2_000, durationMs: 1_000 }],
      }),
    ).toThrow('mutually exclusive');
    expect(
      transformRecipeSchema.safeParse({
        steps: [],
        command: '-vf evil',
      }).success,
    ).toBe(false);
  });

  it('changes cache identity for every output-affecting identity input', () => {
    const baselineInput = {
      sourceFingerprint: 'sha256:source-a',
      plan: userPlan,
      outputProfileVersion: 'common-mp4-v1',
      tool: { ffmpegVersion: '8.0.1', encoder: 'libx264' },
    };
    const baseline = createTransformCacheIdentity(baselineInput);
    const variants = [
      { ...baselineInput, sourceFingerprint: 'sha256:source-b' },
      { ...baselineInput, outputProfileVersion: 'common-mp4-v2' },
      { ...baselineInput, tool: { ...baselineInput.tool, ffmpegVersion: '8.0.2' } },
      { ...baselineInput, tool: { ...baselineInput.tool, encoder: 'h264_nvenc' } },
      {
        ...baselineInput,
        plan: {
          ...userPlan,
          destination: {
            destinationId: 'youtube',
            profileVersion: 'youtube-video-v1',
            recipe: { steps: [] },
          },
        },
      },
    ];

    expect(baseline.cacheKey).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(baseline.recipeHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      new Set(variants.map((variant) => createTransformCacheIdentity(variant).cacheKey)).size,
    ).toBe(variants.length);
    expect(
      variants.every(
        (variant) => createTransformCacheIdentity(variant).cacheKey !== baseline.cacheKey,
      ),
    ).toBe(true);
  });
});

describe('transform derivative schema', () => {
  it('persists provenance and prevents incomplete derivatives from claiming success', () => {
    const fixture = createTemporaryDatabase();
    try {
      const database = fixture.database.client;
      database
        .prepare(
          `INSERT INTO media_assets (
            id, path, fingerprint, size_bytes, modified_at, state, has_audio, created_at
          ) VALUES (?, ?, ?, ?, ?, 'available', 1, ?)`,
        )
        .run('source-media', 'C:\\Media\\clip.mp4', 'sha256:source-a', 100, 1, 1);

      const identity = createTransformCacheIdentity({
        sourceFingerprint: 'sha256:source-a',
        plan: userPlan,
        outputProfileVersion: 'common-mp4-v1',
        tool: { ffmpegVersion: '8.0.1', encoder: 'libx264' },
      });
      database
        .prepare(
          `INSERT INTO transform_derivatives (
            id, source_media_id, source_fingerprint, cache_key, recipe_hash,
            normalized_plan_json, output_profile_version, ffmpeg_version, encoder,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          'derivative-pending',
          'source-media',
          identity.sourceFingerprint,
          identity.cacheKey,
          identity.recipeHash,
          serializeNormalizedTransformPlan(identity.normalizedPlan),
          identity.outputProfileVersion,
          identity.tool.ffmpegVersion,
          identity.tool.encoder,
          1,
          1,
        );

      expect(
        database
          .prepare(
            `SELECT source_media_id, source_fingerprint, recipe_hash, output_profile_version,
                    ffmpeg_version, encoder, status
             FROM transform_derivatives WHERE id = ?`,
          )
          .get('derivative-pending'),
      ).toEqual({
        source_media_id: 'source-media',
        source_fingerprint: 'sha256:source-a',
        recipe_hash: identity.recipeHash,
        output_profile_version: 'common-mp4-v1',
        ffmpeg_version: '8.0.1',
        encoder: 'libx264',
        status: 'pending',
      });

      expect(() =>
        database
          .prepare(
            `INSERT INTO transform_derivatives (
              id, source_media_id, source_fingerprint, cache_key, recipe_hash,
              normalized_plan_json, output_profile_version, ffmpeg_version, encoder,
              status, created_at, updated_at, completed_at
            ) VALUES ('invalid-success', 'source-media', 'sha256:source-a', 'sha256:invalid',
              'sha256:recipe', '{}', 'common-mp4-v1', '8.0.1', 'libx264',
              'succeeded', 1, 1, 1)`,
          )
          .run(),
      ).toThrow();

      expect(() =>
        database
          .prepare(
            `INSERT INTO transform_derivatives (
              id, source_media_id, source_fingerprint, cache_key, recipe_hash,
              normalized_plan_json, output_profile_version, ffmpeg_version, encoder,
              status, output_path, output_size_bytes, output_duration_millis,
              output_video_codec, output_width, output_height, output_has_audio,
              created_at, updated_at, completed_at
            ) VALUES ('derivative-success', 'source-media', 'sha256:source-a',
              'sha256:success', 'sha256:recipe', '{}', 'common-mp4-v1', '8.0.1',
              'libx264', 'succeeded', '/managed/derived.mp4', 80, 60000,
              'h264', 1080, 1920, 0, 1, 2, 2)`,
          )
          .run(),
      ).not.toThrow();

      expect(() =>
        database
          .prepare(
            `UPDATE transform_derivatives SET output_path = 'partial.mp4'
             WHERE id = 'derivative-pending'`,
          )
          .run(),
      ).toThrow();
    } finally {
      fixture.dispose();
    }
  });
});
