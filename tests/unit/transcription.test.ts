import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCaptionRenderStep,
  createTranscriptionCacheIdentity,
  exportSubtitle,
  transcriptCueSchema,
  TranscriptService,
  TranscriptServiceError,
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
import { createCli } from '../../apps/cli/src/index.js';
import type { Environment } from '../../packages/shared/src/index.js';

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

it('snapshots a transcript as SRT for deterministic caption rendering', () => {
  const step = createCaptionRenderStep(
    {
      id: 'transcript-caption',
      revision: 3,
      cues: [cue],
      cacheKey: 'sha256:c',
      createdAt: new Date(0),
      updatedAt: new Date(0),
      hasUserEdits: true,
      model: { id: 'base', version: '1' },
      options: {},
      providerId: 'local',
      source: { kind: 'media', mediaId: 'media-1' },
      sourceAudioFingerprint: 'sha256:audio',
    },
    'sidecar',
  );
  expect(step).toMatchObject({ source: 'transcript-caption', revision: 3, mode: 'sidecar' });
  expect(step.subtitle).toContain('00:00:00,000 --> 00:00:01,200');
});

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

  it('exports deterministic SRT and WebVTT with UTF-8 text and chronological cues', () => {
    const cues = [
      { startMs: 0, endMs: 1_250, text: 'Hello\r\nworld' },
      { startMs: 3_661_001, endMs: 3_662_005, text: 'أهلاً بالعالم' },
    ];

    expect(exportSubtitle(cues, 'srt')).toBe(
      '1\n00:00:00,000 --> 00:00:01,250\nHello\nworld\n\n' +
        '2\n01:01:01,001 --> 01:01:02,005\nأهلاً بالعالم\n',
    );
    expect(exportSubtitle(cues, 'vtt')).toBe(
      'WEBVTT\n\n' +
        '00:00:00.000 --> 00:00:01.250\nHello\nworld\n\n' +
        '01:01:01.001 --> 01:01:02.005\nأهلاً بالعالم\n',
    );
    expect(() =>
      exportSubtitle(
        [
          { startMs: 2_000, endMs: 3_000, text: 'Later' },
          { startMs: 1_000, endMs: 1_500, text: 'Earlier' },
        ],
        'vtt',
      ),
    ).toThrow('chronological order');
    expect(() =>
      exportSubtitle([{ startMs: 500, endMs: 500, text: 'zero duration' }], 'srt'),
    ).toThrow('cue endMs must be greater than startMs');
    expect(() =>
      exportSubtitle(
        [
          {
            startMs: 0,
            endMs: 1_000,
            text: 'word outside cue',
            words: [{ startMs: 0, endMs: 1_001, text: 'outside' }],
          },
        ],
        'vtt',
      ),
    ).toThrow('word timestamps must stay within their cue');
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
      ).toEqual({ id: '0024_kick_oauth' });
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
      expect(repository.listByMediaId('media-transcript').map((item) => item.id)).toEqual([
        'transcript-a',
      ]);
    } finally {
      fixture.dispose();
    }
  });

  it('saves an edited cue set atomically and rejects stale revisions', () => {
    const fixture = createTemporaryDatabase();
    try {
      new SqliteMediaRepository(fixture.database).create({
        id: 'media-edit',
        path: '/media/edit.mp4',
        fingerprint: 'sha256:edit',
        sizeBytes: 100,
        modifiedAt: new Date(0),
        state: 'available',
        createdAt: new Date(0),
        metadata: { hasAudio: true },
      });
      const repository = new SqliteTranscriptRepository(fixture.database);
      repository.reserve({
        id: 'transcript-edit',
        identity: createTranscriptionCacheIdentity({
          ...identityInput,
          sourceAudioFingerprint: 'sha256:edit',
        }),
        now: new Date(1),
        source: { kind: 'media', mediaId: 'media-edit' },
      });
      const generated = repository.replaceGeneratedCues('transcript-edit', [cue], new Date(2));
      const service = new TranscriptService(repository, () => new Date(3));
      const edited = service.save('transcript-edit', {
        expectedRevision: generated.revision,
        cues: [{ startMs: 100, endMs: 1_300, text: 'User-edited text' }],
      });

      expect(edited).toMatchObject({
        hasUserEdits: true,
        revision: 2,
        updatedAt: new Date(3),
        cues: [{ startMs: 100, endMs: 1_300, text: 'User-edited text' }],
      });
      expect(edited.cues[0]).not.toHaveProperty('words');
      expect(() =>
        service.save('transcript-edit', {
          expectedRevision: generated.revision,
          cues: [{ startMs: 0, endMs: 1_000, text: 'Stale edit' }],
        }),
      ).toThrowError(TranscriptServiceError);
      expect(repository.findById('transcript-edit')?.cues[0]?.text).toBe('User-edited text');
    } finally {
      fixture.dispose();
    }
  });

  it('reloads user edits after the database is closed and reopened', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-transcript-restart-'));
    const databasePath = join(directory, 'openrepurpose.sqlite');
    let database: ReturnType<typeof openDatabase> | undefined = openDatabase(databasePath);
    try {
      runMigrations(database);
      new SqliteMediaRepository(database).create({
        id: 'media-restart',
        path: '/media/restart.mp4',
        fingerprint: 'sha256:restart-media',
        sizeBytes: 100,
        modifiedAt: new Date(0),
        state: 'available',
        createdAt: new Date(0),
        metadata: { hasAudio: true },
      });
      const repository = new SqliteTranscriptRepository(database);
      repository.reserve({
        id: 'transcript-restart',
        identity: createTranscriptionCacheIdentity({
          ...identityInput,
          sourceAudioFingerprint: 'sha256:restart-audio',
        }),
        now: new Date(1),
        source: { kind: 'media', mediaId: 'media-restart' },
      });
      const generated = repository.replaceGeneratedCues('transcript-restart', [cue], new Date(2));
      new TranscriptService(repository, () => new Date(3)).save('transcript-restart', {
        expectedRevision: generated.revision,
        cues: [{ startMs: 50, endMs: 1_250, text: 'Persist after restart' }],
      });
      database.close();
      database = undefined;

      database = openDatabase(databasePath);
      runMigrations(database);
      expect(new SqliteTranscriptRepository(database).findById('transcript-restart')).toMatchObject(
        {
          hasUserEdits: true,
          revision: 2,
          cues: [{ startMs: 50, endMs: 1_250, text: 'Persist after restart' }],
        },
      );
    } finally {
      database?.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('shows and exports a transcript through the CLI shared service path', async () => {
    const fixture = createTemporaryDatabase();
    try {
      new SqliteMediaRepository(fixture.database).create({
        id: 'media-cli-transcript',
        path: '/media/cli.mp4',
        fingerprint: 'sha256:cli-media',
        sizeBytes: 100,
        modifiedAt: new Date(0),
        state: 'available',
        createdAt: new Date(0),
        metadata: { hasAudio: true },
      });
      const repository = new SqliteTranscriptRepository(fixture.database);
      repository.reserve({
        id: 'transcript-cli',
        identity: createTranscriptionCacheIdentity({
          ...identityInput,
          sourceAudioFingerprint: 'sha256:cli-audio',
        }),
        now: new Date(1),
        source: { kind: 'media', mediaId: 'media-cli-transcript' },
      });
      repository.replaceGeneratedCues(
        'transcript-cli',
        [{ startMs: 0, endMs: 750, text: 'CLI caption' }],
        new Date(2),
      );
      const environment: Environment = {
        APP_CONFIG_DIR: join(fixture.directory, 'config'),
        APP_DATA_DIR: fixture.directory,
        APP_TEMP_DIR: join(fixture.directory, 'temp'),
        DATABASE_URL: join(fixture.directory, 'openrepurpose.sqlite'),
      };
      const output: string[] = [];

      await createCli({ environment, write: (value) => output.push(value) }).parseAsync([
        'node',
        'openrepurpose',
        'transcript',
        'show',
        'transcript-cli',
        '--json',
      ]);
      expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({
        id: 'transcript-cli',
        cues: [{ text: 'CLI caption' }],
      });
      output.length = 0;
      await createCli({ environment, write: (value) => output.push(value) }).parseAsync([
        'node',
        'openrepurpose',
        'transcript',
        'export',
        'transcript-cli',
        '--format',
        'srt',
      ]);
      expect(output.join('')).toBe('1\n00:00:00,000 --> 00:00:00,750\nCLI caption\n');
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
