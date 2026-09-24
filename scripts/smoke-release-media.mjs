import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const installationRootArgument = process.argv[2];
if (installationRootArgument === undefined)
  throw new Error('Usage: node scripts/smoke-release-media.mjs <artifact-installation-root>');

const installationRoot = resolve(installationRootArgument);
const mediaEntry = resolve(
  installationRoot,
  'app',
  'node_modules',
  '@openrepurpose',
  'media',
  'dist',
  'index.js',
);
const { compileTransformCommand, FfprobeMediaProbe } = await import(pathToFileURL(mediaEntry).href);

function run(executable, arguments_) {
  const result = spawnSync(executable, arguments_, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0)
    throw new Error(
      `${executable} release smoke failed (${result.status ?? 'no exit code'}): ${result.stderr.slice(-1_000)}`,
    );
}

const directory = await mkdtemp(join(tmpdir(), 'openrepurpose-release-media-'));
try {
  const sourceDirectory = join(directory, 'source folder – مسار');
  const outputDirectory = join(directory, 'output folder – نتائج');
  await Promise.all([
    mkdir(sourceDirectory, { recursive: true }),
    mkdir(outputDirectory, { recursive: true }),
  ]);
  const source = join(sourceDirectory, 'tiny source.mp4');
  const subtitle = join(sourceDirectory, 'captions مرحبا.srt');
  const output = join(outputDirectory, 'burned.mp4');

  run('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=160x120:rate=24',
    '-t',
    '1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    source,
  ]);
  await writeFile(subtitle, '1\n00:00:00,000 --> 00:00:00,800\nHello مرحبا\n', 'utf8');

  const command = compileTransformCommand({
    inputPath: source,
    outputPath: output,
    sourceHasAudio: false,
    captionPaths: { transcript: subtitle },
    plan: {
      user: {
        steps: [
          {
            type: 'captions',
            source: 'transcript',
            revision: 0,
            mode: 'burn-in',
            subtitle: 'release-candidate-snapshot',
          },
        ],
        output: { crf: 32, preset: 'ultrafast' },
      },
    },
  });
  run(command.executable, command.args);

  const metadata = await new FfprobeMediaProbe('ffprobe').probe(output);
  if (metadata.videoCodec !== 'h264' || metadata.width !== 160 || metadata.height !== 120)
    throw new Error('Packaged media code produced an invalid subtitle derivative.');
  process.stdout.write('Packaged FFmpeg/subtitle smoke passed.\n');
} finally {
  await rm(directory, { force: true, recursive: true });
}
