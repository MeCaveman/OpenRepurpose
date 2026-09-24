import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

const repositoryRoot = resolve(import.meta.dirname, '..');
const arguments_ = process.argv.slice(2);
const outputFlag = arguments_.indexOf('--output-directory');
const archiveFlag = arguments_.indexOf('--node-runtime-archive');
const outputDirectory = resolve(
  outputFlag === -1 ? resolve(repositoryRoot, 'artifacts/linux-x64') : arguments_[outputFlag + 1],
);
const suppliedRuntimeArchive =
  archiveFlag === -1 ? undefined : resolve(arguments_[archiveFlag + 1] ?? '');

if (
  (outputFlag !== -1 && arguments_[outputFlag + 1] === undefined) ||
  (archiveFlag !== -1 && arguments_[archiveFlag + 1] === undefined)
) {
  throw new Error(
    'Usage: node scripts/package-linux.mjs [--output-directory <path>] [--node-runtime-archive <path>]',
  );
}
if (process.platform !== 'linux' || process.arch !== 'x64')
  throw new Error('Linux x64 artifacts must be built on a Linux x64 host.');
if (!existsSync('/usr/bin/tar') && !existsSync('/bin/tar'))
  throw new Error('GNU tar is required to create the Linux release artifact.');

const runtime = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'scripts/release/linux-runtime.json'), 'utf8'),
);
const pinnedNodeVersion = readFileSync(resolve(repositoryRoot, '.node-version'), 'utf8').trim();
if (runtime.nodeVersion !== pinnedNodeVersion)
  throw new Error('linux-runtime.json must match the Node version in .node-version.');

function assertOutsideRepository(path) {
  const repositoryFromPath = relative(path, repositoryRoot);
  if (repositoryFromPath === '' || !repositoryFromPath.startsWith('..'))
    throw new Error('OutputDirectory must not be the repository or an ancestor of it.');
}

function sha256(path) {
  const hash = createHash('sha256');
  const contents = readFileSync(path);
  hash.update(contents);
  return hash.digest('hex');
}

async function download(url, destination) {
  const response = await globalThis.fetch(url);
  if (!response.ok || response.body === null)
    throw new Error(
      `Could not download the Node runtime (${response.status} ${response.statusText}).`,
    );
  const output = createWriteStream(destination, { flags: 'wx' });
  await finished(Readable.fromWeb(response.body).pipe(output));
}

function copyDirectoryContents(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source))
    cpSync(resolve(source, entry), resolve(destination, entry), { recursive: true });
}

function checksums(directory, relativeDirectory = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);
    const artifactPath = `${relativeDirectory}${entry.name}`;
    if (entry.isDirectory()) return checksums(entryPath, `${artifactPath}/`);
    return entry.name === 'SHA256SUMS.txt' ? [] : [`${sha256(entryPath)}  ${artifactPath}`];
  });
}

assertOutsideRepository(outputDirectory);
rmSync(outputDirectory, { force: true, recursive: true });
mkdirSync(outputDirectory, { recursive: true });
const staging = resolve(outputDirectory, 'OpenRepurpose');
const app = resolve(staging, 'app');
const runtimeDirectory = resolve(staging, 'runtime');

execFileSync('corepack', ['pnpm', 'install', '--frozen-lockfile'], {
  cwd: repositoryRoot,
  stdio: 'inherit',
});
execFileSync('corepack', ['pnpm', 'build'], { cwd: repositoryRoot, stdio: 'inherit' });
execFileSync('corepack', ['pnpm', '--filter', '@openrepurpose/cli', 'deploy', '--prod', app], {
  cwd: repositoryRoot,
  stdio: 'inherit',
});
const materializedApp = `${app}-materialized`;
execFileSync(
  process.execPath,
  [resolve(repositoryRoot, 'scripts/materialize-package.mjs'), app, materializedApp],
  {
    cwd: repositoryRoot,
    stdio: 'inherit',
  },
);
rmSync(app, { force: true, recursive: true });
cpSync(materializedApp, app, { recursive: true });
rmSync(materializedApp, { force: true, recursive: true });

const webDistribution = resolve(repositoryRoot, 'apps/web/dist');
if (!existsSync(resolve(webDistribution, 'index.html')))
  throw new Error('The web production distribution is missing after build.');
copyDirectoryContents(webDistribution, resolve(app, 'node_modules/@openrepurpose/web/dist'));

cpSync(
  resolve(repositoryRoot, 'THIRD_PARTY_NOTICES.md'),
  resolve(staging, 'THIRD_PARTY_NOTICES.md'),
);
cpSync(resolve(repositoryRoot, 'LICENSE'), resolve(staging, 'LICENSE'));
copyDirectoryContents(resolve(repositoryRoot, 'docs'), resolve(staging, 'docs'));
for (const relativePath of ['README.md', 'SECURITY.md', 'CONTRIBUTING.md'])
  cpSync(resolve(repositoryRoot, relativePath), resolve(staging, relativePath));

const runtimeArchive = suppliedRuntimeArchive ?? resolve(outputDirectory, runtime.archiveName);
if (suppliedRuntimeArchive === undefined) await download(runtime.archiveUrl, runtimeArchive);
if (!existsSync(runtimeArchive))
  throw new Error(`Node runtime archive was not found: ${runtimeArchive}`);
if (sha256(runtimeArchive) !== runtime.sha256)
  throw new Error(
    'The Node runtime archive checksum does not match scripts/release/linux-runtime.json.',
  );

const runtimeExtract = resolve(outputDirectory, 'runtime-extract');
mkdirSync(runtimeExtract, { recursive: true });
execFileSync('tar', ['-xJf', runtimeArchive, '-C', runtimeExtract], { stdio: 'inherit' });
const runtimeSource = resolve(runtimeExtract, `node-v${runtime.nodeVersion}-linux-x64`);
if (!existsSync(resolve(runtimeSource, 'bin/node')))
  throw new Error(
    'The verified Node runtime archive does not contain bin/node at the expected path.',
  );
copyDirectoryContents(runtimeSource, runtimeDirectory);
rmSync(runtimeExtract, { force: true, recursive: true });
if (suppliedRuntimeArchive === undefined) rmSync(runtimeArchive, { force: true });

const launcher = `#!/bin/sh\nset -eu\nscript_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$script_dir/runtime/bin/node" "$script_dir/app/dist/index.js" "$@"\n`;
writeFileSync(resolve(staging, 'openrepurpose'), launcher, { encoding: 'utf8', mode: 0o755 });
chmodSync(resolve(staging, 'openrepurpose'), 0o755);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).trim();
writeFileSync(
  resolve(staging, 'build-metadata.json'),
  `${JSON.stringify(
    {
      artifactFormat: 'openrepurpose-linux-portable-v1',
      nodeRuntime: { version: runtime.nodeVersion, archiveSha256: runtime.sha256 },
      packageManager: 'pnpm 12.4.2',
      platform: runtime.platform,
      sourceCommit: commit,
    },
    null,
    2,
  )}\n`,
);
writeFileSync(resolve(staging, 'SHA256SUMS.txt'), `${checksums(staging).sort().join('\n')}\n`);
execFileSync(
  'tar',
  [
    '--sort=name',
    '--mtime=@0',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '-cJf',
    resolve(outputDirectory, 'OpenRepurpose-linux-x64.tar.xz'),
    '-C',
    outputDirectory,
    'OpenRepurpose',
  ],
  { stdio: 'inherit' },
);
