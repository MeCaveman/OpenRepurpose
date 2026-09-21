import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTranscriptionCacheIdentity,
  transcriptCueSchema,
  TranscriptionProviderRegistry,
  type TranscriptionProvider,
} from '../../packages/core/src/index.js';
import {
  migrations,
  openDatabase,
  runMigrations,
  SqliteMediaRepository,
  SqliteTranscriptRepository,
} from '../../packages/db/src/index.js';
import { createTemporaryDatabase } from '../../packages/testkit/src/index.js';

const identityInput = {
  sourceAudioFingerprint: 'sha256:audio-a',
  providerId: 'whisper-cpp',
  model: { id: 'ggml-base.en', version: '2026-09-21' },
  language: 'en',
  options: { temperature: 0, translate: false },
};

const cue = {
  startMs: 0,
  endMs: 1_200,
  text: 'Hello world',
  words: [
    { startMs: 0, endMs: 500, text: 'Hello' },
    { startMs: 600, endMs: 1_200, text: 'world' },
  ],
};

describe('transcription provider contract', () => {
  it('registers providers without provider-specific core switches', () => {
    const provider: TranscriptionProvider = {
      id: 'whisper-cpp',
      displayName: 'whisper.cpp',
      capabilities: async () => ({ cancellation: true, wordTimestamps: true }),
      transcribe: async () => ({ cues: [cue] }),
    };
    const registry = new TranscriptionProviderRegistry([provider]);
    const unregister = registry.register({ ...provider, id: 'future-local' });

    expect(registry.list()).toEqual([provider, expect.objectContaining({ id: 'future-local' })]);
    expect(registry.require('whisper-cpp')).toBe(provider);
    expect(() => registry.register(provider)).toThrow('Duplicate transcription provider');
    unregister();
    expect(registry.get('future-local')).toBeUndefined();
    expect(() => registry.require('missing')).toThrow('Unknown transcription provider: missing');
  });

  it('validates cue timing and creates canonical cache identities', () => {
    expect(
      transcriptCueSchema.safeParse({ ...cue, words: [{ startMs: 0, endMs: 1_500, text: 'bad' }] })
        .success,
    ).toBe(false);
    const baseline = createTranscriptionCacheIdentity(identityInput);
    const reordered = createTranscriptionCacheIdentity({
      ...identityInput,
      options: { translate: false, temperature: 0 },
    });
    const variants = [
      { ...identityInput, sourceAudioFingerprint: 'sha256:audio-b' },
      { ...identityInput, providerId: 'another-local-provider' },
      { ...identityInput, model: { ...identityInput.model, version: 'newer' } },
      { ...identityInput, language: 'es' },
      { ...identityInput, options: { ...identityInput.options, temperature: 0.2 } },
    ];

    expect(baseline.cacheKey).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(reordered.cacheKey).toBe(baseline.cacheKey);
    expect(
      variants.every(
        (variant) => createTranscriptionCacheIdentity(variant).cacheKey !== baseline.cacheKey,
      ),
    ).toBe(true);
  });
});

describe('transcript persistence', () => {
  it('migrates a v0.6 database without rewriting its migration ledger', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-v06-transcript-'));
    const database = openDatabase(join(directory, 'openrepurpose.sqlite'));
    try {
      runMigrations(database, migrations.slice(0, 20));
      runMigrations(database);
      expect(
        database.client
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transcripts'")
          .get(),
      ).toEqual({ name: 'transcripts' });
      expect(
        database.client.prepare('SELECT id FROM __openrepurpose_migrations ORDER BY id DESC').get(),
      ).toEqual({ id: '0021_transcripts' });
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('atomically reuses cache entries and preserves user edits from regeneration', () => {
    const fixture = createTemporaryDatabase();
    try {
      new SqliteMediaRepository(fixture.database).create({
        id: 'media-transcript',
        path: 'C:\\Media\\clip.mp4',
        fingerprint: 'sha256:media',
        sizeBytes: 100,
        modifiedAt: new Date(0),
        state: 'available',
        createdAt: new Date(0),
        metadata: { hasAudio: true },
      });
      const repository = new SqliteTranscriptRepository(fixture.database);
      const identity = createTranscriptionCacheIdentity(identityInput);
      const first = repository.reserve({
        id: 'transcript-a',
        identity,
        now: new Date(1),
        source: { kind: 'media', mediaId: 'media-transcript' },
      });
      const reused = repository.reserve({
        id: 'ignored-on-cache-hit',
        identity,
        now: new Date(2),
        source: { kind: 'media', mediaId: 'media-transcript' },
      });
      expect(first.created).toBe(true);
      expect(reused).toMatchObject({ created: false, transcript: { id: 'transcript-a' } });

      const generated = repository.replaceGeneratedCues('transcript-a', [cue], new Date(3));
      expect(generated).toMatchObject({ generatedAt: new Date(3), revision: 1, cues: [cue] });
      const edited = repository.updateCue(
        'transcript-a',
        0,
        { ...cue, text: 'Edited transcript' },
        new Date(4),
      );
      expect(edited).toMatchObject({
        hasUserEdits: true,
        revision: 2,
        cues: [{ text: 'Edited transcript' }],
      });
      expect(() => repository.replaceGeneratedCues('transcript-a', [cue], new Date(5))).toThrow(
        'cannot overwrite a user-edited',
      );
      expect(repository.findById('transcript-a')?.cues[0]?.text).toBe('Edited transcript');
    } finally {
      fixture.dispose();
    }
  });

  it('enforces a single durable media or derivative source', () => {
    const fixture = createTemporaryDatabase();
    try {
      expect(() =>
        fixture.database.client
          .prepare(
            `INSERT INTO transcripts (
              id, source_audio_fingerprint, cache_key, provider_id, model_id, model_version,
              options_json, created_at, updated_at
            ) VALUES ('invalid-source', 'sha256:a', 'sha256:b', 'test', 'model', 'v1', '{}', 1, 1)`,
          )
          .run(),
      ).toThrow();
    } finally {
      fixture.dispose();
    }
  });
});
