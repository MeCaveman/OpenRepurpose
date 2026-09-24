import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import process from 'node:process';

const repositoryRoot = resolve(import.meta.dirname, '..');
const releaseDirectory = resolve(repositoryRoot, process.argv[2] ?? 'artifacts/release');
if (!existsSync(releaseDirectory))
  throw new Error(`Release artifact directory does not exist: ${releaseDirectory}`);

const artifacts = readdirSync(releaseDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(zip|tar\.xz)$/u.test(entry.name))
  .map((entry) => resolve(releaseDirectory, entry.name))
  .sort();
if (artifacts.length === 0)
  throw new Error('Release artifact directory contains no Windows ZIP or Linux tar.xz artifact.');

const checksums = artifacts.map((artifact) => {
  const checksum = createHash('sha256').update(readFileSync(artifact)).digest('hex');
  const line = `${checksum}  ${basename(artifact)}`;
  writeFileSync(`${artifact}.sha256`, `${line}\n`, { encoding: 'utf8' });
  return line;
});
writeFileSync(resolve(releaseDirectory, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`, {
  encoding: 'utf8',
});
process.stdout.write(
  `Wrote SHA-256 verification files for ${artifacts.length} release artifact(s).\n`,
);
