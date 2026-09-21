import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compileWhisperCppCommand,
  discoverWhisperCppExecutable,
  LocalWhisperCppInstallationStore,
  LocalWhisperCppModelLocator,
  parseWhisperCppOutput,
  resolveWhisperCppPaths,
  WhisperCppProcessRunner,
  WhisperCppProgressParser,
  WhisperCppTranscriptionProvider,
} from '@openrepurpose/media';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-whisper-cpp-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
});

const request = {
  audioPath: 'C:\\Media Files\\مقطع;not-a-command.wav',
  language: 'ar',
  model: { id: 'ggml-base', version: 'v1' },
  options: {
    beamSize: 5,
    maxSegmentLength: 80,
    noGpu: true,
    splitOnWord: true,
    temperature: 0.2,
    threads: 4,
    translate: true,
  },
};

describe('whisper.cpp command and output boundaries', () => {
  it('compiles paths and supported options as individual argv entries', () => {
    const command = compileWhisperCppCommand({
      executable: 'C:\\Tools\\whisper-cli.exe',
      modelPath: 'C:\\Models\\ggml base;safe.bin',
      outputPrefix: 'C:\\Output Files\\transcript',
      request,
    });

    expect(command.executable).toBe('C:\\Tools\\whisper-cli.exe');
    expect(command.args).toContain(request.audioPath);
    expect(command.args).toContain('C:\\Models\\ggml base;safe.bin');
    expect(command.args).toContain('--output-json');
    expect(command.args).toContain('--print-progress');
    expect(command.args).toContain('--translate');
    expect(
      command.args.slice(command.args.indexOf('--threads'), command.args.indexOf('--threads') + 2),
    ).toEqual(['--threads', '4']);
    expect(command.outputJsonPath).toBe('C:\\Output Files\\transcript.json');
    expect(() =>
      compileWhisperCppCommand({
        executable: 'whisper-cli',
        modelPath: 'C:\\Models\\model.bin',
        outputPrefix: 'C:\\Output\\transcript',
        request: { ...request, options: { rawArguments: '--help' } },
      }),
    ).toThrow('Unsupported whisper.cpp option');
  });

  it('parses UTF-8 segment JSON and rejects invalid timings', () => {
    expect(
      parseWhisperCppOutput(
        JSON.stringify({
          result: { language: 'ar' },
          transcription: [
            { offsets: { from: 0, to: 1_200 }, text: ' مرحباً بالعالم ' },
            { offsets: { from: 1_200, to: 2_000 }, text: 'Hello 世界' },
          ],
        }),
      ),
    ).toEqual({
      cues: [
        { startMs: 0, endMs: 1_200, text: 'مرحباً بالعالم' },
        { startMs: 1_200, endMs: 2_000, text: 'Hello 世界' },
      ],
      detectedLanguage: 'ar',
    });
    expect(() =>
      parseWhisperCppOutput(
        JSON.stringify({ transcription: [{ offsets: { from: 10, to: 5 }, text: 'bad' }] }),
      ),
    ).toThrow('invalid transcript cue');
  });

  it('parses chunked, monotonic progress from whisper.cpp diagnostics', () => {
    const progress: number[] = [];
    const parser = new WhisperCppProgressParser((snapshot) => progress.push(snapshot.percent));
    parser.push('whisper_print_progress_callback: progress =  1');
    parser.push('0%\rwhisper_print_progress_callback: progress =  50%\n');
    parser.push('progress = 50%\rprogress = 100%');
    parser.finish();
    expect(progress).toEqual([10, 50, 100]);
  });
});

describe('whisper.cpp managed discovery and model layout', () => {
  it('uses deterministic data, installation, and model locations', async () => {
    const dataDirectory = temporaryDirectory();
    const paths = resolveWhisperCppPaths(dataDirectory);
    expect(paths).toEqual({
      installationRoot: join(dataDirectory, 'tools', 'whisper-cpp'),
      modelRoot: join(dataDirectory, 'models', 'whisper-cpp'),
    });
    const locator = new LocalWhisperCppModelLocator(paths.modelRoot);
    const model = { id: 'ggml-base.en', version: 'v1.9.4' };
    const modelPath = locator.pathFor(model);
    expect(modelPath).toBe(join(paths.modelRoot, 'ggml-base.en', 'v1.9.4', 'ggml-model.bin'));
    await expect(locator.locate(model)).rejects.toMatchObject({
      code: 'WHISPER_CPP_MODEL_NOT_FOUND',
    });
    mkdirSync(join(paths.modelRoot, 'ggml-base.en', 'v1.9.4'), { recursive: true });
    writeFileSync(modelPath, 'model');
    await expect(locator.locate(model)).resolves.toBe(modelPath);
    expect(() => locator.pathFor({ id: '../escape', version: 'v1' })).toThrow('safe identifier');
  });

  it('adopts a prepared distribution and discovers the activated version', async () => {
    const directory = temporaryDirectory();
    const sourceDirectory = join(directory, 'prepared');
    const installationRoot = join(directory, 'managed');
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(join(sourceDirectory, 'whisper-cli'), 'prepared binary');
    writeFileSync(join(sourceDirectory, 'libwhisper.so'), 'runtime library');
    const probe = async (path: string) =>
      path.endsWith('whisper-cli') ? 'whisper.cpp v1.9.4' : undefined;
    const store = new LocalWhisperCppInstallationStore(installationRoot, {
      architecture: 'x64',
      platform: 'linux',
      probe,
    });

    const installed = await store.install({ sourceDirectory, version: 'v1.9.4' });
    expect(installed).toMatchObject({ source: 'managed', version: 'whisper.cpp v1.9.4' });
    const discovered = await discoverWhisperCppExecutable({
      architecture: 'x64',
      environment: { PATH: '' },
      managedInstallationRoot: installationRoot,
      platform: 'linux',
      probe,
    });
    expect(discovered).toMatchObject({
      path: installed.path,
      source: 'managed',
      version: 'v1.9.4',
    });
  });

  it('prefers explicit configuration over managed and PATH candidates', async () => {
    const checked: string[] = [];
    const discovered = await discoverWhisperCppExecutable({
      configuredExecutable: 'C:\\Custom\\whisper-cli.exe',
      environment: { PATH: 'C:\\Path Tools' },
      platform: 'win32',
      probe: async (path) => {
        checked.push(path);
        return path.includes('Custom') ? 'configured build' : undefined;
      },
    });
    expect(discovered).toMatchObject({
      path: 'C:\\Custom\\whisper-cli.exe',
      source: 'configured',
      version: 'configured build',
    });
    expect(checked).toEqual(['C:\\Custom\\whisper-cli.exe']);
  });
});

describe('whisper.cpp provider process lifecycle', () => {
  it('runs the provider end to end, reports progress, and removes sidecar output', async () => {
    const directory = temporaryDirectory();
    const modelRoot = join(directory, 'models');
    const temporaryRoot = join(directory, 'temp');
    const audioPath = join(directory, 'audio with spaces.wav');
    const model = { id: 'ggml-base', version: 'v1' };
    const locator = new LocalWhisperCppModelLocator(modelRoot);
    const modelPath = locator.pathFor(model);
    mkdirSync(join(modelRoot, model.id, model.version), { recursive: true });
    writeFileSync(modelPath, 'model');
    writeFileSync(audioPath, 'wav');
    const scriptPath = join(directory, 'fake-whisper.mjs');
    writeFileSync(
      scriptPath,
      `import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-file') + 1] + '.json';
process.stderr.write('whisper_print_progress_callback: progress =  25%\\r');
writeFileSync(output, JSON.stringify({ result: { language: 'ar' }, transcription: [{ offsets: { from: 0, to: 900 }, text: ' أهلاً' }] }));
process.stdout.write('whisper_print_progress_callback: progress = 100%\\n');
`,
    );
    const provider = new WhisperCppTranscriptionProvider({
      executable: {
        argsPrefix: [scriptPath],
        path: process.execPath,
        source: 'configured',
        version: process.version,
      },
      modelLocator: locator,
      temporaryDirectory: temporaryRoot,
    });
    const progress: number[] = [];

    await expect(
      provider.transcribe(
        { audioPath, language: 'ar', model, options: {} },
        {
          signal: new AbortController().signal,
          onProgress: (snapshot) => progress.push(snapshot.percent),
        },
      ),
    ).resolves.toEqual({
      cues: [{ startMs: 0, endMs: 900, text: 'أهلاً' }],
      detectedLanguage: 'ar',
    });
    expect(progress).toEqual([25, 100]);
  });

  it('cancels a live child and bounds application shutdown', async () => {
    const directory = temporaryDirectory();
    const scriptPath = join(directory, 'hang.mjs');
    writeFileSync(scriptPath, 'setInterval(() => {}, 1000);');
    const runner = new WhisperCppProcessRunner({ killGraceMs: 20, timeoutMs: 2_000 });
    const controller = new AbortController();
    const running = runner.run(
      {
        executable: process.execPath,
        args: [scriptPath],
        outputJsonPath: join(directory, 'unused.json'),
      },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 30);
    await expect(running).rejects.toMatchObject({ code: 'WHISPER_CPP_CANCELLED' });
    await runner.stop();
  });
});
