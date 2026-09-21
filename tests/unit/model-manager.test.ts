import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { createCli } from '../../apps/cli/src/index.js';
import {
  LocalWhisperModelManager,
  type TranscriptionModelManager,
  type WhisperModelCatalogEntry,
  type WhisperModelManagerView,
  type WhisperModelView,
} from '../../packages/media/src/index.js';

const payload = new TextEncoder().encode('small deterministic model fixture');
const checksum = createHash('sha1').update(payload).digest('hex');
const catalog: readonly WhisperModelCatalogEntry[] = [
  {
    checksum: { algorithm: 'sha1', value: checksum },
    description: 'Fixture model',
    displayName: 'Fixture model',
    id: 'fixture',
    languageSupport: 'multilingual',
    performance: 'fast',
    sizeBytes: payload.byteLength,
    sourceUrl: 'https://models.example.test/fixture.bin',
    version: `sha1-${checksum.slice(0, 12)}`,
  },
];

describe('local whisper model manager', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  async function directory() {
    const value = await mkdtemp(join(tmpdir(), 'openrepurpose-models-'));
    directories.push(value);
    return value;
  }

  it('lists catalog metadata without starting a download', async () => {
    let requests = 0;
    const manager = new LocalWhisperModelManager(catalog, await directory(), {
      diskReserveBytes: 0,
      fetcher: async () => {
        requests += 1;
        return new Response(payload);
      },
      freeSpace: async () => 10_000,
    });

    const snapshot = await manager.list();

    expect(requests).toBe(0);
    expect(snapshot.models[0]).toMatchObject({
      id: 'fixture',
      languageSupport: 'multilingual',
      status: 'not-installed',
      integrity: 'not-installed',
    });
  });

  it('downloads atomically, reports progress, verifies the checksum, and deletes safely', async () => {
    const root = await directory();
    const progress: number[] = [];
    const manager = new LocalWhisperModelManager(catalog, root, {
      diskReserveBytes: 0,
      fetcher: async () =>
        new Response(payload, { headers: { 'content-length': String(payload.byteLength) } }),
      freeSpace: async () => 10_000,
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });

    const installed = await manager.download('fixture', {
      onProgress: (value) => progress.push(value.percent ?? 0),
    });
    const modelPath = join(root, 'fixture', catalog[0]!.version, 'ggml-model.bin');

    expect(installed).toMatchObject({ status: 'installed', integrity: 'verified' });
    expect(progress.at(-1)).toBe(100);
    expect(new Uint8Array(await readFile(modelPath))).toEqual(payload);
    await expect(manager.verify('fixture')).resolves.toMatchObject({ integrity: 'verified' });
    await expect(manager.delete('fixture')).resolves.toMatchObject({ status: 'not-installed' });
    expect(existsSync(modelPath)).toBe(false);
  });

  it('removes partial bytes when the authoritative checksum does not match', async () => {
    const root = await directory();
    const corruptCatalog = [
      { ...catalog[0]!, checksum: { algorithm: 'sha1' as const, value: '0'.repeat(40) } },
    ];
    const manager = new LocalWhisperModelManager(corruptCatalog, root, {
      diskReserveBytes: 0,
      fetcher: async () => new Response(payload),
      freeSpace: async () => 10_000,
    });

    await expect(manager.download('fixture')).rejects.toMatchObject({
      code: 'MODEL_CHECKSUM_MISMATCH',
    });
    const target = join(root, 'fixture', corruptCatalog[0]!.version, 'ggml-model.bin');
    expect(existsSync(target)).toBe(false);
    expect((await manager.list()).models[0]).toMatchObject({
      status: 'failed',
      integrity: 'failed',
    });
  });

  it('reports an already-installed corrupt model during explicit verification', async () => {
    const root = await directory();
    const manager = new LocalWhisperModelManager(catalog, root, {
      diskReserveBytes: 0,
      freeSpace: async () => 10_000,
    });
    const modelDirectory = join(root, 'fixture', catalog[0]!.version);
    await mkdir(modelDirectory, { recursive: true });
    await writeFile(join(modelDirectory, 'ggml-model.bin'), 'corrupt model bytes');

    await expect(manager.verify('fixture')).rejects.toMatchObject({
      code: 'MODEL_CHECKSUM_MISMATCH',
    });
    expect((await manager.list()).models[0]).toMatchObject({
      status: 'installed',
      integrity: 'unverified',
    });
  });

  it('blocks the transfer before network access when free space is below the preflight', async () => {
    let requests = 0;
    const manager = new LocalWhisperModelManager(catalog, await directory(), {
      diskReserveBytes: 100,
      fetcher: async () => {
        requests += 1;
        return new Response(payload);
      },
      freeSpace: async () => payload.byteLength,
    });

    await expect(manager.download('fixture')).rejects.toEqual(
      expect.objectContaining({ code: 'MODEL_DISK_SPACE_LOW' }),
    );
    expect(requests).toBe(0);
  });

  it('refuses to treat an unknown model ID as a download URL or path', async () => {
    const manager = new LocalWhisperModelManager(catalog, await directory(), {
      diskReserveBytes: 0,
      freeSpace: async () => 10_000,
    });

    await expect(manager.download('../../outside')).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
    });
  });
});

describe('model manager CLI', () => {
  function model(status: WhisperModelView['status']): WhisperModelView {
    return {
      ...catalog[0]!,
      diskRequiredBytes: payload.byteLength,
      diskWarning: false,
      integrity: status === 'installed' ? 'verified' : 'not-installed',
      status,
    };
  }

  it('shares list, download, verify, and delete operations through the injected service', async () => {
    const calls: string[] = [];
    const snapshot: WhisperModelManagerView = {
      availableBytes: 10_000,
      models: [model('not-installed')],
      reserveBytes: 0,
      storagePath: '/models',
    };
    const manager: TranscriptionModelManager = {
      list: async () => {
        calls.push('list');
        return snapshot;
      },
      startDownload: async () => model('downloading'),
      download: async (id, options) => {
        calls.push(`download:${id}`);
        options?.onProgress?.({
          downloadedBytes: payload.byteLength,
          percent: 100,
          totalBytes: payload.byteLength,
        });
        return model('installed');
      },
      verify: async (id) => {
        calls.push(`verify:${id}`);
        return model('installed');
      },
      delete: async (id) => {
        calls.push(`delete:${id}`);
        return model('not-installed');
      },
    };
    const output: string[] = [];
    const program = () =>
      createCli({ modelManager: manager, write: (value) => output.push(value) });

    await program().parseAsync(['node', 'openrepurpose', 'models', 'list', '--json']);
    await program().parseAsync([
      'node',
      'openrepurpose',
      'models',
      'download',
      'fixture',
      '--json',
    ]);
    await program().parseAsync(['node', 'openrepurpose', 'models', 'verify', 'fixture']);
    await program().parseAsync(['node', 'openrepurpose', 'models', 'delete', 'fixture']);

    expect(calls).toEqual(['list', 'download:fixture', 'verify:fixture', 'delete:fixture']);
    expect(output.join('')).toContain('"storagePath":"/models"');
    expect(output.join('')).toContain('fixture\tinstalled\tverified');
    expect(output.join('')).toContain('fixture\tnot-installed');
  });
});
